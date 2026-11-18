/** Textos de la tramitación, en el lenguaje de la oficina. Puro, para poder probarlo. */
import type { Health, NextStep, Task } from "./api.ts";

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
export const daysBetween = (from: string, to: string) =>
  Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);

/** «18/11». Con el año solo si no es el de hoy. */
export function shortDay(day: string | null, today?: string): string {
  if (!day) return "—";
  const [year, month, date] = day.split("-");
  return today && today.slice(0, 4) !== year ? `${date}/${month}/${year}` : `${date}/${month}`;
}

/** Cómo se dice un plazo: «Vencida ayer», «Vence mañana», «22/11». */
export function dueText(
  due: string | null,
  today: string,
): { text: string; tone: "late" | "soon" | "normal" | "none" } {
  if (!due) return { text: "—", tone: "none" };
  const days = daysBetween(today, due);
  if (days < 0)
    return { text: days === -1 ? "Vencida ayer" : `Vencida hace ${-days} d`, tone: "late" };
  if (days === 0) return { text: "Vence hoy", tone: "soon" };
  if (days === 1) return { text: "Vence mañana", tone: "soon" };
  if (days <= 3) return { text: `Vence en ${days} d`, tone: "soon" };
  return { text: shortDay(due, today), tone: "normal" };
}

/** La situación de una tarea en una línea. */
export function taskStatusText(task: Task, today: string): string {
  switch (task.state) {
    case "hecha":
      return `Hecha ${shortDay(task.doneAt, today)}`;
    case "omitida":
      return "No aplica";
    case "bloqueada":
      return `Bloqueada por: ${task.blockers.join(", ")}`;
    case "en_curso":
      return "En curso";
    case "esperando": {
      const since = task.waitingSince ? ` · ${daysBetween(task.waitingSince, today)} d` : "";
      const chase = task.chaseAt
        ? task.chaseDue
          ? " · toca reclamar"
          : ` · reclamar ${shortDay(task.chaseAt, today)}`
        : "";
      return `Esperando ${toWho(task.waitingOn)}${since}${chase}`;
    }
    default:
      return "Por hacer";
  }
}

export function healthText(health: Health): string {
  switch (health.level) {
    case "vencidas":
      return health.lateCount === 1 ? "1 vencida" : `${health.lateCount} vencidas`;
    case "parado":
      return `Parado ${health.idleDays} d`;
    case "riesgo":
      return "En riesgo";
    case "al_dia":
      return "Al día";
    case "cerrado":
      return "Cerrado";
    default:
      return "Sin plan";
  }
}

/** El siguiente paso dicho como lo que hay que hacer. */
export function nextStepText(step: NextStep, today: string): string {
  switch (step.kind) {
    case "tarea":
      return step.name;
    case "esperar":
      return step.chaseAt && step.chaseAt <= today
        ? `Reclamar ${toWho(step.waitingOn, "a quien se espera")}`
        : `Esperar ${toWho(step.waitingOn)}${step.chaseAt ? ` · reclamar el ${shortDay(step.chaseAt, today)}` : ""}`;
    case "desbloquear":
      return `Desbloquear: ${step.name}`;
    case "cerrar":
      return "Cerrar el expediente";
    default:
      return "Aplicar un plan";
  }
}

/** Orden de las tareas en Mis tareas y en la cartera: lo más urgente arriba. */
export const SEVERITY: Record<Health["level"], number> = {
  vencidas: 0,
  parado: 1,
  riesgo: 2,
  al_dia: 3,
  sin_plan: 4,
  cerrado: 5,
};

/** Un correo que parece un atestado o un parte: se resalta el botón «Tramitar». */
export const looksLikeClaim = (subject: string, filenames: (string | null)[]) =>
  /atestado|diligencias|parte[\s_-]*amistoso|declaraci[oó]n[\s_-]*amistosa|\bparte\b/i.test(
    [subject, ...filenames.filter(Boolean)].join(" "),
  );

/** Texto plano del borrador de reclamación como HTML sencillo para el redactor. */
export const textToHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${paragraph.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");

/** «a Peritaciones Norte», pero «al cliente»: el artículo se contrae. */
export function toWho(who: string | null | undefined, fallback = "a un tercero"): string {
  if (!who) return fallback;
  return who.startsWith("el ") ? `al ${who.slice(3)}` : `a ${who}`;
}

const WAITS_ON: Record<string, string> = {
  cliente: "al cliente",
  aseguradora: "a la aseguradora",
  aseguradora_contraria: "a la aseguradora contraria",
  perito: "al perito",
  taller: "al taller",
  abogado: "al abogado",
  policia: "a la policía o el juzgado",
  medico: "al médico",
  grua: "a la grúa",
  otro: "a un tercero",
};

/** Una tarea de plantilla en una frase: «Gestor · espera al perito · 7 d hábiles tras T6». */
export function templateTaskSummary(task: {
  ownerRule?: string | null;
  waitsOnRole?: string | null;
  after?: string[];
  dueAnchor?: string;
  dueDays?: number | null;
  dueUnit?: string;
  chaseDays?: number | null;
}): string {
  const parts = [task.ownerRule === "gestor" ? "Gestor" : "Sin responsable"];
  if (task.waitsOnRole) parts.push(`espera ${WAITS_ON[task.waitsOnRole] ?? "a un tercero"}`);
  if (task.dueDays == null) parts.push("sin plazo");
  else {
    const amount = `${task.dueDays} d${task.dueUnit === "habiles" ? " hábiles" : ""}`;
    const after = task.after ?? [];
    const from =
      task.dueAnchor === "siniestro"
        ? " desde el siniestro"
        : task.dueAnchor === "apertura" || after.length === 0
          ? " desde la apertura"
          : ` tras ${after.join(", ")}`;
    parts.push(amount + from);
  }
  if (task.chaseDays) parts.push(`reclamar cada ${task.chaseDays} d hábiles`);
  return parts.join(" · ");
}
