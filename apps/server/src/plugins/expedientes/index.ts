import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { events, messages } from "../../db/schema.ts";
import { accessibleAccountIds, assertAccess } from "../../http/access.ts";
import { audit, HttpError, notFound, requireAdmin, requireSession } from "../../http/app.ts";
import { approxTokens } from "../../mail/clean.ts";
import type { MailEvent, ServerPlugin } from "../host.ts";

/**
 * Plugin de demostración: expedientes. No es el módulo de siniestros; existe para
 * probar que un plugin puede tener datos propios, rutas, reaccionar al correo que
 * llega y pintar en los huecos de la interfaz, sin tocar el núcleo.
 */

const REFERENCE = /EXP-\d{4}-\d{4}/i;

type CaseRow = {
  id: string;
  accountId: string;
  number: string;
  title: string;
  createdAt: Date;
  insurerId: string | null;
  insurerName: string | null;
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
};

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
}

const caseColumns = sql`c.id, c.account_id as "accountId", c.number, c.title, c.created_at as "createdAt",
  c.insurer_id as "insurerId",
  (select i.name from exp_insurers i where i.id = c.insurer_id) as "insurerName"`;

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
const messagesOfCase = async (db: Db, caseId: string, accountIds: string[]) =>
  accountIds.length === 0
    ? []
    : (
        await db.execute<CaseMessage>(sql`
          select * from (
            select distinct on (coalesce(m.message_id_header, m.id::text))
                   m.id, m.subject, m.from_name as "fromName", m.from_address as "fromAddress",
                   m.internal_date as "internalDate", cm.how, cm.excluded, cm.added_at,
                   a.email as "mailbox"
              from exp_case_messages cm
              join messages m on m.id = cm.message_id
              join accounts a on a.id = m.account_id
             where cm.case_id = ${caseId} and m.account_id in (${uuids(accountIds)})
             order by coalesce(m.message_id_header, m.id::text),
                      (cm.how = 'manual') desc, m.internal_date
          ) unique_messages
          order by "internalDate", added_at`)
      ).rows;

/** Aviso para que las pantallas abiertas se refresquen. */
const notify = (db: Db, accountId: string, messageId?: string) =>
  db.insert(events).values({ accountId, type: "account.changed", messageId });

/**
 * Un correo nuevo entra solo en un expediente si pertenece a una conversación que ya
 * está en uno, o si su asunto lleva el número de un expediente del mismo buzón.
 */
async function onEvent(event: MailEvent, db: Db): Promise<void> {
  if (event.type !== "message.received" || !event.messageId) return;
  const [message] = await db.select().from(messages).where(eq(messages.id, event.messageId));
  if (!message) return;

  // Por conversación: entra en todos los expedientes que ya tengan un correo de su hilo.
  const byThread = await db.execute<{ caseId: string }>(sql`
    select distinct cm.case_id as "caseId" from exp_case_messages cm
      join messages m on m.id = cm.message_id
     where m.thread_id = ${message.threadId} and m.id <> ${message.id}`);
  const targets = byThread.rows.map((row) => ({ caseId: row.caseId, how: "thread" }));

  // Por el número en el asunto: da igual a qué buzón llegue.
  if (targets.length === 0) {
    const reference = REFERENCE.exec(message.subject)?.[0].toUpperCase();
    if (reference) {
      const byNumber = await db.execute<{ id: string }>(
        sql`select id from exp_cases where number = ${reference}`,
      );
      if (byNumber.rows[0]) targets.push({ caseId: byNumber.rows[0].id, how: "reference" });
    }
  }
  if (targets.length === 0) return;
  for (const target of targets) {
    await db.execute(sql`
      insert into exp_case_messages (message_id, case_id, how)
      values (${message.id}, ${target.caseId}, ${target.how}) on conflict do nothing`);
  }
  await notify(db, message.accountId, message.id);
}

const idParams = z.object({ id: z.uuid() });
const createBody = z.object({ messageId: z.uuid() });
const labelsBody = z.object({ messageIds: z.array(z.uuid()).max(500) });
const listQuery = z.object({ accountId: z.uuid().optional() });

