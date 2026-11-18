/**
 * Módulo de tramitación: lleva cada expediente como un caso, con fases, tareas de una
 * plantilla, plazos con ancla, esperas a terceros y un semáforo calculado por reglas.
 * Necesita el módulo de expedientes. Sin IA: lo que se sabe del correo lo confirma una
 * persona.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { messages } from "../../db/schema.ts";
import { accessibleAccountIds, assertAccess } from "../../http/access.ts";
import { audit, HttpError, notFound, requireAdmin, requireSession } from "../../http/app.ts";
import {
  caseColumns,
  closeCase,
  CLOSE_REASONS,
  createCaseFromMessage,
  notify,
  type CaseRow,
} from "../expedientes/index.ts";
import type { Db, Tx } from "../../db/client.ts";
import type { MailEvent, ServerPlugin } from "../host.ts";
import { addBusinessDays, addCalendarDays, dayOf, daysBetween, type Day } from "./days.ts";
import { assertAcyclic, CycleError, type EngineCase, type EventKind } from "./engine.ts";
import {
  CONTACT_ROLES,
  loadTemplate,
  PARTY_ROLES,
  saveTemplate,
  setupTramitacion,
  TemplateError,
  templateTree,
} from "./schema.ts";
import {
  applyTemplate,
  loadPlans,
  loadTask,
  recordEvent,
  summarizeCase,
  todayInSpain,
  waitingLabel,
  type PlanData,
  type TaskRow,
} from "./store.ts";

const idParams = z.object({ id: z.uuid() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha con formato AAAA-MM-DD.");
const openBody = z.object({
  messageId: z.uuid(),
  templateId: z.uuid(),
  caseTypeId: z.uuid().nullable().optional(),
  lossDate: day.nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  claimRef: z.string().trim().max(60).nullable().optional(),
  insurerId: z.uuid().nullable().optional(),
  title: z.string().trim().max(200).optional(),
});
const planBody = z.object({ templateId: z.uuid() });
const waitBody = z
  .object({
    contactId: z.uuid().nullable().optional(),
    client: z.boolean().optional(),
    since: day.optional(),
    chaseAt: day.optional(),
  })
  .refine(
    (body) => Boolean(body.contactId) !== Boolean(body.client),
    "Hay que decir a quién se espera.",
  );
const taskPatch = z
  .object({
    status: z.enum(["pendiente", "en_curso", "esperando", "hecha", "omitida"]),
    assigneeId: z.uuid().nullable(),
    dueOverride: day.nullable(),
    waiting: waitBody,
    note: z.string().trim().min(1).max(2000),
    force: z.boolean(),
  })
  .partial();
const evidenceBody = z.object({ messageId: z.uuid(), complete: z.boolean().default(true) });
const newTaskBody = z.object({
  phaseId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  assigneeId: z.uuid().nullable().optional(),
  dueOverride: day.nullable().optional(),
  dependsOn: z.array(z.uuid()).max(20).optional(),
});
const depsBody = z.object({ dependsOn: z.array(z.uuid()).max(20) });
const partyBody = z.object({
  contactId: z.uuid(),
  role: z.enum(PARTY_ROLES),
  reference: z.string().trim().max(80).nullable().optional(),
});
const partyParams = z.object({ id: z.uuid(), contactId: z.uuid() });
const closeBody = z.object({ reason: z.enum(CLOSE_REASONS), force: z.boolean().optional() });
const contactBody = z.object({
  role: z.enum(CONTACT_ROLES),
  name: z.string().trim().min(1).max(120),
  email: z.email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const contactPatch = contactBody.partial().extend({ active: z.boolean().optional() });
const contactQuery = z.object({
  q: z.string().trim().max(80).optional(),
  role: z.enum(CONTACT_ROLES).optional(),
  all: z.enum(["0", "1"]).optional(),
});
const portfolioQuery = z.object({
  estado: z.enum(["abiertos", "cerrados", "todos"]).default("abiertos"),
  salud: z.enum(["vencidas", "parado", "riesgo", "al_dia"]).optional(),
  gestor: z.uuid().optional(),
  responsable: z.uuid().optional(),
  tipo: z.uuid().optional(),
  esperando: z.enum(["terceros", "cliente"]).optional(),
  parados: z.coerce.number().int().min(1).max(365).optional(),
});
const peopleQuery = z
  .object({ caseId: z.uuid().optional(), accountId: z.uuid().optional() })
  .refine(
    (query) => Boolean(query.caseId) !== Boolean(query.accountId),
    "Di el expediente o el buzón.",
  );
const linkBody = z.object({ outboundId: z.uuid() });

/** Apunta una reclamación: suma una y mueve la próxima. */
async function markChased(
  db: Db | Tx,
  task: TaskRow,
  userId: string | null,
  outboundId: string | null,
) {
  const today = todayInSpain();
  const next = task.chaseDays ? addBusinessDays(today, task.chaseDays) : addCalendarDays(today, 7);
  await db.execute(sql`
    update tra_tasks set chase_count = chase_count + 1, chase_at = ${next}, chase_outbound_id = null,
           updated_at = now()
     where id = ${task.id}`);
  await recordEvent(db, {
    caseId: task.caseId,
    taskId: task.id,
    userId,
    kind: "reclamada",
    detail: { next, count: task.chaseCount + 1, outboundId },
  });
}

