/**
 * Motor de la tramitación: a partir de las tareas de un expediente calcula sus plazos, qué
 * está bloqueado, el siguiente paso, cuántos días lleva sin avanzar y su salud. Es código
 * puro, sin base de datos, para poder probarlo regla a regla.
 *
 * No calcula una fecha prevista de cierre: casi todo el tiempo de un siniestro es esperar
 * a terceros, y esa fecha sería inventada.
 */
import {
  addBusinessDays,
  addCalendarDays,
  businessDaysUntil,
  dayOf,
  daysBetween,
  type Day,
} from "./days.ts";

export type TaskStatus = "pendiente" | "en_curso" | "esperando" | "hecha" | "omitida";
export type DueAnchor = "apertura" | "siniestro" | "lista";
export type DueUnit = "naturales" | "habiles";

export type EngineTask = {
  id: string;
  phaseId: string;
  position: number;
  name: string;
  status: TaskStatus;
  assigneeId: string | null;
  /** A quién se espera, en palabras («Peritaciones Norte», «el cliente»). */
  waitingOn: string | null;
  waitingSince: Day | null;
  chaseAt: Day | null;
  dueAnchor: DueAnchor;
  dueDays: number | null;
  dueUnit: DueUnit;
  dueOverride: Day | null;
  legalRef: string | null;
  doneAt: Day | null;
  /** El correo del expediente que demuestra que se hizo. */
  evidenceMessageId: string | null;
  /** Ids de las tareas de las que depende. */
  dependsOn: string[];
};

export type EnginePhase = { id: string; position: number; name: string };
export type EngineCase = { openedAt: Day; lossDate: Day | null; status: "abierto" | "cerrado" };
export type EventKind =
  | "creada"
  | "estado"
  | "asignada"
  | "plazo"
  | "espera"
  | "reclamada"
  | "nota"
  | "prueba"
  | "cierre";
export type EngineEvent = { at: Day; kind: EventKind };

export type DerivedState = "hecha" | "omitida" | "bloqueada" | "esperando" | "en_curso" | "lista";

export type DerivedTask = EngineTask & {
  state: DerivedState;
  /** Nombres de las tareas que faltan para poder empezar. */
  blockers: string[];
  due: Day | null;
  /** Días que lleva vencida (0 si no lo está). */
  lateDays: number;
  /** Vence en 2 días hábiles o menos. */
  dueSoon: boolean;
  /** En una espera, ya toca reclamar. */
  chaseDue: boolean;
};

/**
 * «por_validar»: todas sus tareas están hechas, pero ningún correo del expediente lo
 * demuestra. El correo es la fuente de la verdad: sin él la fase no se da por buena.
 */
export type PhaseState = "hecha" | "por_validar" | "actual" | "retraso" | "proxima";

export type NextStep =
  | { kind: "tarea"; taskId: string; name: string; due: Day | null; late: boolean; legal: boolean }
  | { kind: "esperar"; taskId: string; name: string; waitingOn: string | null; chaseAt: Day | null }
  | { kind: "desbloquear"; taskId: string; name: string; blockers: string[] }
  | { kind: "validar"; phaseId: string; name: string }
  | { kind: "cerrar" }
  | { kind: "sin_plan" };

export type HealthLevel = "cerrado" | "sin_plan" | "vencidas" | "parado" | "riesgo" | "al_dia";
export type Health = { level: HealthLevel; reasons: string[]; lateCount: number; idleDays: number };

/** Umbrales de la salud. Constantes por ahora; más adelante, por tipo de expediente. */
export const THRESHOLDS = {
  lateSevereDays: 3,
  idleRiskDays: 5,
  idleStoppedDays: 10,
  dueSoonBusinessDays: 2,
};

export class CycleError extends Error {}

/** Rechaza dependencias en círculo. Devuelve los ids en un orden válido. */
export function assertAcyclic(
  tasks: { id: string; name?: string; dependsOn: string[] }[],
): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const names = [...path.slice(path.indexOf(id)), id].map(
        (entry) => byId.get(entry)?.name ?? entry,
      );
      throw new CycleError(`Las tareas se esperan unas a otras en círculo: ${names.join(" → ")}.`);
    }
    state.set(id, "visiting");
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency, [...path, id]);
    }
    state.set(id, "done");
    order.push(id);
  };
  for (const task of tasks) visit(task.id, []);
  return order;
}

const finished = (status: TaskStatus) => status === "hecha" || status === "omitida";