const memberParams = z.object({ id: z.uuid(), messageId: z.uuid() });
const excludeBody = z.object({ excluded: z.boolean() });
const caseBody = z.object({ insurerId: z.uuid().nullable() });
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
      await assertAccess(db, userId, row.accountId);
      return row;
    }

    async function loadMessage(userId: string, id: string) {
      const [message] = await db.select().from(messages).where(eq(messages.id, id));
      if (!message) throw notFound();
      await assertAccess(db, userId, message.accountId);
      return message;
    }

    // Crear un expediente a partir de un correo: entra con toda su conversación.
    app.post("/cases", async (request) => {
      const { user } = requireSession(request);
      const { messageId } = createBody.parse(request.body);
      const message = await loadMessage(user.id, messageId);

      const created = await db.transaction(async (tx) => {
        const next = await tx.execute<{ n: string }>(sql`select nextval('exp_case_seq') as n`);
        const number = `EXP-${new Date().getFullYear()}-${String(next.rows[0]!.n).padStart(4, "0")}`;
        const inserted = await tx.execute<CaseRow>(sql`
          insert into exp_cases as c (account_id, number, title, created_by)
          values (${message.accountId}, ${number}, ${message.subject || "(sin asunto)"}, ${user.id})
          returning ${caseColumns}`);
        const row = inserted.rows[0]!;
        await tx.execute(sql`
          insert into exp_case_messages (message_id, case_id, how, added_by)
          select m.id, ${row.id}, case when m.id = ${messageId} then 'manual' else 'thread' end,
                 ${user.id}
            from messages m
           where m.thread_id = ${message.threadId} and m.account_id = ${message.accountId}
          on conflict do nothing`);
        return row;
      });
      await audit(db, {
        userId: user.id,
        accountId: message.accountId,
        action: "plugin.demo.case_created",
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
          action: "plugin.demo.message_added",
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
        action: "plugin.demo.thread_removed",
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
        action: excluded ? "plugin.demo.message_excluded" : "plugin.demo.message_included",
        target: id,
        detail: { number: row.number, messageId },
      });
      await notify(db, message.accountId, messageId);
      return { ok: true, excluded };
    });

    // La aseguradora del expediente.
    app.put("/cases/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { insurerId } = caseBody.parse(request.body);
      const row = await loadCase(user.id, id);
      if (insurerId) {
        const known = await db.execute(sql`select 1 from exp_insurers where id = ${insurerId}`);
        if (known.rows.length === 0) throw notFound();
      }
      await db.execute(sql`update exp_cases set insurer_id = ${insurerId} where id = ${id}`);
      await audit(db, {
        userId: user.id,
        accountId: row.accountId,
        action: "plugin.demo.case_updated",
        target: id,
        detail: { number: row.number, insurerId },
      });
      await notify(db, row.accountId);
      return { case: await loadCase(user.id, id) };
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
      await audit(db, { userId: user.id, action: "plugin.demo.insurer_added", target: name });
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
        action: "plugin.demo.insurer_removed",
        target: removed.rows[0].name,
      });
      return { ok: true };
    });

    app.get("/cases", async (request) => {
      const { user } = requireSession(request);
      listQuery.parse(request.query);
      const accountIds = await accessibleAccountIds(db, user.id);
      if (accountIds.length === 0) return { cases: [] };
      const rows = await db.execute(sql`
        select ${caseColumns},
               (select count(distinct coalesce(m.message_id_header, m.id::text))::int
                  from exp_case_messages cm join messages m on m.id = cm.message_id
                 where cm.case_id = c.id and m.account_id in (${uuids(accountIds)})) as "messageCount",
               (select max(m.internal_date) from exp_case_messages cm
                  join messages m on m.id = cm.message_id
                 where cm.case_id = c.id and m.account_id in (${uuids(accountIds)})) as "lastMessageAt"
          from exp_cases c
         where c.account_id in (${uuids(accountIds)})
         order by "lastMessageAt" desc nulls last, c.created_at desc`);
      return { cases: rows.rows };
    });

    app.get("/cases/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const row = await loadCase(user.id, id);
      const accountIds = await accessibleAccountIds(db, user.id);
      return { case: row, messages: await messagesOfCase(db, id, accountIds) };
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
      const visible = (await casesOfMessage(db, id)).filter((row) =>
        accountIds.includes(row.accountId),
      );
      return {
        cases: await Promise.all(
          visible.map(async (row) => ({
            case: row,
            messages: await messagesOfCase(db, row.id, accountIds),
          })),
        ),
      };
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
           and c.account_id in (${uuids(accountIds)})
         order by c.created_at`);
      const labels: Record<string, string[]> = {};
      for (const row of rows.rows) (labels[row.messageId] ??= []).push(row.number);
      return { labels };
    });
  },
};
