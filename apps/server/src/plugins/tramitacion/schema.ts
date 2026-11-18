/** Tablas del módulo de tramitación y forma de las plantillas. */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../../db/client.ts";
import { assertAcyclic } from "./engine.ts";
import { SEED_TEMPLATE } from "./template-seed.ts";

/** Clases del directorio de terceros. */
export const CONTACT_ROLES = [
  "aseguradora",
  "perito",
  "taller",
  "abogado",
  "policia",
  "medico",
  "grua",
  "otro",
] as const;
/** Papeles en un expediente: los del directorio, el cliente y la aseguradora contraria. */
export const PARTY_ROLES = [...CONTACT_ROLES, "aseguradora_contraria", "cliente"] as const;

const templateTask = z.object({
  key: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  ownerRule: z.enum(["gestor"]).nullable().optional(),
  waitsOnRole: z.enum(PARTY_ROLES).nullable().optional(),
  after: z.array(z.string()).max(20).optional(),
  dueAnchor: z.enum(["apertura", "siniestro", "lista"]).optional(),
  dueDays: z.number().int().min(0).max(3650).nullable().optional(),
  dueUnit: z.enum(["naturales", "habiles"]).optional(),
  chaseDays: z.number().int().min(1).max(365).nullable().optional(),
  legalRef: z.string().trim().max(200).nullable().optional(),
  optional: z.boolean().optional(),
});
export const templateTree = z.object({
  name: z.string().trim().min(1).max(120),
  caseTypeId: z.uuid().nullable().optional(),
  caseTypeName: z.string().optional(),
  active: z.boolean().optional(),
  phases: z
    .array(
      z.object({ name: z.string().trim().min(1).max(80), tasks: z.array(templateTask).max(60) }),
    )
    .min(1)
    .max(12),
});
export type TemplateTree = z.input<typeof templateTree>;

export class TemplateError extends Error {}

/** Comprueba que las claves sean únicas, que «después de» apunte a tareas que existen y que no haya círculos. */
export function validateTree(tree: z.output<typeof templateTree>): void {
  const tasks = tree.phases.flatMap((phase) => phase.tasks);
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) throw new TemplateError(`La clave «${task.key}» está repetida.`);
    keys.add(task.key);
  }
  for (const task of tasks) {
    for (const key of task.after ?? []) {
      if (!keys.has(key))
        throw new TemplateError(`«${task.name}» va después de «${key}», que no existe.`);
    }
  }
  assertAcyclic(
    tasks.map((task) => ({ id: task.key, name: task.name, dependsOn: task.after ?? [] })),
  );
}

