/** Lectura y escritura del plan de un expediente. */
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import { dayOf, type Day } from "./days.ts";
import {
  summarize,
  type CaseSummary,
  type EngineCase,
  type EngineEvent,
  type EnginePhase,
  type EngineTask,
  type EventKind,
} from "./engine.ts";

/** Hoy en la península: un plazo vence según el calendario de la oficina, no el de Greenwich. */
export const todayInSpain = (): Day =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

export async function recordEvent(
  db: Db | Tx,
  input: {
    caseId: string;
    taskId?: string | null;
    userId: string | null;
    kind: EventKind;
    detail?: object;
  },
): Promise<void> {
  await db.execute(sql`
    insert into tra_events (case_id, task_id, user_id, kind, detail)
    values (${input.caseId}, ${input.taskId ?? null}, ${input.userId}, ${input.kind},
            ${JSON.stringify(input.detail ?? {})}::jsonb)`);
}

/** Copia la plantilla en el expediente. Después, el plan del expediente va por su cuenta. */
export async function applyTemplate(
  tx: Tx,
  input: { caseId: string; templateId: string; userId: string; ownerId: string | null },
): Promise<void> {
  const [template] = (
    await tx.execute<{ name: string }>(
      sql`select name from tra_templates where id = ${input.templateId}`,
    )
  ).rows;
  if (!template) throw new Error("template_not_found");
  await tx.execute(sql`
    insert into tra_case_plans (case_id, template_id, template_name, applied_by)
    values (${input.caseId}, ${input.templateId}, ${template.name}, ${input.userId})`);

  const phases = await tx.execute<{ id: string; position: number; name: string }>(sql`
    select id, position, name from tra_template_phases where template_id = ${input.templateId} order by position`);
  const phaseMap = new Map<string, string>();
  for (const phase of phases.rows) {
    const created = await tx.execute<{ id: string }>(sql`
      insert into tra_phases (case_id, position, name) values (${input.caseId}, ${phase.position}, ${phase.name})
      returning id`);
    phaseMap.set(phase.id, created.rows[0]!.id);
  }
  const tasks = await tx.execute<{
    id: string;
    phaseId: string;
    key: string;
    position: number;
    name: string;
    description: string | null;
    ownerRule: string | null;
    waitsOnRole: string | null;
    dueAnchor: string;
    dueDays: number | null;
    dueUnit: string;
    chaseDays: number | null;
    legalRef: string | null;
    optional: boolean;
  }>(sql`
    select id, phase_id as "phaseId", key, position, name, description, owner_rule as "ownerRule",
           waits_on_role as "waitsOnRole", due_anchor as "dueAnchor", due_days as "dueDays",
           due_unit as "dueUnit", chase_days as "chaseDays", legal_ref as "legalRef", optional
      from tra_template_tasks where template_id = ${input.templateId}`);
  const taskMap = new Map<string, string>();
  for (const task of tasks.rows) {
    const created = await tx.execute<{ id: string }>(sql`
      insert into tra_tasks (case_id, phase_id, key, position, name, description, status, assignee_id,
             waits_on_role, chase_days, due_anchor, due_days, due_unit, legal_ref)
      values (${input.caseId}, ${phaseMap.get(task.phaseId)!}, ${task.key}, ${task.position}, ${task.name},
              ${task.description}, ${task.optional ? "omitida" : "pendiente"},
              ${task.ownerRule === "gestor" ? input.ownerId : null}, ${task.waitsOnRole},
              ${task.chaseDays}, ${task.dueAnchor}, ${task.dueDays}, ${task.dueUnit}, ${task.legalRef})
      returning id`);
    taskMap.set(task.id, created.rows[0]!.id);
  }
  const deps = await tx.execute<{ taskId: string; dependsOnId: string }>(sql`
    select d.task_id as "taskId", d.depends_on_id as "dependsOnId"
      from tra_template_deps d join tra_template_tasks t on t.id = d.task_id
     where t.template_id = ${input.templateId}`);
  for (const dep of deps.rows) {
    await tx.execute(sql`
      insert into tra_task_deps (task_id, depends_on_id)
      values (${taskMap.get(dep.taskId)!}, ${taskMap.get(dep.dependsOnId)!})`);
  }
  await recordEvent(tx, {
    caseId: input.caseId,
    userId: input.userId,
    kind: "creada",
    detail: { template: template.name },
  });
}

export type TaskRow = {
  id: string;
  caseId: string;
  phaseId: string;
  key: string | null;
  position: number;
  name: string;
  description: string | null;
  status: EngineTask["status"];
  assigneeId: string | null;
  assigneeName: string | null;
  waitsOnRole: string | null;
  waitingContactId: string | null;
  waitingContactName: string | null;
  waitingContactEmail: string | null;
  waitingContactPhone: string | null;
  waitingClient: boolean;
  waitingSince: Day | null;
  chaseAt: Day | null;
  chaseDays: number | null;
  chaseCount: number;
  dueAnchor: EngineTask["dueAnchor"];
  dueDays: number | null;
  dueUnit: EngineTask["dueUnit"];
  dueOverride: Day | null;
  legalRef: string | null;
  doneAt: Day | null;
  evidenceIds: string[];
  dependsOn: string[];
};