/**
 * El plazo efectivo de una tarea: el que se le haya puesto a mano o, si no, su ancla más
 * los días. Si cuenta desde que se cumplen sus dependencias y aún no se han cumplido, no
 * tiene plazo todavía.
 */
export function effectiveDue(
  task: EngineTask,
  kase: EngineCase,
  byId: Map<string, EngineTask>,
): Day | null {
  if (task.dueOverride) return task.dueOverride;
  if (task.dueDays === null) return null;
  let anchor: Day | null;
  if (task.dueAnchor === "apertura") anchor = kase.openedAt;
  else if (task.dueAnchor === "siniestro") anchor = kase.lossDate ?? kase.openedAt;
  else {
    const dependencies = task.dependsOn
      .map((id) => byId.get(id))
      .filter((entry) => entry !== undefined);
    if (dependencies.length === 0) anchor = kase.openedAt;
    else if (dependencies.some((entry) => !finished(entry.status))) anchor = null;
    else {
      // Una omitida no tiene fecha de cumplimiento: cuenta desde la apertura.
      const dates = dependencies.map((entry) => entry.doneAt ?? kase.openedAt);
      anchor = dates.sort().at(-1)!;
    }
  }
  if (anchor === null) return null;
  return task.dueUnit === "habiles"
    ? addBusinessDays(anchor, task.dueDays)
    : addCalendarDays(anchor, task.dueDays);
}

export function deriveTasks(tasks: EngineTask[], kase: EngineCase, today: Day): DerivedTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => {
    const due = effectiveDue(task, kase, byId);
    const blockers = task.dependsOn
      .map((id) => byId.get(id))
      .filter((entry) => entry !== undefined && !finished(entry.status))
      .map((entry) => entry!.name);
    let state: DerivedState;
    if (finished(task.status)) state = task.status;
    else if (blockers.length > 0) state = "bloqueada";
    else if (task.status === "esperando") state = "esperando";
    else if (task.status === "en_curso") state = "en_curso";
    else state = "lista";
    const open = !finished(task.status);
    const lateDays = open && due && due < today ? daysBetween(due, today) : 0;
    const dueSoon =
      open &&
      lateDays === 0 &&
      due !== null &&
      businessDaysUntil(today, due) <= THRESHOLDS.dueSoonBusinessDays;
    const chaseDue = state === "esperando" && task.chaseAt !== null && task.chaseAt <= today;
    return { ...task, state, blockers, due, lateDays, dueSoon, chaseDue };
  });
}

const byPlan = (phases: EnginePhase[]) => {
  const phasePosition = new Map(phases.map((phase) => [phase.id, phase.position]));
  return (a: DerivedTask, b: DerivedTask) =>
    (phasePosition.get(a.phaseId) ?? 0) - (phasePosition.get(b.phaseId) ?? 0) ||
    a.position - b.position;
};

export function phaseStates(phases: EnginePhase[], tasks: DerivedTask[]): Map<string, PhaseState> {
  const result = new Map<string, PhaseState>();
  for (const phase of phases) {
    const own = tasks.filter((task) => task.phaseId === phase.id);
    let state: PhaseState;
    if (own.every((task) => task.state === "hecha" || task.state === "omitida")) {
      const done = own.filter((task) => task.state === "hecha");
      // Una fase que no aplica entera no tiene nada que validar.
      state =
        done.length === 0 || done.some((task) => task.evidenceMessageId) ? "hecha" : "por_validar";
    } else if (own.some((task) => task.lateDays > 0)) state = "retraso";
    else if (own.some((task) => ["lista", "en_curso", "esperando"].includes(task.state)))
      state = "actual";
    else state = "proxima";
    result.set(phase.id, state);
  }
  return result;
}

/**
 * Lo único que hay que hacer ahora. Primero lo que se puede hacer ya: lo vencido, luego
 * lo que tiene plazo legal, luego por fecha y por orden del plan. Si todo depende de
 * otros, la espera que antes toca reclamar.
 */
