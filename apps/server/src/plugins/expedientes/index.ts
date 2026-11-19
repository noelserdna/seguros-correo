import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../../db/client.ts";
import { events, messages } from "../../db/schema.ts";
import { accessibleAccountIds, assertAccess } from "../../http/access.ts";
import { audit, HttpError, notFound, requireAdmin, requireSession } from "../../http/app.ts";
import { approxTokens } from "../../mail/clean.ts";
import type { MailEvent, ServerPlugin } from "../host.ts";

/**
 * Módulo de expedientes: agrupa correos de cualquier buzón, con los datos del siniestro
 * (tipo, fecha, número de la aseguradora, gestor) y su estado. La tramitación, si está
 * activa, se apoya en él.
 */

export const CLOSE_REASONS = [
  "pagado",
  "rehusado",
  "desistido",
  "judicializado",
  "duplicado",
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

const REFERENCE = /EXP-\d{4}-\d{4}/i;

export type CaseRow = {
  id: string;
  accountId: string;
  number: string;
  title: string;
  createdAt: Date;
  createdBy: string | null;
  insurerId: string | null;
  insurerName: string | null;
  caseTypeId: string | null;
  typeName: string | null;
  status: "abierto" | "cerrado";
  closedAt: Date | null;
  closeReason: CloseReason | null;
  ownerId: string | null;
  ownerName: string | null;
  /** Fecha del siniestro, `AAAA-MM-DD`: los plazos legales cuentan desde aquí. */
  lossDate: string | null;
  /** Número de siniestro que da la aseguradora: sirve para reconocer sus correos. */
  claimRef: string | null;
};
type CaseMessage = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: Date;
  how: string;
  /** Sigue en el expediente, pero no cuenta como contexto. */
  excluded: boolean;
  /** Buzón en el que está el correo: un expediente puede reunir correos de varios. */
  mailbox: string;
  direction: "in" | "out" | null;
  snippet: string | null;
  files: number;
  /** Llegó por WhatsApp (dirección «<teléfono>@whatsapp.invalid»). */
  whatsapp: boolean;
  /** Papel de quien escribe según la agenda (cliente, aseguradora…), si el módulo está activo. */
  role: string | null;
  /** Entró solo en el expediente después de la última vez que esta persona lo miró. */
  isNew: boolean;
};

/** Cuándo miró cada persona cada expediente: lo que entró después cuenta como nuevo. */
async function setupSeen(db: Db): Promise<void> {
  const exists = await db.execute<{ ok: boolean }>(
    sql`select to_regclass('exp_case_seen') is not null as ok`,
  );
  await db.execute(sql`
    create table if not exists exp_case_seen (
      user_id uuid not null,
      case_id uuid not null references exp_cases(id) on delete cascade,
      seen_at timestamptz not null default now(),
      primary key (user_id, case_id)
    )`);
  // La primera vez, todo lo que ya había se da por visto: no se estrena con cientos de nuevos.
  if (!exists.rows[0]?.ok) {
    await db.execute(sql`
      insert into exp_case_seen (user_id, case_id) select u.id, c.id from users u cross join exp_cases c
      on conflict do nothing`);
  }
}

/**
 * Un correo del expediente es nuevo para una persona si entró solo (por su conversación o por
 * un número) y recibido, después de la última vez que ella miró el expediente. Lo añadido a mano
 * o como prueba ya lo decidió alguien.
 */
const isNewSql = (userId: string) => sql`(cm.how not in ('manual', 'prueba')
  and coalesce(m.direction, 'in') <> 'out'
  and cm.added_at > coalesce((select s.seen_at from exp_case_seen s
                               where s.user_id = ${userId} and s.case_id = cm.case_id),
                             (select c0.created_at + interval '1 minute' from exp_cases c0 where c0.id = cm.case_id)))`;

/** El papel de quien escribe según la agenda, si el módulo de contactos está activo. */
async function roleSql(db: Db) {
  const ok = await db.execute<{ ok: boolean }>(
    sql`select to_regclass('ct_channels') is not null as ok`,
  );
  if (!ok.rows[0]?.ok) return sql`null::text`;
  return sql`(select r.role from ct_channels ch join ct_roles r on r.contact_id = ch.contact_id
                where (ch.kind = 'email' and ch.value = lower(m.from_address))
                   or (ch.kind = 'phone' and ch.value || '@whatsapp.invalid' = lower(m.from_address))
                order by r.role = 'cliente' desc, r.role limit 1)`;
}