const taskColumns = sql`t.id, t.case_id as "caseId", t.phase_id as "phaseId", t.key, t.position, t.name,
  t.description, t.status, t.assignee_id as "assigneeId",
  (select u.name from users u where u.id = t.assignee_id) as "assigneeName",
  t.waits_on_role as "waitsOnRole", t.waiting_contact_id as "waitingContactId",
  c.name as "waitingContactName", c.email as "waitingContactEmail", c.phone as "waitingContactPhone", t.waiting_client as "waitingClient",
  to_char(t.waiting_since, 'YYYY-MM-DD') as "waitingSince", to_char(t.chase_at, 'YYYY-MM-DD') as "chaseAt",
  t.chase_days as "chaseDays", t.chase_count as "chaseCount", t.due_anchor as "dueAnchor",
  t.due_days as "dueDays", t.due_unit as "dueUnit", to_char(t.due_override, 'YYYY-MM-DD') as "dueOverride",
  t.legal_ref as "legalRef", to_char(t.done_at, 'YYYY-MM-DD') as "doneAt",
  coalesce((select array_agg(e.message_id order by e.added_at) from tra_task_evidence e where e.task_id = t.id), '{}') as "evidenceIds",
  coalesce((select array_agg(d.depends_on_id) from tra_task_deps d where d.task_id = t.id), '{}') as "dependsOn"`;

export async function loadTask(db: Db | Tx, id: string): Promise<TaskRow | null> {
  const rows = await db.execute<TaskRow>(sql`
    select ${taskColumns} from tra_tasks t left join tra_contacts c on c.id = t.waiting_contact_id
     where t.id = ${id}`);
  return rows.rows[0] ?? null;
}

export type PlanData = {
  plan: { templateName: string | null; appliedAt: Date } | null;
  phases: EnginePhase[];
  tasks: TaskRow[];
  events: EngineEvent[];
};

/** Todo lo que hace falta para calcular el estado de varios expedientes a la vez. */
export async function loadPlans(db: Db, caseIds: string[]): Promise<Map<string, PlanData>> {
  const result = new Map<string, PlanData>();
  if (caseIds.length === 0) return result;
  const ids = sql.join(
    caseIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  for (const id of caseIds) result.set(id, { plan: null, phases: [], tasks: [], events: [] });
  const plans = await db.execute<{
    caseId: string;
    templateName: string | null;
    appliedAt: Date;
  }>(sql`
    select case_id as "caseId", template_name as "templateName", applied_at as "appliedAt"
      from tra_case_plans where case_id in (${ids})`);
  for (const row of plans.rows)
    result.get(row.caseId)!.plan = { templateName: row.templateName, appliedAt: row.appliedAt };
  const phases = await db.execute<EnginePhase & { caseId: string }>(sql`
    select id, case_id as "caseId", position, name from tra_phases where case_id in (${ids}) order by position`);
  for (const { caseId, ...phase } of phases.rows) result.get(caseId)!.phases.push(phase);
  const tasks = await db.execute<TaskRow>(sql`
    select ${taskColumns} from tra_tasks t left join tra_contacts c on c.id = t.waiting_contact_id
     where t.case_id in (${ids}) order by t.position`);
  for (const task of tasks.rows) result.get(task.caseId)!.tasks.push(task);
  const events = await db.execute<{ caseId: string; at: Date; kind: EventKind }>(sql`
    select case_id as "caseId", at, kind from tra_events
     where case_id in (${ids}) and kind in ('creada', 'estado', 'espera', 'reclamada', 'prueba')`);
  for (const event of events.rows)
    result.get(event.caseId)!.events.push({ at: dayOf(event.at), kind: event.kind });
  return result;
}

export const waitingLabel = (task: TaskRow) =>
  task.waitingClient ? "el cliente" : task.waitingContactName;

export function toEngine(task: TaskRow): EngineTask {
  return { ...task, waitingOn: waitingLabel(task) };
}

export function summarizeCase(
  kase: EngineCase,
  data: PlanData,
  today: Day,
): CaseSummary & { taskRows: Map<string, TaskRow> } {
  const summary = summarize({
    kase,
    phases: data.phases,
    tasks: data.tasks.map(toEngine),
    events: data.events,
    today,
  });
  return { ...summary, taskRows: new Map(data.tasks.map((task) => [task.id, task])) };
}

/** Solo dígitos, con el prefijo de España si es un número nacional de 9 cifras. */
export const phoneDigits = (phone: string | null | undefined): string => {
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^00/, "");
  return digits.length === 9 ? `34${digits}` : digits;
};

/**
 * El remitente es el tercero esperado: por su correo o, si escribe por WhatsApp (dirección
 * «<teléfono>@whatsapp.invalid»), por el teléfono que tiene en el directorio.
 */
export function isFrom(task: TaskRow, fromAddress: string): boolean {
  const from = fromAddress.toLowerCase();
  if (task.waitingContactEmail && task.waitingContactEmail.toLowerCase() === from) return true;
  const whatsapp = /^(\d+)@whatsapp\.invalid$/.exec(from);
  return Boolean(
    whatsapp && task.waitingContactPhone && phoneDigits(task.waitingContactPhone) === whatsapp[1],
  );
}