export async function setupTramitacion(db: Db): Promise<void> {
  await db.execute(sql`
    create table if not exists tra_contacts (
      id uuid primary key default gen_random_uuid(),
      role text not null,
      name text not null,
      email text,
      phone text,
      notes text,
      active boolean not null default true,
      created_by uuid,
      created_at timestamptz not null default now()
    )`);
  await db.execute(
    sql`create unique index if not exists tra_contacts_name on tra_contacts (lower(name))`,
  );
  await db.execute(
    sql`create index if not exists tra_contacts_email on tra_contacts (lower(email))`,
  );

  await db.execute(sql`
    create table if not exists tra_templates (
      id uuid primary key default gen_random_uuid(),
      case_type_id uuid references exp_case_types(id) on delete set null,
      name text not null,
      active boolean not null default true,
      updated_at timestamptz not null default now()
    )`);
  await db.execute(
    sql`create unique index if not exists tra_templates_name on tra_templates (lower(name))`,
  );
  await db.execute(sql`
    create table if not exists tra_template_phases (
      id uuid primary key default gen_random_uuid(),
      template_id uuid not null references tra_templates(id) on delete cascade,
      position integer not null,
      name text not null
    )`);
  await db.execute(sql`
    create table if not exists tra_template_tasks (
      id uuid primary key default gen_random_uuid(),
      template_id uuid not null references tra_templates(id) on delete cascade,
      phase_id uuid not null references tra_template_phases(id) on delete cascade,
      key text not null,
      position integer not null,
      name text not null,
      description text,
      owner_rule text,
      waits_on_role text,
      due_anchor text not null default 'lista',
      due_days integer,
      due_unit text not null default 'naturales',
      chase_days integer,
      legal_ref text,
      optional boolean not null default false
    )`);
  await db.execute(sql`
    create table if not exists tra_template_deps (
      task_id uuid not null references tra_template_tasks(id) on delete cascade,
      depends_on_id uuid not null references tra_template_tasks(id) on delete cascade,
      primary key (task_id, depends_on_id)
    )`);

  await db.execute(sql`
    create table if not exists tra_case_plans (
      case_id uuid primary key references exp_cases(id) on delete cascade,
      template_id uuid references tra_templates(id) on delete set null,
      template_name text,
      applied_at timestamptz not null default now(),
      applied_by uuid
    )`);
  await db.execute(sql`
    create table if not exists tra_phases (
      id uuid primary key default gen_random_uuid(),
      case_id uuid not null references exp_cases(id) on delete cascade,
      position integer not null,
      name text not null
    )`);
  await db.execute(sql`
    create table if not exists tra_tasks (
      id uuid primary key default gen_random_uuid(),
      case_id uuid not null references exp_cases(id) on delete cascade,
      phase_id uuid not null references tra_phases(id) on delete cascade,
      key text,
      position integer not null,
      name text not null,
      description text,
      status text not null default 'pendiente',
      assignee_id uuid references users(id) on delete set null,
      waits_on_role text,
      waiting_contact_id uuid references tra_contacts(id) on delete set null,
      waiting_client boolean not null default false,
      waiting_since date,
      chase_at date,
      chase_days integer,
      chase_count integer not null default 0,
      due_anchor text not null default 'lista',
      due_days integer,
      due_unit text not null default 'naturales',
      due_override date,
      legal_ref text,
      done_at date,
      done_by uuid,
      evidence_message_id uuid references messages(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`);
  await db.execute(sql`create index if not exists tra_tasks_case on tra_tasks (case_id)`);
  // Borrador de reclamación en curso: al enviarse, la reclamación se apunta sola.
  await db.execute(sql`alter table tra_tasks add column if not exists chase_outbound_id uuid`);
  await db.execute(sql`create index if not exists tra_tasks_assignee on tra_tasks (assignee_id)`);
  await db.execute(sql`
    create table if not exists tra_task_deps (
      task_id uuid not null references tra_tasks(id) on delete cascade,
      depends_on_id uuid not null references tra_tasks(id) on delete cascade,
      primary key (task_id, depends_on_id)
    )`);
  await db.execute(sql`
    create table if not exists tra_case_parties (
      case_id uuid not null references exp_cases(id) on delete cascade,
      contact_id uuid not null references tra_contacts(id) on delete cascade,
      role text not null,
      reference text,
      added_at timestamptz not null default now(),
      primary key (case_id, contact_id, role)
    )`);
  await db.execute(sql`
    create table if not exists tra_events (
      id bigserial primary key,
      case_id uuid not null references exp_cases(id) on delete cascade,
      task_id uuid references tra_tasks(id) on delete set null,
      user_id uuid,
      at timestamptz not null default now(),
      kind text not null,
      detail jsonb not null default '{}'::jsonb
    )`);
  await db.execute(sql`create index if not exists tra_events_case on tra_events (case_id, at)`);

  // La plantilla de serie, solo la primera vez.
  const existing = await db.execute(sql`select 1 from tra_templates limit 1`);
  if (existing.rows.length === 0) {
    const tree = templateTree.parse(SEED_TEMPLATE);
    const type = await db.execute<{ id: string }>(
      sql`select id from exp_case_types where lower(name) = lower(${SEED_TEMPLATE.caseTypeName ?? ""})`,
    );
    await db.transaction((tx) =>
      saveTemplate(tx, null, { ...tree, caseTypeId: type.rows[0]?.id ?? null }),
    );
  }
}