async function setup(db: Db): Promise<void> {
  // El módulo se llamó «demo» mientras fue una prueba: se conserva lo que hubiera con ese nombre.
  for (const rename of [
    sql`alter table if exists demo_cases rename to exp_cases`,
    sql`alter table if exists demo_case_messages rename to exp_case_messages`,
    sql`alter table if exists demo_insurers rename to exp_insurers`,
    sql`alter sequence if exists demo_case_seq rename to exp_case_seq`,
    sql`alter index if exists demo_case_messages_pair rename to exp_case_messages_pair`,
    sql`alter index if exists demo_case_messages_message rename to exp_case_messages_message`,
    sql`alter index if exists demo_insurers_name rename to exp_insurers_name`,
    sql`update event_cursors set consumer = 'plugin:expedientes' where consumer = 'plugin:demo'`,
  ]) {
    await db.execute(rename);
  }
  await db.execute(sql`
    create table if not exists exp_cases (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null references accounts(id) on delete cascade,
      number text not null unique,
      title text not null,
      created_by uuid,
      created_at timestamptz not null default now()
    )`);
  await db.execute(sql`
    create table if not exists exp_case_messages (
      message_id uuid not null references messages(id) on delete cascade,
      case_id uuid not null references exp_cases(id) on delete cascade,
      how text not null,
      added_by uuid,
      added_at timestamptz not null default now()
    )`);
  // Un correo puede pertenecer a varios expedientes (antes, solo a uno).
  await db.execute(
    sql`alter table exp_case_messages drop constraint if exists exp_case_messages_pkey`,
  );
  await db.execute(sql`alter table exp_case_messages add column if not exists added_by uuid`);
  await db.execute(sql`
    create unique index if not exists exp_case_messages_pair
      on exp_case_messages (case_id, message_id)`);
  await db.execute(sql`
    create index if not exists exp_case_messages_message on exp_case_messages (message_id)`);
  await db.execute(sql`create sequence if not exists exp_case_seq`);

  // Un correo puede seguir en el expediente y quedar fuera del contexto (lo que se lee
  // para resumir o conversar sobre el expediente).
  await db.execute(sql`
    alter table exp_case_messages
      add column if not exists excluded boolean not null default false,
      add column if not exists excluded_by uuid,
      add column if not exists excluded_at timestamptz`);

  // Primer dato del expediente que no viene de un correo: la aseguradora, de un catálogo propio.
  await db.execute(sql`
    create table if not exists exp_insurers (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      created_at timestamptz not null default now()
    )`);
  await db.execute(sql`
    create unique index if not exists exp_insurers_name on exp_insurers (lower(name))`);
  await db.execute(sql`
    alter table exp_cases
      add column if not exists insurer_id uuid references exp_insurers(id) on delete set null`);

  // Tipos de expediente: catálogo como el de aseguradoras. De él cuelgan las plantillas de
  // tramitación.
  await db.execute(sql`
    create table if not exists exp_case_types (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      created_at timestamptz not null default now()
    )`);
  await db.execute(sql`
    create unique index if not exists exp_case_types_name on exp_case_types (lower(name))`);
  await db.execute(sql`
    insert into exp_case_types (name) values ('Siniestro de automóvil con atestado')
    on conflict do nothing`);

  // Datos del siniestro y estado del expediente.
  await db.execute(sql`
    alter table exp_cases
      add column if not exists case_type_id uuid references exp_case_types(id) on delete set null,
      add column if not exists status text not null default 'abierto',
      add column if not exists closed_at timestamptz,
      add column if not exists closed_by uuid,
      add column if not exists close_reason text,
      add column if not exists owner_id uuid references users(id) on delete set null,
      add column if not exists loss_date date,
      add column if not exists claim_ref text`);
  await setupSeen(db);
}

/**
 * Abre un expediente a partir de un correo, con toda su conversación. Va dentro de una
 * transacción para que otro módulo (la tramitación) pueda aplicar su plan en la misma.
 */