export function nextStep(phases: EnginePhase[], tasks: DerivedTask[]): NextStep {
  // Una fase terminada sin correo que la demuestre va antes que lo demás, salvo lo vencido.
  if (tasks.length === 0) return { kind: "sin_plan" };
  const order = byPlan(phases);
  const actionable = tasks
    .filter((task) => task.state === "lista" || task.state === "en_curso")
    .sort(
      (a, b) =>
        Number(b.lateDays > 0) - Number(a.lateDays > 0) ||
        Number(b.legalRef !== null) - Number(a.legalRef !== null) ||
        (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
        order(a, b),
    );
  const first = actionable[0];
  const states = phaseStates(phases, tasks);
  const unvalidated = [...phases]
    .sort((a, b) => a.position - b.position)
    .find((phase) => states.get(phase.id) === "por_validar");
  const validate = unvalidated
    ? ({ kind: "validar", phaseId: unvalidated.id, name: unvalidated.name } as const)
    : null;
  if (validate && !(first && first.lateDays > 0)) return validate;
  if (first) {
    return {
      kind: "tarea",
      taskId: first.id,
      name: first.name,
      due: first.due,
      late: first.lateDays > 0,
      legal: first.legalRef !== null,
    };
  }
  const waits = tasks
    .filter((task) => task.state === "esperando")
    .sort((a, b) => (a.chaseAt ?? "9999").localeCompare(b.chaseAt ?? "9999") || order(a, b));
  const wait = waits[0];
  if (wait) {
    return {
      kind: "esperar",
      taskId: wait.id,
      name: wait.name,
      waitingOn: wait.waitingOn,
      chaseAt: wait.chaseAt,
    };
  }
  const blocked = tasks.filter((task) => task.state === "bloqueada").sort(order)[0];
  if (blocked)
    return {
      kind: "desbloquear",
      taskId: blocked.id,
      name: blocked.name,
      blockers: blocked.blockers,
    };
  return { kind: "cerrar" };
}

/** Lo que cuenta como avance real. Una nota o un correo cualquiera no. */
const PROGRESS: EventKind[] = ["creada", "estado", "espera", "reclamada", "prueba"];

export function idleDays(events: EngineEvent[], kase: EngineCase, today: Day): number {
  const last = events
    .filter((event) => PROGRESS.includes(event.kind))
    .map((event) => dayOf(event.at))
    .sort()
    .at(-1);
  return Math.max(0, daysBetween(last ?? kase.openedAt, today));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function health(kase: EngineCase, tasks: DerivedTask[], idle: number): Health {
  const late = tasks.filter((task) => task.lateDays > 0);
  const base = { lateCount: late.length, idleDays: idle };
  if (kase.status === "cerrado") return { ...base, level: "cerrado", reasons: [] };
  if (tasks.length === 0) return { ...base, level: "sin_plan", reasons: ["Sin plan de tareas"] };

  const reasons: string[] = [];
  const legalLate = late.filter((task) => task.legalRef !== null);
  const severeLate = late.filter((task) => task.lateDays > THRESHOLDS.lateSevereDays);
  for (const task of legalLate) reasons.push(`Plazo legal vencido: ${task.name}`);
  if (late.length > 0) reasons.push(plural(late.length, "tarea vencida", "tareas vencidas"));
  if (legalLate.length > 0 || severeLate.length > 0) return { ...base, level: "vencidas", reasons };
  if (idle >= THRESHOLDS.idleStoppedDays) {
    return {
      ...base,
      level: "parado",
      reasons: [...reasons, `Sin avance real desde hace ${idle} días`],
    };
  }

  for (const task of tasks.filter((entry) => entry.chaseDue)) {
    reasons.push(`Toca reclamar${task.waitingOn ? ` a ${task.waitingOn}` : ""}: ${task.name}`);
  }
  for (const task of tasks.filter((entry) => entry.dueSoon))
    reasons.push(`Vence pronto: ${task.name}`);
  if (idle >= THRESHOLDS.idleRiskDays) reasons.push(`Sin avance real desde hace ${idle} días`);
  return { ...base, level: reasons.length > 0 ? "riesgo" : "al_dia", reasons };
}

export type CaseSummary = {
  tasks: DerivedTask[];
  phases: (EnginePhase & { state: PhaseState })[];
  nextStep: NextStep;
  health: Health;
  /** La fase en la que está: la primera sin terminar. */
  currentPhase: string | null;
};

export function summarize(input: {
  kase: EngineCase;
  phases: EnginePhase[];
  tasks: EngineTask[];
  events: EngineEvent[];
  today: Day;
}): CaseSummary {
  const tasks = deriveTasks(input.tasks, input.kase, input.today).sort(byPlan(input.phases));
  const states = phaseStates(input.phases, tasks);
  const phases = [...input.phases]
    .sort((a, b) => a.position - b.position)
    .map((phase) => ({ ...phase, state: states.get(phase.id)! }));
  const idle = idleDays(input.events, input.kase, input.today);
  return {
    tasks,
    phases,
    nextStep: nextStep(input.phases, tasks),
    health: health(input.kase, tasks, idle),
    currentPhase:
      phases.find((phase) => phase.state !== "hecha" && phase.state !== "por_validar")?.name ??
      null,
  };
}