/** Crea o sustituye una plantilla entera. Los expedientes abiertos conservan su copia. */
export async function saveTemplate(
  tx: Tx,
  id: string | null,
  tree: z.output<typeof templateTree>,
): Promise<string> {
  validateTree(tree);
  let templateId = id;
  if (templateId) {
    await tx.execute(sql`
      update tra_templates set name = ${tree.name}, case_type_id = ${tree.caseTypeId ?? null},
             active = ${tree.active ?? true}, updated_at = now()
       where id = ${templateId}`);
    await tx.execute(sql`delete from tra_template_phases where template_id = ${templateId}`);
  } else {
    const created = await tx.execute<{ id: string }>(sql`
      insert into tra_templates (name, case_type_id, active)
      values (${tree.name}, ${tree.caseTypeId ?? null}, ${tree.active ?? true}) returning id`);
    templateId = created.rows[0]!.id;
  }
  const idByKey = new Map<string, string>();
  for (const [phaseIndex, phase] of tree.phases.entries()) {
    const phaseRow = await tx.execute<{ id: string }>(sql`
      insert into tra_template_phases (template_id, position, name)
      values (${templateId}, ${phaseIndex + 1}, ${phase.name}) returning id`);
    for (const [taskIndex, task] of phase.tasks.entries()) {
      const taskRow = await tx.execute<{ id: string }>(sql`
        insert into tra_template_tasks (template_id, phase_id, key, position, name, description,
               owner_rule, waits_on_role, due_anchor, due_days, due_unit, chase_days, legal_ref, optional)
        values (${templateId}, ${phaseRow.rows[0]!.id}, ${task.key}, ${taskIndex + 1}, ${task.name},
                ${task.description ?? null}, ${task.ownerRule ?? null}, ${task.waitsOnRole ?? null},
                ${task.dueAnchor ?? "lista"}, ${task.dueDays ?? null}, ${task.dueUnit ?? "naturales"},
                ${task.chaseDays ?? null}, ${task.legalRef ?? null}, ${task.optional ?? false})
        returning id`);
      idByKey.set(task.key, taskRow.rows[0]!.id);
    }
  }
  for (const task of tree.phases.flatMap((phase) => phase.tasks)) {
    for (const key of task.after ?? []) {
      await tx.execute(sql`
        insert into tra_template_deps (task_id, depends_on_id)
        values (${idByKey.get(task.key)!}, ${idByKey.get(key)!}) on conflict do nothing`);
    }
  }
  return templateId;
}

/** Una plantilla como árbol, tal como se edita. */
export async function loadTemplate(db: Db | Tx, id: string) {
  const [template] = (
    await db.execute<{ id: string; name: string; caseTypeId: string | null; active: boolean }>(sql`
      select id, name, case_type_id as "caseTypeId", active from tra_templates where id = ${id}`)
  ).rows;
  if (!template) return null;
  const phases = await db.execute<{ id: string; name: string }>(sql`
    select id, name from tra_template_phases where template_id = ${id} order by position`);
  const tasks = await db.execute<
    Record<string, unknown> & { id: string; phaseId: string; key: string }
  >(sql`
    select t.id, t.phase_id as "phaseId", t.key, t.name, t.description, t.owner_rule as "ownerRule",
           t.waits_on_role as "waitsOnRole", t.due_anchor as "dueAnchor", t.due_days as "dueDays",
           t.due_unit as "dueUnit", t.chase_days as "chaseDays", t.legal_ref as "legalRef", t.optional,
           coalesce((select array_agg(d2.key order by d2.position) from tra_template_deps d
                       join tra_template_tasks d2 on d2.id = d.depends_on_id
                      where d.task_id = t.id), '{}') as after
      from tra_template_tasks t where t.template_id = ${id} order by t.position`);
  return {
    ...template,
    phases: phases.rows.map((phase) => ({
      name: phase.name,
      tasks: tasks.rows
        .filter((task) => task.phaseId === phase.id)
        .map((task) => {
          const { id, phaseId, ...rest } = task;
          void id;
          void phaseId;
          return rest;
        }),
    })),
  };
}