/** Gravedad para ordenar la cartera: lo que más urge, arriba. */
const SEVERITY: Record<string, number> = {
  vencidas: 0,
  parado: 1,
  riesgo: 2,
  al_dia: 3,
  sin_plan: 4,
  cerrado: 5,
};

const engineCase = (row: CaseRow): EngineCase => ({
  openedAt: dayOf(new Date(row.createdAt)),
  lossDate: row.lossDate,
  status: row.status,
});

export const tramitacionPlugin: ServerPlugin = {
  id: "tramitacion",
  name: "Tramitación",
  description:
    "Lleva cada expediente como un caso: fases, tareas, plazos, esperas a terceros y un semáforo de salud. Necesita Expedientes.",
  requires: ["expedientes"],
  setup: setupTramitacion,
  // Cuando sale un correo de reclamación preparado desde una tarea, se apunta.
  async onEvent(event: MailEvent, db: Db) {
    if (event.type !== "outbound.sent") return;
    const payload = event.payload as { outboundId?: string; userId?: string } | null;
    if (!payload?.outboundId) return;
    const found = await db.execute<{ id: string }>(
      sql`select id from tra_tasks where chase_outbound_id = ${payload.outboundId}`,
    );
    for (const row of found.rows) {
      const task = await loadTask(db, row.id);
      if (task) await markChased(db, task, payload.userId ?? null, payload.outboundId);
    }
  },
  routes: async (app, { context }) => {
    const { db } = context;

    async function loadCase(userId: string, id: string): Promise<CaseRow> {
      const row = (
        await db.execute<CaseRow>(sql`select ${caseColumns} from exp_cases c where c.id = ${id}`)
      ).rows[0];
      if (!row) throw notFound();
      await assertAccess(db, userId, row.accountId);
      return row;
    }

    async function loadOwnTask(userId: string, id: string) {
      const task = await loadTask(db, id);
      if (!task) throw notFound();
      const kase = await loadCase(userId, task.caseId);
      return { task, kase };
    }

    async function checkAssignee(accountId: string, userId: string | null | undefined) {
      if (!userId) return;
      const allowed = await db.execute(
        sql`select 1 from account_access where user_id = ${userId} and account_id = ${accountId}`,
      );
      if (allowed.rows.length === 0) {
        throw new HttpError(
          400,
          "assignee_without_access",
          "Esa persona no tiene acceso a este buzón.",
        );
      }
    }

    /** El expediente con su plan calculado, tal como lo pinta la pantalla. */
    async function caseView(row: CaseRow, data: PlanData, today: Day) {
      const summary = summarizeCase(engineCase(row), data, today);
      const parties = await db.execute(sql`
        select p.contact_id as "contactId", p.role, p.reference, c.name, c.email, c.phone, c.role as "contactRole"
          from tra_case_parties p join tra_contacts c on c.id = p.contact_id
         where p.case_id = ${row.id} order by p.added_at`);
      const history = await db.execute(sql`
        select e.id, e.at, e.kind, e.detail, e.task_id as "taskId",
               (select t.name from tra_tasks t where t.id = e.task_id) as "taskName",
               (select u.name from users u where u.id = e.user_id) as "userName"
          from tra_events e where e.case_id = ${row.id} order by e.at desc, e.id desc limit 50`);
      return {
        case: row,
        plan: data.plan,
        today,
        phases: summary.phases,
        tasks: summary.tasks.map((task) => {
          const raw = summary.taskRows.get(task.id)!;
          return {
            ...task,
            assigneeName: raw.assigneeName,
            waitingContactId: raw.waitingContactId,
            waitingContactEmail: raw.waitingContactEmail,
            waitingClient: raw.waitingClient,
            waitsOnRole: raw.waitsOnRole,
            chaseCount: raw.chaseCount,
            chaseDays: raw.chaseDays,
            description: raw.description,
            evidenceMessageId: raw.evidenceMessageId,
            key: raw.key,
          };
        }),
        nextStep: summary.nextStep,
        health: summary.health,
        currentPhase: summary.currentPhase,
        parties: parties.rows,
        history: history.rows,
      };
    }

    async function viewOf(userId: string, caseId: string) {
      const row = await loadCase(userId, caseId);
      const data = (await loadPlans(db, [caseId])).get(caseId)!;
      return caseView(row, data, todayInSpain());
    }

    async function touched(kase: CaseRow, userId: string, action: string, detail: object) {
      await audit(db, {
        userId,
        accountId: kase.accountId,
        action: `plugin.tramitacion.${action}`,
        target: kase.id,
        detail: { number: kase.number, ...detail },
      });
      await notify(db, kase.accountId);
    }

    // ------------------------------------------------------------ plantillas

    app.get("/templates", async (request) => {
      requireSession(request);
      const rows = await db.execute(sql`
        select t.id, t.name, t.active, t.case_type_id as "caseTypeId",
               (select ct.name from exp_case_types ct where ct.id = t.case_type_id) as "typeName",
               (select count(*)::int from tra_template_phases p where p.template_id = t.id) as phases,
               (select count(*)::int from tra_template_tasks k where k.template_id = t.id) as tasks
          from tra_templates t order by lower(t.name)`);
      return { templates: rows.rows };
    });

    app.get("/templates/:id", async (request) => {
      requireSession(request);
      const { id } = idParams.parse(request.params);
      const template = await loadTemplate(db, id);
      if (!template) throw notFound();
      return { template };
    });

    const saveOrExplain = async (id: string | null, body: unknown) => {
      const tree = templateTree.parse(body);
      try {
        return await db.transaction((tx) => saveTemplate(tx, id, tree));
      } catch (error) {
        if (error instanceof TemplateError || error instanceof CycleError) {
          throw new HttpError(400, "invalid_template", error.message);
        }
        const cause = (error as { cause?: { constraint?: string } }).cause;
        if (cause?.constraint === "tra_templates_name") {
          throw new HttpError(409, "duplicate", "Ya hay una plantilla con ese nombre.");
        }
        throw error;
      }
    };

    app.post("/templates", async (request) => {
      const { user } = requireAdmin(request);
      const id = await saveOrExplain(null, request.body);
      await audit(db, {
        userId: user.id,
        action: "plugin.tramitacion.template_created",
        target: id,
      });
      return { template: await loadTemplate(db, id) };
    });

    app.put("/templates/:id", async (request) => {
      const { user } = requireAdmin(request);
      const { id } = idParams.parse(request.params);
      if (!(await loadTemplate(db, id))) throw notFound();
      await saveOrExplain(id, request.body);
      await audit(db, {
        userId: user.id,
        action: "plugin.tramitacion.template_updated",
        target: id,
      });
      return { template: await loadTemplate(db, id) };
    });

    app.post("/templates/:id/duplicate", async (request) => {
      const { user } = requireAdmin(request);
      const { id } = idParams.parse(request.params);
      const template = await loadTemplate(db, id);
      if (!template) throw notFound();
      const copy = await saveOrExplain(null, {
        ...template,
        name: `${template.name} (copia)`,
        active: false,
      });
      await audit(db, {
        userId: user.id,
        action: "plugin.tramitacion.template_duplicated",
        target: copy,
      });
      return { template: await loadTemplate(db, copy) };
    });

    app.delete("/templates/:id", async (request) => {
      const { user } = requireAdmin(request);
      const { id } = idParams.parse(request.params);
      const removed = await db.execute(
        sql`delete from tra_templates where id = ${id} returning name`,
      );
      if (removed.rows.length === 0) throw notFound();
      await audit(db, {
        userId: user.id,
        action: "plugin.tramitacion.template_removed",
        target: id,
      });
      return { ok: true };
    });

    // ------------------------------------------------------------ directorio de terceros

    app.get("/contacts", async (request) => {
      requireSession(request);
      const { q, role, all } = contactQuery.parse(request.query);
      const pattern = q ? `%${q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%` : null;
      const rows = await db.execute(sql`
        select c.id, c.role, c.name, c.email, c.phone, c.notes, c.active,
               (select count(distinct p.case_id)::int from tra_case_parties p
                  join exp_cases e on e.id = p.case_id
                 where p.contact_id = c.id and e.status = 'abierto') as "openCases"
          from tra_contacts c
         where (${all === "1"} or c.active)
           and (${role ?? null}::text is null or c.role = ${role ?? null})
           and (${pattern}::text is null or lower(c.name) like ${pattern} or lower(coalesce(c.email, '')) like ${pattern})
         order by lower(c.name) limit 200`);
      return { contacts: rows.rows };
    });

    app.post("/contacts", async (request) => {
      const { user } = requireSession(request);
      const body = contactBody.parse(request.body);
      const created = await db.execute<{ id: string }>(sql`
        insert into tra_contacts (role, name, email, phone, notes, created_by)
        values (${body.role}, ${body.name}, ${body.email ?? null}, ${body.phone ?? null}, ${body.notes ?? null}, ${user.id})
        on conflict do nothing returning id`);
      if (!created.rows[0])
        throw new HttpError(409, "duplicate", "Ya hay un contacto con ese nombre.");
      await audit(db, {
        userId: user.id,
        action: "plugin.tramitacion.contact_added",
        target: body.name,
      });
      return { contact: { id: created.rows[0].id, ...body, active: true } };
    });

    app.put("/contacts/:id", async (request) => {
      const session = requireSession(request);
      const { id } = idParams.parse(request.params);
      const body = contactPatch.parse(request.body);
      // Desactivar un contacto es cosa de un administrador.
      if (body.active !== undefined && session.user.role !== "admin") {
        throw new HttpError(
          403,
          "forbidden",
          "Solo un administrador puede desactivar un contacto.",
        );
      }
      const columns: Record<string, string> = {
        role: "role",
        name: "name",
        email: "email",
        phone: "phone",
        notes: "notes",
        active: "active",
      };
      const sets = Object.entries(body).map(
        ([key, value]) => sql`${sql.identifier(columns[key]!)} = ${value ?? null}`,
      );
      if (sets.length === 0) throw new HttpError(400, "empty", "No hay nada que cambiar.");
      const changed = await db.execute(
        sql`update tra_contacts set ${sql.join(sets, sql`, `)} where id = ${id} returning id`,
      );
      if (changed.rows.length === 0) throw notFound();
      await audit(db, {
        userId: session.user.id,
        action: "plugin.tramitacion.contact_updated",
        target: id,
        detail: body,
      });
      return { ok: true };
    });

    // ------------------------------------------------------------ abrir y aplicar plan

    // Abrir expediente desde un correo con su plan, en un solo paso.
    app.post("/open", async (request) => {
      const { user } = requireSession(request);
      const body = openBody.parse(request.body);
      const [message] = await db.select().from(messages).where(eq(messages.id, body.messageId));
      if (!message) throw notFound();
      await assertAccess(db, user.id, message.accountId);
      await checkAssignee(message.accountId, body.ownerId);
      const template = await db.execute<{ caseTypeId: string | null }>(
        sql`select case_type_id as "caseTypeId" from tra_templates where id = ${body.templateId} and active`,
      );
      if (!template.rows[0]) throw notFound();
      const created = await db.transaction(async (tx) => {
        const kase = await createCaseFromMessage(tx, {
          ...body,
          caseTypeId: body.caseTypeId ?? template.rows[0]!.caseTypeId,
          message,
          userId: user.id,
        });
        await applyTemplate(tx, {
          caseId: kase.id,
          templateId: body.templateId,
          userId: user.id,
          ownerId: kase.ownerId,
        });
        return kase;
      });
      await touched(created, user.id, "case_opened", {
        messageId: body.messageId,
        templateId: body.templateId,
      });
      return viewOf(user.id, created.id);
    });

    // Aplicar una plantilla a un expediente que se abrió solo para agrupar correos.
    app.post("/cases/:id/plan", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { templateId } = planBody.parse(request.body);
      const kase = await loadCase(user.id, id);
      const existing = await db.execute(sql`select 1 from tra_case_plans where case_id = ${id}`);
      if (existing.rows.length > 0)
        throw new HttpError(409, "has_plan", "Este expediente ya tiene plan.");
      const template = await db.execute(sql`select 1 from tra_templates where id = ${templateId}`);
      if (template.rows.length === 0) throw notFound();
      await db.transaction((tx) =>
        applyTemplate(tx, { caseId: id, templateId, userId: user.id, ownerId: kase.ownerId }),
      );
      await touched(kase, user.id, "plan_applied", { templateId });
      return viewOf(user.id, id);
    });

    app.get("/cases/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      return viewOf(user.id, id);
    });

    // ------------------------------------------------------------ tareas

    app.patch("/tasks/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const body = taskPatch.parse(request.body);
      const { task, kase } = await loadOwnTask(user.id, id);
      const today = todayInSpain();
      const events: { kind: EventKind; detail: object }[] = [];
      const sets: ReturnType<typeof sql>[] = [];

      if (body.assigneeId !== undefined && body.assigneeId !== task.assigneeId) {
        await checkAssignee(kase.accountId, body.assigneeId);
        sets.push(sql`assignee_id = ${body.assigneeId}`);
        events.push({ kind: "asignada", detail: { assigneeId: body.assigneeId } });
      }
      if (body.dueOverride !== undefined && body.dueOverride !== task.dueOverride) {
        sets.push(sql`due_override = ${body.dueOverride}`);
        events.push({ kind: "plazo", detail: { dueOverride: body.dueOverride } });
      }
      const status = body.waiting ? "esperando" : body.status;
      if (status === "hecha" && !body.force) {
        // No se da por hecha una tarea de la que faltan otras, salvo que se diga a propósito.
        const pending = await db.execute<{ name: string }>(sql`
          select t.name from tra_task_deps d join tra_tasks t on t.id = d.depends_on_id
           where d.task_id = ${id} and t.status not in ('hecha', 'omitida')`);
        if (pending.rows.length > 0) {
          throw new HttpError(
            409,
            "blocked",
            `Todavía falta: ${pending.rows.map((row) => row.name).join(", ")}.`,
          );
        }
      }
      if (status === "esperando") {
        const waiting = body.waiting;
        if (!waiting)
          throw new HttpError(400, "waiting_required", "Hay que decir a quién se espera.");
        if (waiting.contactId) {
          const known = await db.execute(
            sql`select 1 from tra_contacts where id = ${waiting.contactId}`,
          );
          if (known.rows.length === 0) throw notFound();
        }
        const since = waiting.since ?? today;
        const chaseAt =
          waiting.chaseAt ??
          (task.chaseDays ? addBusinessDays(since, task.chaseDays) : addCalendarDays(since, 7));
        sets.push(sql`status = 'esperando', waiting_contact_id = ${waiting.contactId ?? null},
                      waiting_client = ${waiting.client ?? false}, waiting_since = ${since}, chase_at = ${chaseAt},
                      done_at = null, done_by = null`);
        events.push({
          kind: "espera",
          detail: {
            contactId: waiting.contactId ?? null,
            client: waiting.client ?? false,
            since,
            chaseAt,
          },
        });
      } else if (status && status !== task.status) {
        sets.push(sql`status = ${status}`);
        if (status === "hecha") sets.push(sql`done_at = ${today}, done_by = ${user.id}`);
        else sets.push(sql`done_at = null, done_by = null`);
        if (task.status === "esperando")
          sets.push(sql`waiting_contact_id = null, waiting_client = false, chase_at = null`);
        events.push({ kind: "estado", detail: { from: task.status, to: status } });
      }
      if (body.note) events.push({ kind: "nota", detail: { text: body.note } });
      if (sets.length === 0 && events.length === 0)
        throw new HttpError(400, "empty", "No hay nada que cambiar.");

      await db.transaction(async (tx) => {
        if (sets.length > 0) {
          await tx.execute(
            sql`update tra_tasks set ${sql.join(sets, sql`, `)}, updated_at = now() where id = ${id}`,
          );
        }
        for (const event of events)
          await recordEvent(tx, { caseId: task.caseId, taskId: id, userId: user.id, ...event });
      });
      await touched(kase, user.id, "task_changed", {
        taskId: id,
        changes: events.map((event) => event.kind),
      });
      return viewOf(user.id, task.caseId);
    });

    // «Este correo cumple la tarea»: queda como prueba. Si no la cumple del todo, se anota.
    app.post("/tasks/:id/evidence", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { messageId, complete } = evidenceBody.parse(request.body);
      const { task, kase } = await loadOwnTask(user.id, id);
      const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (!message) throw notFound();
      await assertAccess(db, user.id, message.accountId);
      await db.transaction(async (tx) => {
        if (complete) {
          await tx.execute(sql`
            update tra_tasks set status = 'hecha', done_at = ${todayInSpain()}, done_by = ${user.id},
                   evidence_message_id = ${messageId}, waiting_contact_id = null, waiting_client = false,
                   chase_at = null, updated_at = now()
             where id = ${id}`);
          await recordEvent(tx, {
            caseId: task.caseId,
            taskId: id,
            userId: user.id,
            kind: "prueba",
            detail: { messageId, subject: message.subject },
          });
        } else {
          await recordEvent(tx, {
            caseId: task.caseId,
            taskId: id,
            userId: user.id,
            kind: "nota",
            detail: {
              messageId,
              subject: message.subject,
              text: "Correo anotado; la espera sigue.",
            },
          });
        }
      });
      await touched(kase, user.id, complete ? "task_evidence" : "task_note", {
        taskId: id,
        messageId,
      });
      return viewOf(user.id, task.caseId);
    });

    // Borrador del recordatorio a quien se espera. Se envía desde el redactor de siempre.
    app.post("/tasks/:id/chase", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { task, kase } = await loadOwnTask(user.id, id);
      if (task.status !== "esperando")
        throw new HttpError(409, "not_waiting", "Esta tarea no está esperando a nadie.");
      const to = task.waitingClient ? null : task.waitingContactEmail;
      const references = [kase.claimRef, kase.number].filter(Boolean).join(" · ");
      const since = task.waitingSince
        ? task.waitingSince.split("-").reverse().join("/")
        : "hace unos días";
      return {
        draft: {
          accountId: kase.accountId,
          to,
          subject: `${task.name} pendiente · ${references}`,
          text: `Buenos días:\n\nOs escribimos por «${task.name.toLowerCase()}» del siniestro ${references}, que esperamos desde el ${since}. ¿Podéis indicarnos cuándo lo tendréis?\n\nGracias.`,
        },
      };
    });

    // Enlaza el borrador de la reclamación: cuando salga, se apunta solo.
    app.post("/tasks/:id/chase-link", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { outboundId } = linkBody.parse(request.body);
      const { task } = await loadOwnTask(user.id, id);
      if (task.status !== "esperando")
        throw new HttpError(409, "not_waiting", "Esta tarea no está esperando a nadie.");
      await db.execute(
        sql`update tra_tasks set chase_outbound_id = ${outboundId} where id = ${id}`,
      );
      return { ok: true };
    });

    // Apuntar a mano que se ha reclamado (por teléfono, por ejemplo).
    app.post("/tasks/:id/chased", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { task, kase } = await loadOwnTask(user.id, id);
      if (task.status !== "esperando")
        throw new HttpError(409, "not_waiting", "Esta tarea no está esperando a nadie.");
      await db.transaction((tx) => markChased(tx, task, user.id, null));
      await touched(kase, user.id, "task_chased", { taskId: id });
      return viewOf(user.id, task.caseId);
    });

    app.post("/cases/:id/tasks", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const body = newTaskBody.parse(request.body);
      const kase = await loadCase(user.id, id);
      const phase = await db.execute(
        sql`select 1 from tra_phases where id = ${body.phaseId} and case_id = ${id}`,
      );
      if (phase.rows.length === 0) throw notFound();
      await checkAssignee(kase.accountId, body.assigneeId);
      await db.transaction(async (tx) => {
        const created = await tx.execute<{ id: string }>(sql`
          insert into tra_tasks (case_id, phase_id, position, name, assignee_id, due_override, due_anchor)
          values (${id}, ${body.phaseId},
                  (select coalesce(max(position), 0) + 1 from tra_tasks where phase_id = ${body.phaseId}),
                  ${body.name}, ${body.assigneeId ?? null}, ${body.dueOverride ?? null}, 'apertura')
          returning id`);
        const taskId = created.rows[0]!.id;
        for (const dependency of body.dependsOn ?? []) {
          await tx.execute(sql`
            insert into tra_task_deps (task_id, depends_on_id)
            select ${taskId}, id from tra_tasks where id = ${dependency} and case_id = ${id}`);
        }
        await recordEvent(tx, {
          caseId: id,
          taskId,
          userId: user.id,
          kind: "creada",
          detail: { name: body.name },
        });
      });
      await touched(kase, user.id, "task_added", { name: body.name });
      return viewOf(user.id, id);
    });

    app.put("/tasks/:id/deps", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { dependsOn } = depsBody.parse(request.body);
      const { task, kase } = await loadOwnTask(user.id, id);
      const data = (await loadPlans(db, [task.caseId])).get(task.caseId)!;
      const ids = new Set(data.tasks.map((entry) => entry.id));
      if (dependsOn.some((entry) => !ids.has(entry) || entry === id)) throw notFound();
      try {
        assertAcyclic(
          data.tasks.map((entry) => ({
            id: entry.id,
            name: entry.name,
            dependsOn: entry.id === id ? dependsOn : entry.dependsOn,
          })),
        );
      } catch (error) {
        if (error instanceof CycleError) throw new HttpError(400, "cycle", error.message);
        throw error;
      }
      await db.transaction(async (tx) => {
        await tx.execute(sql`delete from tra_task_deps where task_id = ${id}`);
        for (const dependency of dependsOn) {
          await tx.execute(
            sql`insert into tra_task_deps (task_id, depends_on_id) values (${id}, ${dependency})`,
          );
        }
        await recordEvent(tx, {
          caseId: task.caseId,
          taskId: id,
          userId: user.id,
          kind: "plazo",
          detail: { dependsOn },
        });
      });
      await touched(kase, user.id, "task_deps", { taskId: id });
      return viewOf(user.id, task.caseId);
    });

    // Solo se quitan las tareas añadidas a mano; las de la plantilla se marcan «no aplica».
    app.delete("/tasks/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { task, kase } = await loadOwnTask(user.id, id);
      if (task.key)
        throw new HttpError(
          409,
          "from_template",
          "Esta tarea viene de la plantilla: márcala «no aplica».",
        );
      await db.execute(sql`delete from tra_tasks where id = ${id}`);
      await recordEvent(db, {
        caseId: task.caseId,
        userId: user.id,
        kind: "nota",
        detail: { text: `Tarea quitada: ${task.name}` },
      });
      await touched(kase, user.id, "task_removed", { name: task.name });
      return viewOf(user.id, task.caseId);
    });

    // ------------------------------------------------------------ intervinientes

    app.post("/cases/:id/parties", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const body = partyBody.parse(request.body);
      const kase = await loadCase(user.id, id);
      const known = await db.execute(sql`select 1 from tra_contacts where id = ${body.contactId}`);
      if (known.rows.length === 0) throw notFound();
      await db.execute(sql`
        insert into tra_case_parties (case_id, contact_id, role, reference)
        values (${id}, ${body.contactId}, ${body.role}, ${body.reference ?? null})
        on conflict (case_id, contact_id, role) do update set reference = excluded.reference`);
      await touched(kase, user.id, "party_added", body);
      return viewOf(user.id, id);
    });

    app.delete("/cases/:id/parties/:contactId", async (request) => {
      const { user } = requireSession(request);
      const { id, contactId } = partyParams.parse(request.params);
      const kase = await loadCase(user.id, id);
      await db.execute(
        sql`delete from tra_case_parties where case_id = ${id} and contact_id = ${contactId}`,
      );
      await touched(kase, user.id, "party_removed", { contactId });
      return viewOf(user.id, id);
    });

    // ------------------------------------------------------------ cierre

    app.post("/cases/:id/close", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { reason, force } = closeBody.parse(request.body);
      const kase = await loadCase(user.id, id);
      const open = await db.execute<{ id: string; name: string }>(sql`
        select id, name from tra_tasks where case_id = ${id} and status not in ('hecha', 'omitida') order by position`);
      if (open.rows.length > 0 && !force) {
        return { closed: false, openTasks: open.rows };
      }
      await db.transaction(async (tx) => {
        // Lo que quedaba abierto ya no aplica: el expediente se ha resuelto de otra forma.
        await tx.execute(sql`
          update tra_tasks set status = 'omitida', updated_at = now()
           where case_id = ${id} and status not in ('hecha', 'omitida')`);
        await closeCase(tx, id, user.id, reason);
        await recordEvent(tx, {
          caseId: id,
          userId: user.id,
          kind: "cierre",
          detail: { reason, openTasks: open.rows.length },
        });
      });
      await touched(kase, user.id, "case_closed", { reason });
      return { closed: true, ...(await viewOf(user.id, id)) };
    });

    // ------------------------------------------------------------ vistas de trabajo

    async function visibleCases(userId: string, where: ReturnType<typeof sql>) {
      const accountIds = await accessibleAccountIds(db, userId);
      if (accountIds.length === 0) return [];
      const ids = sql.join(
        accountIds.map((entry) => sql`${entry}::uuid`),
        sql`, `,
      );
      return (
        await db.execute<CaseRow>(sql`
          select ${caseColumns} from exp_cases c
           where c.account_id in (${ids}) and exists (select 1 from tra_case_plans p where p.case_id = c.id)
             and ${where}`)
      ).rows;
    }

    app.get("/portfolio", async (request) => {
      const { user } = requireSession(request);
      const query = portfolioQuery.parse(request.query);
      const status =
        query.estado === "todos"
          ? sql`true`
          : query.estado === "cerrados"
            ? sql`c.status = 'cerrado'`
            : sql`c.status = 'abierto'`;
      const cases = await visibleCases(
        user.id,
        sql`${status}
        and (${query.gestor ?? null}::uuid is null or c.owner_id = ${query.gestor ?? null})
        and (${query.tipo ?? null}::uuid is null or c.case_type_id = ${query.tipo ?? null})`,
      );
      const plans = await loadPlans(
        db,
        cases.map((entry) => entry.id),
      );
      const today = todayInSpain();
      const counts: Record<string, number> = { vencidas: 0, parado: 0, riesgo: 0, al_dia: 0 };
      const rows = cases.map((row) => {
        const data = plans.get(row.id)!;
        const summary = summarizeCase(engineCase(row), data, today);
        counts[summary.health.level] = (counts[summary.health.level] ?? 0) + 1;
        const waits = summary.tasks.filter((task) => task.state === "esperando");
        const longest = waits
          .map((task) => ({ task, raw: summary.taskRows.get(task.id)! }))
          .sort((a, b) => (a.raw.waitingSince ?? "").localeCompare(b.raw.waitingSince ?? ""))[0];
        const nextDue = summary.tasks
          .filter((task) => task.due && !["hecha", "omitida"].includes(task.state))
          .sort((a, b) => a.due!.localeCompare(b.due!))[0];
        return {
          case: row,
          health: summary.health,
          nextStep: summary.nextStep,
          currentPhase: summary.currentPhase,
          phases: summary.phases.map((phase) => ({ name: phase.name, state: phase.state })),
          waiting: longest
            ? {
                who: waitingLabel(longest.raw),
                client: longest.raw.waitingClient,
                days: longest.raw.waitingSince ? daysBetween(longest.raw.waitingSince, today) : 0,
                chaseDue: longest.task.chaseDue,
              }
            : null,
          nextDue: nextDue
            ? {
                name: nextDue.name,
                due: nextDue.due,
                lateDays: nextDue.lateDays,
                dueSoon: nextDue.dueSoon,
                legal: nextDue.legalRef !== null,
              }
            : null,
          assignees: [
            ...new Set(
              data.tasks
                .filter((task) => !["hecha", "omitida"].includes(task.status))
                .map((task) => task.assigneeId)
                .filter(Boolean),
            ),
          ],
        };
      });
      const filtered = rows.filter(
        (row) =>
          (!query.salud || row.health.level === query.salud) &&
          (!query.responsable || row.assignees.includes(query.responsable)) &&
          (!query.parados || row.health.idleDays >= query.parados) &&
          (!query.esperando ||
            (row.waiting !== null &&
              (query.esperando === "cliente" ? row.waiting.client : !row.waiting.client))),
      );
      filtered.sort(
        (a, b) =>
          (SEVERITY[a.health.level] ?? 9) - (SEVERITY[b.health.level] ?? 9) ||
          b.health.idleDays - a.health.idleDays ||
          a.case.number.localeCompare(b.case.number),
      );
      return { today, total: rows.length, counts, cases: filtered };
    });

    app.get("/my-tasks", async (request) => {
      const { user } = requireSession(request);
      const cases = await visibleCases(user.id, sql`c.status = 'abierto'`);
      const plans = await loadPlans(
        db,
        cases.map((entry) => entry.id),
      );
      const today = todayInSpain();
      const week = addCalendarDays(today, 7);
      const groups = {
        vencidas: [] as unknown[],
        hoy: [] as unknown[],
        semana: [] as unknown[],
        despues: [] as unknown[],
        esperando: [] as unknown[],
      };
      for (const row of cases) {
        const summary = summarizeCase(engineCase(row), plans.get(row.id)!, today);
        for (const task of summary.tasks) {
          if (task.assigneeId !== user.id || ["hecha", "omitida", "bloqueada"].includes(task.state))
            continue;
          const raw = summary.taskRows.get(task.id)!;
          const entry = {
            taskId: task.id,
            name: task.name,
            state: task.state,
            due: task.due,
            lateDays: task.lateDays,
            dueSoon: task.dueSoon,
            legal: task.legalRef !== null,
            waitingOn: waitingLabel(raw),
            waitingDays: raw.waitingSince ? daysBetween(raw.waitingSince, today) : null,
            chaseAt: raw.chaseAt,
            chaseDue: task.chaseDue,
            case: { id: row.id, number: row.number, title: row.title },
          };
          if (task.state === "esperando") groups.esperando.push(entry);
          else if (task.lateDays > 0) groups.vencidas.push(entry);
          else if (task.due === today) groups.hoy.push(entry);
          else if (task.due && task.due <= week) groups.semana.push(entry);
          else groups.despues.push(entry);
        }
      }
      return { today, groups };
    });

    // Quién puede llevar las tareas de un expediente: quien tiene su buzón.
    app.get("/people", async (request) => {
      const { user } = requireSession(request);
      const query = peopleQuery.parse(request.query);
      let accountId = query.accountId ?? null;
      if (query.caseId) accountId = (await loadCase(user.id, query.caseId)).accountId;
      else await assertAccess(db, user.id, accountId!);
      const rows = await db.execute(sql`
        select u.id, u.name, u.email from users u join account_access a on a.user_id = u.id
         where a.account_id = ${accountId} order by u.name`);
      return { people: rows.rows };
    });

    // Para el panel de contexto de un correo: sus expedientes en tramitación y si el
    // remitente es alguien a quien se esperaba.
    app.get("/by-message/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const [message] = await db.select().from(messages).where(eq(messages.id, id));
      if (!message) throw notFound();
      await assertAccess(db, user.id, message.accountId);
      const caseIds = (
        await db.execute<{ caseId: string }>(sql`
          select distinct cm.case_id as "caseId" from exp_case_messages cm
            join tra_case_plans p on p.case_id = cm.case_id where cm.message_id = ${id}`)
      ).rows.map((row) => row.caseId);
      const plans = await loadPlans(db, caseIds);
      const today = todayInSpain();
      const from = message.fromAddress.toLowerCase();
      const result = [];
      for (const caseId of caseIds) {
        const row = (
          await db.execute<CaseRow>(
            sql`select ${caseColumns} from exp_cases c where c.id = ${caseId}`,
          )
        ).rows[0]!;
        const accountIds = await accessibleAccountIds(db, user.id);
        if (!accountIds.includes(row.accountId)) continue;
        const summary = summarizeCase(engineCase(row), plans.get(caseId)!, today);
        const awaited = [...summary.taskRows.values()].find(
          (task) => task.status === "esperando" && task.waitingContactEmail?.toLowerCase() === from,
        );
        result.push({
          case: row,
          health: summary.health,
          nextStep: summary.nextStep,
          currentPhase: summary.currentPhase,
          phases: summary.phases.map((phase) => ({ name: phase.name, state: phase.state })),
          awaited: awaited
            ? {
                taskId: awaited.id,
                taskName: awaited.name,
                who: waitingLabel(awaited),
                days: awaited.waitingSince ? daysBetween(awaited.waitingSince, today) : 0,
              }
            : null,
        });
      }
      return { cases: result };
    });
  },
};