export async function createCaseFromMessage(
  tx: Tx,
  input: {
    message: { id: string; accountId: string; threadId: string; subject: string };
    userId: string;
    title?: string | undefined;
    caseTypeId?: string | null | undefined;
    ownerId?: string | null | undefined;
    lossDate?: string | null | undefined;
    claimRef?: string | null | undefined;
    insurerId?: string | null | undefined;
  },
): Promise<CaseRow> {
  const { message } = input;
  const next = await tx.execute<{ n: string }>(sql`select nextval('exp_case_seq') as n`);
  const number = `EXP-${new Date().getFullYear()}-${String(next.rows[0]!.n).padStart(4, "0")}`;
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into exp_cases (account_id, number, title, created_by, case_type_id, owner_id,
                           loss_date, claim_ref, insurer_id)
    values (${message.accountId}, ${number}, ${input.title || message.subject || "(sin asunto)"},
            ${input.userId}, ${input.caseTypeId ?? null}, ${input.ownerId ?? input.userId},
            ${input.lossDate ?? null}, ${input.claimRef ?? null}, ${input.insurerId ?? null})
    returning id`);
  const id = inserted.rows[0]!.id;
  await tx.execute(sql`
    insert into exp_case_messages (message_id, case_id, how, added_by)
    select m.id, ${id}, case when m.id = ${message.id} then 'manual' else 'thread' end,
           ${input.userId}
      from messages m
     where m.thread_id = ${message.threadId} and m.account_id = ${message.accountId}
    on conflict do nothing`);
  const found = await tx.execute<CaseRow>(
    sql`select ${caseColumns} from exp_cases c where c.id = ${id}`,
  );
  return found.rows[0]!;
}

export const caseColumns = sql`c.id, c.account_id as "accountId", c.number, c.title,
  c.created_at as "createdAt", c.created_by as "createdBy",
  c.insurer_id as "insurerId",
  (select i.name from exp_insurers i where i.id = c.insurer_id) as "insurerName",
  c.case_type_id as "caseTypeId",
  (select t.name from exp_case_types t where t.id = c.case_type_id) as "typeName",
  c.status, c.closed_at as "closedAt", c.close_reason as "closeReason",
  c.owner_id as "ownerId", (select u.name from users u where u.id = c.owner_id) as "ownerName",
  to_char(c.loss_date, 'YYYY-MM-DD') as "lossDate", c.claim_ref as "claimRef"`;

async function casesOfMessage(db: Db, messageId: string): Promise<CaseRow[]> {
  const found = await db.execute<CaseRow>(sql`
    select ${caseColumns} from exp_cases c
      join exp_case_messages cm on cm.case_id = c.id
     where cm.message_id = ${messageId}
     order by c.created_at`);
  return found.rows;
}

const uuids = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/**
 * Correos del expediente. La copia de Enviados y la recibida de un mismo correo
 * (misma cabecera Message-ID) cuentan como uno: se enseña el añadido a mano si lo hay.
 */
const messagesOfCase = async (db: Db, caseId: string, accountIds: string[], userId?: string) =>
  accountIds.length === 0
    ? []
    : (
        await db.execute<CaseMessage>(sql`
          select * from (
            select distinct on (coalesce(m.message_id_header, m.id::text))
                   m.id, m.subject, m.from_name as "fromName", m.from_address as "fromAddress",
                   m.internal_date as "internalDate", cm.how, cm.excluded, cm.added_at,
                   a.email as "mailbox", m.account_id as "accountId", m.direction, m.snippet,
                   (select count(*)::int from attachments x where x.message_id = m.id and not x.inline) as files,
                   (lower(m.from_address) like '%@whatsapp.invalid'
                     or exists (select 1 from message_addresses ma where ma.message_id = m.id
                                  and lower(ma.address) like '%@whatsapp.invalid')) as whatsapp,
                   ${await roleSql(db)} as role,
                   ${userId ? isNewSql(userId) : sql`false`} as "isNew"
              from exp_case_messages cm
              join messages m on m.id = cm.message_id
              join accounts a on a.id = m.account_id
             where cm.case_id = ${caseId} and m.account_id in (${uuids(accountIds)})
             order by coalesce(m.message_id_header, m.id::text),
                      (cm.how = 'manual') desc, m.internal_date
          ) unique_messages
          order by "internalDate", added_at`)
      ).rows;

/**
 * Quién ve un expediente: quien tiene su buzón de origen o el de alguno de sus correos, lo haya
 * creado o no. Condición SQL sobre el expediente con alias `alias`.
 */
export const caseVisible = (alias: "c" | "e", accountIds: string[]) =>
  accountIds.length === 0
    ? sql`false`
    : sql`(${sql.raw(alias)}.account_id in (${uuids(accountIds)})
           or exists (select 1 from exp_case_messages vcm join messages vm on vm.id = vcm.message_id
                       where vcm.case_id = ${sql.raw(alias)}.id and vm.account_id in (${uuids(accountIds)})))`;

/** Como `assertAccess`, pero para un expediente: si no lo ve, como si no existiera. */
export async function assertCaseAccess(
  db: Db,
  userId: string,
  row: { id: string; accountId: string },
): Promise<void> {
  const accountIds = await accessibleAccountIds(db, userId);
  if (accountIds.includes(row.accountId)) return;
  const seen =
    accountIds.length === 0
      ? { rows: [] }
      : await db.execute(sql`
          select 1 from exp_case_messages cm join messages m on m.id = cm.message_id
           where cm.case_id = ${row.id} and m.account_id in (${uuids(accountIds)}) limit 1`);
  if (seen.rows.length === 0) throw notFound();
}

/** Cierra el expediente. Lo usa también la tramitación, que antes comprueba sus tareas. */
export async function closeCase(db: Db | Tx, caseId: string, userId: string, reason: CloseReason) {
  await db.execute(sql`
    update exp_cases set status = 'cerrado', closed_at = now(), closed_by = ${userId},
           close_reason = ${reason}
     where id = ${caseId}`);
}

/** Aviso para que las pantallas abiertas se refresquen. */
export const notify = (db: Db | Tx, accountId: string, messageId?: string) =>
  db.insert(events).values({ accountId, type: "account.changed", messageId });

/**
 * Un correo nuevo entra solo en un expediente si pertenece a una conversación que ya
 * está en uno, o si su asunto lleva el número de un expediente del mismo buzón.
 */
async function onEvent(event: MailEvent, db: Db): Promise<void> {
  // También al terminar de procesarse: en un buzón grande el texto llega después que el aviso
  // de correo nuevo, y el número de siniestro puede ir en el texto. Insertar dos veces no
  // repite nada.
  if ((event.type !== "message.received" && event.type !== "message.enriched") || !event.messageId)
    return;
  const [message] = await db.select().from(messages).where(eq(messages.id, event.messageId));
  if (!message) return;
  // Un borrador (lo que se está escribiendo, guardado en Borradores) todavía no es un correo
  // del caso: entrará cuando se envíe. Si no, la respuesta aparecería dos veces en la historia.
  const where = await db.execute<{ drafts: boolean }>(sql`
    select coalesce(bool_and(f.special_use = 'drafts'), false) as drafts
      from folder_messages fm join folders f on f.id = fm.folder_id
     where fm.message_id = ${message.id} and fm.gone_at is null`);
  if (where.rows[0]?.drafts) return;

  // Por conversación: entra en todos los expedientes que ya tengan un correo de su hilo.
  const byThread = await db.execute<{ caseId: string }>(sql`
    select distinct cm.case_id as "caseId" from exp_case_messages cm
      join messages m on m.id = cm.message_id
     where m.thread_id = ${message.threadId} and m.id <> ${message.id}`);
  const targets = byThread.rows.map((row) => ({ caseId: row.caseId, how: "thread" }));

  // Por el número del expediente en el asunto: da igual a qué buzón llegue.
  if (targets.length === 0) {
    const reference = REFERENCE.exec(message.subject)?.[0].toUpperCase();
    if (reference) {
      const byNumber = await db.execute<{ id: string }>(
        sql`select id from exp_cases where number = ${reference}`,
      );
      if (byNumber.rows[0]) targets.push({ caseId: byNumber.rows[0].id, how: "reference" });
    }
  }
  // Por el número de siniestro de la aseguradora, en el asunto o en el texto.
  if (targets.length === 0) {
    const text = `${message.subject}\n${message.bodyText ?? ""}`.toLowerCase();
    const byClaim = await db.execute<{ id: string }>(sql`
      select id from exp_cases
       where claim_ref is not null and length(claim_ref) >= 5 and status = 'abierto'
         and strpos(${text}, lower(claim_ref)) > 0`);
    for (const row of byClaim.rows) targets.push({ caseId: row.id, how: "claim" });
  }
  if (targets.length === 0) return;
  let added = 0;
  for (const target of targets) {
    const inserted = await db.execute(sql`
      insert into exp_case_messages (message_id, case_id, how)
      values (${message.id}, ${target.caseId}, ${target.how}) on conflict do nothing
      returning case_id`);
    added += inserted.rows.length;
  }
  if (added > 0) await notify(db, message.accountId, message.id);
}

const idParams = z.object({ id: z.uuid() });
const createBody = z.object({ messageId: z.uuid() });
const labelsBody = z.object({ messageIds: z.array(z.uuid()).max(500) });
const listQuery = z.object({
  accountId: z.uuid().optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(["abierto", "cerrado", "todos"]).optional(),
  mine: z.enum(["0", "1"]).optional(),
  noPlan: z.enum(["0", "1"]).optional(),
});

const memberParams = z.object({ id: z.uuid(), messageId: z.uuid() });
const excludeBody = z.object({ excluded: z.boolean() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha con formato AAAA-MM-DD.");
const caseBody = z
  .object({
    insurerId: z.uuid().nullable(),
    caseTypeId: z.uuid().nullable(),
    ownerId: z.uuid().nullable(),
    lossDate: day.nullable(),
    claimRef: z.string().trim().max(60).nullable(),
    title: z.string().trim().min(1).max(200),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "No hay nada que cambiar.");
const closeBody = z.object({ reason: z.enum(CLOSE_REASONS) });
const createFullBody = z.object({
  messageId: z.uuid(),
  caseTypeId: z.uuid().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  lossDate: day.nullable().optional(),
  claimRef: z.string().trim().max(60).nullable().optional(),
  insurerId: z.uuid().nullable().optional(),
  title: z.string().trim().max(200).optional(),
});
const insurerBody = z.object({ name: z.string().trim().min(1).max(120) });

export const expedientesPlugin: ServerPlugin = {
  id: "expedientes",
  name: "Expedientes",
  description:
    "Agrupa correos de cualquier buzón en expedientes, con su aseguradora y la medida de su contexto.",
  setup,
  onEvent,
  routes: async (app, { context }) => {
    const { db } = context;

    /** El expediente, si el usuario tiene el buzón en el que se abrió. */
    async function loadCase(userId: string, id: string): Promise<CaseRow> {
      const found = await db.execute<CaseRow>(
        sql`select ${caseColumns} from exp_cases c where c.id = ${id}`,
      );
      const row = found.rows[0];
      if (!row) throw notFound();
      await assertCaseAccess(db, userId, row);
      return row;
    }

    async function loadMessage(userId: string, id: string) {
      const [message] = await db.select().from(messages).where(eq(messages.id, id));
      if (!message) throw notFound();
      await assertAccess(db, userId, message.accountId);
      return message;
    }

    /** Lo que se asigna tiene que existir; el gestor, además, ver el buzón del expediente. */
    async function checkReferences(
      userId: string,
      accountId: string,
      body: { insurerId?: string | null; caseTypeId?: string | null; ownerId?: string | null },
    ) {
      if (body.insurerId) {
        const known = await db.execute(
          sql`select 1 from exp_insurers where id = ${body.insurerId}`,
        );
        if (known.rows.length === 0) throw notFound();
      }
      if (body.caseTypeId) {
        const known = await db.execute(
          sql`select 1 from exp_case_types where id = ${body.caseTypeId}`,
        );
        if (known.rows.length === 0) throw notFound();
      }
      if (body.ownerId && body.ownerId !== userId) {
        const allowed = await db.execute(sql`
          select 1 from account_access where user_id = ${body.ownerId} and account_id = ${accountId}`);
        if (allowed.rows.length === 0) {
          throw new HttpError(
            400,
            "owner_without_access",
            "Esa persona no tiene acceso a este buzón.",
          );
        }
      }
    }

    // Crear un expediente a partir de un correo: entra con toda su conversación.
    app.post("/cases", async (request) => {
      const { user } = requireSession(request);
      const body = createFullBody.parse(request.body);
      const { messageId } = body;
      const message = await loadMessage(user.id, messageId);
      await checkReferences(user.id, message.accountId, body);

      const created = await db.transaction((tx) =>
        createCaseFromMessage(tx, { ...body, message, userId: user.id }),
      );
      await audit(db, {
        userId: user.id,
        accountId: message.accountId,
        action: "plugin.expedientes.case_created",
        target: created.id,
        detail: { number: created.number, messageId },
      });
      await notify(db, message.accountId, messageId);
      return { case: created, created: true };
    });

    // Añadir a un expediente cualquier correo que el usuario pueda ver, sea del buzón que sea.
    // Quitar después uno suelto es una excepción: el resto de la conversación se queda.
    app.post("/cases/:id/messages", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { messageId } = createBody.parse(request.body);
      const row = await loadCase(user.id, id);
      const message = await loadMessage(user.id, messageId);
      // Entra con toda su conversación, igual que al crear el expediente.
      const added = await db.execute(sql`
        insert into exp_case_messages (message_id, case_id, how, added_by)
        select m.id, ${id}, case when m.id = ${messageId} then 'manual' else 'thread' end,
               ${user.id}
          from messages m
         where m.thread_id = ${message.threadId} and m.account_id = ${message.accountId}
        on conflict do nothing returning message_id`);
      if (added.rows.length > 0) {
        await audit(db, {
          userId: user.id,
          accountId: message.accountId,
          action: "plugin.expedientes.message_added",
          target: id,
          detail: { number: row.number, messageId },
        });
        await notify(db, message.accountId, messageId);
      }
      return { case: row, added: added.rows.length > 0, count: added.rows.length };
    });

    // Quitar del expediente: sale la conversación entera, porque un hilo entra o no entra.
    // Los correos no se tocan: solo dejan de estar agrupados.
    app.delete("/cases/:id/messages/:messageId", async (request) => {
      const { user } = requireSession(request);
      const { id, messageId } = memberParams.parse(request.params);
      const row = await loadCase(user.id, id);
      const message = await loadMessage(user.id, messageId);
      const removed = await db.execute(sql`
        delete from exp_case_messages cm using messages m
         where cm.case_id = ${id} and m.id = cm.message_id
           and (m.id = ${messageId}
                or (m.thread_id = ${message.threadId} and m.account_id = ${message.accountId}))
        returning cm.message_id`);
      if (removed.rows.length === 0) throw notFound();
      await audit(db, {
        userId: user.id,
        accountId: message.accountId,
        action: "plugin.expedientes.thread_removed",
        target: id,
        detail: { number: row.number, messageId, count: removed.rows.length },
      });
      await notify(db, message.accountId, messageId);
      return { ok: true, count: removed.rows.length };
    });

    // Dejar un correo fuera del contexto del expediente, o volver a incluirlo.
    app.put("/cases/:id/messages/:messageId", async (request) => {
      const { user } = requireSession(request);
      const { id, messageId } = memberParams.parse(request.params);
      const { excluded } = excludeBody.parse(request.body);
      const row = await loadCase(user.id, id);
      const message = await loadMessage(user.id, messageId);
      const changed = await db.execute(sql`
        update exp_case_messages
           set excluded = ${excluded},
               excluded_by = ${excluded ? user.id : null},
               excluded_at = ${excluded ? sql`now()` : null}
         where case_id = ${id} and message_id = ${messageId} returning message_id`);
      if (changed.rows.length === 0) throw notFound();
      await audit(db, {
        userId: user.id,
        accountId: message.accountId,
        action: excluded
          ? "plugin.expedientes.message_excluded"
          : "plugin.expedientes.message_included",
        target: id,
        detail: { number: row.number, messageId },
      });
      await notify(db, message.accountId, messageId);
      return { ok: true, excluded };
    });

    // Datos del expediente: solo cambia lo que se manda.
    app.put("/cases/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const body = caseBody.parse(request.body);
      const row = await loadCase(user.id, id);
      await checkReferences(user.id, row.accountId, body);
      const columns: Record<keyof typeof body, string> = {
        insurerId: "insurer_id",
        caseTypeId: "case_type_id",
        ownerId: "owner_id",
        lossDate: "loss_date",
        claimRef: "claim_ref",
        title: "title",
      };
      const sets = (Object.keys(body) as (keyof typeof body)[]).map(
        (key) => sql`${sql.identifier(columns[key])} = ${body[key] || null}`,
      );
      await db.execute(sql`update exp_cases set ${sql.join(sets, sql`, `)} where id = ${id}`);
      await audit(db, {
        userId: user.id,
        accountId: row.accountId,
        action: "plugin.expedientes.case_updated",
        target: id,
        detail: { number: row.number, ...body },
      });
      await notify(db, row.accountId);
      return { case: await loadCase(user.id, id) };
    });

    // Cerrar con un motivo, y reabrir.
    app.post("/cases/:id/close", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { reason } = closeBody.parse(request.body);
      const row = await loadCase(user.id, id);
      await closeCase(db, id, user.id, reason);
      await audit(db, {
        userId: user.id,
        accountId: row.accountId,
        action: "plugin.expedientes.case_closed",
        target: id,
        detail: { number: row.number, reason },
      });
      await notify(db, row.accountId);
      return { case: await loadCase(user.id, id) };
    });

    app.post("/cases/:id/reopen", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const row = await loadCase(user.id, id);
      await db.execute(sql`
        update exp_cases set status = 'abierto', closed_at = null, closed_by = null, close_reason = null
         where id = ${id}`);
      await audit(db, {
        userId: user.id,
        accountId: row.accountId,
        action: "plugin.expedientes.case_reopened",
        target: id,
        detail: { number: row.number },
      });
      await notify(db, row.accountId);
      return { case: await loadCase(user.id, id) };
    });

    // Catálogo de tipos de expediente. Lo lee cualquiera; lo cambia un administrador.
    app.get("/case-types", async (request) => {
      requireSession(request);
      const rows = await db.execute(sql`
        select t.id, t.name,
               (select count(*)::int from exp_cases c where c.case_type_id = t.id) as "caseCount"
          from exp_case_types t order by lower(t.name)`);
      return { caseTypes: rows.rows };
    });

    app.post("/case-types", async (request) => {
      const { user } = requireAdmin(request);
      const { name } = insurerBody.parse(request.body);
      const created = await db.execute<{ id: string; name: string }>(sql`
        insert into exp_case_types (name) values (${name})
        on conflict do nothing returning id, name`);
      if (!created.rows[0]) {
        throw new HttpError(409, "duplicate", "Ya hay un tipo de expediente con ese nombre.");
      }
      await audit(db, {
        userId: user.id,
        action: "plugin.expedientes.case_type_added",
        target: name,
      });
      return { caseType: { ...created.rows[0], caseCount: 0 } };
    });

    app.delete("/case-types/:id", async (request) => {
      const { user } = requireAdmin(request);
      const { id } = idParams.parse(request.params);
      const removed = await db.execute<{ name: string }>(
        sql`delete from exp_case_types where id = ${id} returning name`,
      );
      if (!removed.rows[0]) throw notFound();
      await audit(db, {
        userId: user.id,
        action: "plugin.expedientes.case_type_removed",
        target: removed.rows[0].name,
      });
      return { ok: true };
    });

    // Catálogo de aseguradoras. Lo lee cualquiera; lo cambia un administrador.
    app.get("/insurers", async (request) => {
      requireSession(request);
      const rows = await db.execute(sql`
        select i.id, i.name,
               (select count(*)::int from exp_cases c where c.insurer_id = i.id) as "caseCount"
          from exp_insurers i order by lower(i.name)`);
      return { insurers: rows.rows };
    });

    app.post("/insurers", async (request) => {
      const { user } = requireAdmin(request);
      const { name } = insurerBody.parse(request.body);
      const created = await db.execute<{ id: string; name: string }>(sql`
        insert into exp_insurers (name) values (${name})
        on conflict do nothing returning id, name`);
      if (!created.rows[0]) {
        throw new HttpError(409, "duplicate", "Ya hay una aseguradora con ese nombre.");
      }
      await audit(db, {
        userId: user.id,
        action: "plugin.expedientes.insurer_added",
        target: name,
      });
      return { insurer: { ...created.rows[0], caseCount: 0 } };
    });

    app.delete("/insurers/:id", async (request) => {
      const { user } = requireAdmin(request);
      const { id } = idParams.parse(request.params);
      const removed = await db.execute<{ name: string }>(
        sql`delete from exp_insurers where id = ${id} returning name`,
      );
      if (!removed.rows[0]) throw notFound();
      await audit(db, {
        userId: user.id,
        action: "plugin.expedientes.insurer_removed",
        target: removed.rows[0].name,
      });
      return { ok: true };
    });

    // La lista: con buscador (número, título, nº de siniestro, cliente, teléfono o quien escribe)
    // y filtros. Sin parámetros, todos los expedientes de los buzones que se ven.
    app.get("/cases", async (request) => {
      const { user } = requireSession(request);
      const query = listQuery.parse(request.query);
      const accountIds = await accessibleAccountIds(db, user.id);
      if (accountIds.length === 0) return { cases: [] };
      const tables = await db.execute<{ ct: boolean; tra: boolean }>(sql`
        select to_regclass('ct_links') is not null as ct, to_regclass('tra_case_plans') is not null as tra`);
      const { ct, tra } = tables.rows[0]!;
      const text = query.q?.toLowerCase() ?? "";
      const pattern = text ? `%${text.replace(/[%_\\]/g, "\\$&")}%` : null;
      const digits = text.replace(/\D/g, "");
      const client = ct
        ? sql`(select co.name from ct_links l join ct_contacts co on co.id = l.contact_id
                where l.target_kind = 'case' and l.target_id = c.id and l.role = 'cliente' limit 1)`
        : sql`null::text`;
      const searchClient =
        ct && pattern
          ? sql`or exists (select 1 from ct_links l join ct_contacts co on co.id = l.contact_id
                            left join ct_channels ch on ch.contact_id = co.id
                           where l.target_kind = 'case' and l.target_id = c.id
                             and (lower(co.name) like ${pattern} or ch.value like ${pattern}
                                  ${digits.length >= 6 ? sql`or ch.value like ${"%" + digits + "%"}` : sql``}))`
          : sql``;
      const search = pattern
        ? sql`and (lower(c.number) like ${pattern} or lower(c.title) like ${pattern}
                   or lower(coalesce(c.claim_ref, '')) like ${pattern}
                   or exists (select 1 from exp_case_messages cm join messages m on m.id = cm.message_id
                               where cm.case_id = c.id and (lower(m.from_name) like ${pattern}
                                     or lower(m.from_address) like ${pattern}))
                   ${searchClient})`
        : sql``;
      const status =
        query.status && query.status !== "todos" ? sql`and c.status = ${query.status}` : sql``;
      const rows = await db.execute(sql`
        select ${caseColumns}, ${client} as "clientName",
               ${tra ? sql`exists (select 1 from tra_case_plans tp where tp.case_id = c.id)` : sql`null::boolean`} as "hasPlan",
               (select count(distinct coalesce(m.message_id_header, m.id::text))::int
                  from exp_case_messages cm join messages m on m.id = cm.message_id
                 where cm.case_id = c.id and m.account_id in (${uuids(accountIds)})) as "messageCount",
               (select count(*)::int from exp_case_messages cm join messages m on m.id = cm.message_id
                 where cm.case_id = c.id and m.account_id in (${uuids(accountIds)}) and ${isNewSql(user.id)}) as "newCount",
               (select max(m.internal_date) from exp_case_messages cm
                  join messages m on m.id = cm.message_id
                 where cm.case_id = c.id and m.account_id in (${uuids(accountIds)})) as "lastMessageAt"
          from exp_cases c
         where ${caseVisible("c", accountIds)}
           ${status}
           ${query.mine === "1" ? sql`and coalesce(c.owner_id, c.created_by) = ${user.id}` : sql``}
           ${tra && query.noPlan === "1" ? sql`and not exists (select 1 from tra_case_plans tp where tp.case_id = c.id)` : sql``}
           ${search}
         order by "lastMessageAt" desc nulls last, c.created_at desc
         limit 500`);
      return { cases: rows.rows };
    });

    // Quien abre el expediente ha visto lo que había: deja de contar como nuevo.
    app.post("/cases/:id/seen", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      await loadCase(user.id, id);
      await db.execute(sql`
        insert into exp_case_seen (user_id, case_id, seen_at) values (${user.id}, ${id}, now())
        on conflict (user_id, case_id) do update set seen_at = now()`);
      return { ok: true };
    });

    app.get("/cases/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const row = await loadCase(user.id, id);
      const accountIds = await accessibleAccountIds(db, user.id);
      return { case: row, messages: await messagesOfCase(db, id, accountIds, user.id) };
    });

    // Cuánto ocupa el contexto del expediente: lo que leería quien resuma o responda sobre él.
    app.get("/cases/:id/context", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      await loadCase(user.id, id);
      const accountIds = await accessibleAccountIds(db, user.id);
      const mail = await db.execute<{ messages: number; excluded: number; chars: number }>(sql`
        select count(*) filter (where not cm.excluded)::int as messages,
               count(*) filter (where cm.excluded)::int as excluded,
               coalesce(sum(length(coalesce(m.body_clean, m.body_text, '')))
                        filter (where not cm.excluded), 0)::int as chars
          from exp_case_messages cm join messages m on m.id = cm.message_id
         where cm.case_id = ${id} and m.account_id in (${uuids(accountIds)})`);
      // Cada documento cuenta una vez aunque venga adjunto en varios correos.
      const files = await db.execute<{ status: string; documents: number; chars: number }>(sql`
        select coalesce(d.status, 'pending') as status,
               count(*)::int as documents, coalesce(sum(d.chars), 0)::int as chars
          from (select distinct a.content_sha256
                  from exp_case_messages cm
                  join messages m on m.id = cm.message_id
                  join attachments a on a.message_id = m.id and not a.inline
                 where cm.case_id = ${id} and not cm.excluded
                   and m.account_id in (${uuids(accountIds)})) docs
          left join document_texts d on d.content_sha256 = docs.content_sha256
         group by 1`);
      const byStatus = Object.fromEntries(files.rows.map((row) => [row.status, row.documents]));
      const documentChars = files.rows.reduce((sum, row) => sum + row.chars, 0);
      const chars = (mail.rows[0]?.chars ?? 0) + documentChars;
      return {
        messages: mail.rows[0]?.messages ?? 0,
        excluded: mail.rows[0]?.excluded ?? 0,
        messageChars: mail.rows[0]?.chars ?? 0,
        documents: files.rows.reduce((sum, row) => sum + row.documents, 0),
        documentChars,
        /** Documentos de los que aún no hay texto, por motivo. */
        withoutText: {
          needsOcr: byStatus.needs_ocr ?? 0,
          unsupported: byStatus.unsupported ?? 0,
          failed: byStatus.failed ?? 0,
          pending: byStatus.pending ?? 0,
        },
        chars,
        approxTokens: approxTokens(chars),
      };
    });

    // Expedientes de un correo, con sus demás correos: para la barra y el panel de contexto.
    app.get("/by-message/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      await loadMessage(user.id, id);
      const accountIds = await accessibleAccountIds(db, user.id);
      // El correo es suyo: los expedientes en que está los ve, sean del buzón que sean.
      const visible = await casesOfMessage(db, id);
      return {
        cases: await Promise.all(
          visible.map(async (row) => ({
            case: row,
            messages: await messagesOfCase(db, row.id, accountIds),
          })),
        ),
      };
    });

    // Antes de abrir otro: los expedientes abiertos de quien escribe este correo. Se le reconoce
    // por su dirección y, si el módulo de contactos está activo, por cualquiera de los canales de
    // su ficha y por los expedientes en que es el cliente.
    app.get("/open-of-sender/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const message = await loadMessage(user.id, id);
      const accountIds = await accessibleAccountIds(db, user.id);
      const address = (message.fromAddress ?? "").toLowerCase();
      const own = await db.execute(sql`select 1 from accounts where lower(email) = ${address}`);
      if (!address || own.rows.length > 0 || accountIds.length === 0) return { cases: [] };
      const contacts = await db.execute<{ ok: boolean }>(
        sql`select to_regclass('ct_channels') is not null as ok`,
      );
      const withContacts = contacts.rows[0]?.ok === true;
      // Un tercero con ficha (aseguradora, perito, taller…) escribe en muchos expedientes:
      // avisar con cada correo suyo no ayuda. El aviso es para el cliente o para un desconocido.
      if (withContacts) {
        const known = await db.execute<{ client: boolean }>(sql`
          select exists (select 1 from ct_roles r where r.contact_id = ch.contact_id and r.role = 'cliente')
                 or not exists (select 1 from ct_roles r where r.contact_id = ch.contact_id) as client
            from ct_channels ch
           where (ch.kind = 'email' and ch.value = ${address})
              or (ch.kind = 'phone' and ch.value || '@whatsapp.invalid' = ${address})
           limit 1`);
        if (known.rows[0] && !known.rows[0].client) return { cases: [] };
      }
      // Todas las direcciones de la misma persona: la suya y, con la agenda, las de su ficha.
      const addresses = withContacts
        ? sql`(select ${address} union
               select case when ch.kind = 'email' then ch.value else ch.value || '@whatsapp.invalid' end
                 from ct_channels ch
                where ch.contact_id = (select c2.contact_id from ct_channels c2
                                        where (c2.kind = 'email' and c2.value = ${address})
                                           or (c2.kind = 'phone' and c2.value || '@whatsapp.invalid' = ${address})
                                        limit 1))`
        : sql`(select ${address})`;
      const clientOf = withContacts
        ? sql`or exists (select 1 from ct_links l join ct_channels ch on ch.contact_id = l.contact_id
                          where l.target_kind = 'case' and l.target_id = c.id and l.role = 'cliente'
                            and ((ch.kind = 'email' and ch.value = ${address})
                              or (ch.kind = 'phone' and ch.value || '@whatsapp.invalid' = ${address})))`
        : sql``;
      const rows = await db.execute(sql`
        select ${caseColumns},
               (select max(m.internal_date) from exp_case_messages cm join messages m on m.id = cm.message_id
                 where cm.case_id = c.id) as "lastMessageAt"
          from exp_cases c
         where ${caseVisible("c", accountIds)} and c.status = 'abierto'
           and not exists (select 1 from exp_case_messages x where x.case_id = c.id and x.message_id = ${id})
           and (exists (select 1 from exp_case_messages cm join messages m on m.id = cm.message_id
                         where cm.case_id = c.id and lower(m.from_address) in ${addresses})
                ${clientOf})
         order by "lastMessageAt" desc nulls last limit 5`);
      return { cases: rows.rows };
    });

    // Etiquetas para la lista: qué correos de los pedidos están en algún expediente.
    app.post("/labels", async (request) => {
      const { user } = requireSession(request);
      const { messageIds } = labelsBody.parse(request.body);
      const accountIds = await accessibleAccountIds(db, user.id);
      if (messageIds.length === 0 || accountIds.length === 0) return { labels: {} };
      const rows = await db.execute<{ messageId: string; number: string }>(sql`
        select cm.message_id as "messageId", c.number
          from exp_case_messages cm join exp_cases c on c.id = cm.case_id
         where cm.message_id in (${uuids(messageIds)})
           and cm.message_id in (select m.id from messages m where m.account_id in (${uuids(accountIds)}))
         order by c.created_at`);
      const labels: Record<string, string[]> = {};
      for (const row of rows.rows) (labels[row.messageId] ??= []).push(row.number);
      return { labels };
    });
  },
};
