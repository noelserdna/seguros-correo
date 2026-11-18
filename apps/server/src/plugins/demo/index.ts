import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import { events, messages } from "../../db/schema.ts";
import { accessibleAccountIds, assertAccess } from "../../http/access.ts";
import { audit, notFound, requireSession } from "../../http/app.ts";
import type { MailEvent, ServerPlugin } from "../host.ts";

/**
 * Plugin de demostración: expedientes. No es el módulo de siniestros; existe para
 * probar que un plugin puede tener datos propios, rutas, reaccionar al correo que
 * llega y pintar en los huecos de la interfaz, sin tocar el núcleo.
 */

const REFERENCE = /EXP-\d{4}-\d{4}/i;

type CaseRow = { id: string; accountId: string; number: string; title: string; createdAt: Date };
type CaseMessage = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: Date;
  how: string;
};

async function setup(db: Db): Promise<void> {
  await db.execute(sql`
    create table if not exists demo_cases (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null references accounts(id) on delete cascade,
      number text not null unique,
      title text not null,
      created_by uuid,
      created_at timestamptz not null default now()
    )`);
  await db.execute(sql`
    create table if not exists demo_case_messages (
      message_id uuid primary key references messages(id) on delete cascade,
      case_id uuid not null references demo_cases(id) on delete cascade,
      how text not null,
      added_at timestamptz not null default now()
    )`);
  await db.execute(sql`create sequence if not exists demo_case_seq`);
}

const caseColumns = sql`c.id, c.account_id as "accountId", c.number, c.title, c.created_at as "createdAt"`;

async function caseOfMessage(db: Db, messageId: string): Promise<CaseRow | null> {
  const found = await db.execute<CaseRow>(sql`
    select ${caseColumns} from demo_cases c
      join demo_case_messages cm on cm.case_id = c.id
     where cm.message_id = ${messageId}`);
  return found.rows[0] ?? null;
}

/**
 * Correos del expediente. La copia de Enviados y la recibida de un mismo correo
 * (misma cabecera Message-ID) cuentan como uno: se enseña el añadido a mano si lo hay.
 */
const messagesOfCase = async (db: Db, caseId: string) =>
  (
    await db.execute<CaseMessage>(sql`
      select * from (
        select distinct on (coalesce(m.message_id_header, m.id::text))
               m.id, m.subject, m.from_name as "fromName", m.from_address as "fromAddress",
               m.internal_date as "internalDate", cm.how, cm.added_at
          from demo_case_messages cm join messages m on m.id = cm.message_id
         where cm.case_id = ${caseId}
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
  if (!message || (await caseOfMessage(db, message.id))) return;

  const byThread = await db.execute<{ caseId: string }>(sql`
    select cm.case_id as "caseId" from demo_case_messages cm
      join messages m on m.id = cm.message_id
     where m.thread_id = ${message.threadId} limit 1`);
  let caseId = byThread.rows[0]?.caseId;
  let how = "thread";
  if (!caseId) {
    const reference = REFERENCE.exec(message.subject)?.[0].toUpperCase();
    if (!reference) return;
    const byNumber = await db.execute<{ id: string }>(sql`
      select id from demo_cases where number = ${reference} and account_id = ${message.accountId}`);
    caseId = byNumber.rows[0]?.id;
    how = "reference";
  }
  if (!caseId) return;
  await db.execute(sql`
    insert into demo_case_messages (message_id, case_id, how)
    values (${message.id}, ${caseId}, ${how}) on conflict do nothing`);
  await notify(db, message.accountId, message.id);
}

const idParams = z.object({ id: z.uuid() });
const createBody = z.object({ messageId: z.uuid() });
const labelsBody = z.object({ messageIds: z.array(z.uuid()).max(500) });
const listQuery = z.object({ accountId: z.uuid().optional() });

export const demoPlugin: ServerPlugin = {
  id: "demo",
  setup,
  onEvent,
  routes: async (app, { context }) => {
    const { db } = context;

    // Crear un expediente a partir de un correo: entra con toda su conversación.
    app.post("/cases", async (request) => {
      const { user } = requireSession(request);
      const { messageId } = createBody.parse(request.body);
      const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (!message) throw notFound();
      await assertAccess(db, user.id, message.accountId);

      const existing = await caseOfMessage(db, messageId);
      if (existing) return { case: existing, created: false };

      const created = await db.transaction(async (tx) => {
        const next = await tx.execute<{ n: string }>(sql`select nextval('demo_case_seq') as n`);
        const number = `EXP-${new Date().getFullYear()}-${String(next.rows[0]!.n).padStart(4, "0")}`;
        const inserted = await tx.execute<CaseRow>(sql`
          insert into demo_cases as c (account_id, number, title, created_by)
          values (${message.accountId}, ${number}, ${message.subject || "(sin asunto)"}, ${user.id})
          returning ${caseColumns}`);
        const row = inserted.rows[0]!;
        await tx.execute(sql`
          insert into demo_case_messages (message_id, case_id, how)
          select m.id, ${row.id}, case when m.id = ${messageId} then 'manual' else 'thread' end
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

    app.get("/cases", async (request) => {
      const { user } = requireSession(request);
      const { accountId } = listQuery.parse(request.query);
      let accountIds = await accessibleAccountIds(db, user.id);
      if (accountId) accountIds = accountIds.filter((id) => id === accountId);
      if (accountIds.length === 0) return { cases: [] };
      const rows = await db.execute(sql`
        select ${caseColumns},
               (select count(distinct coalesce(m.message_id_header, m.id::text))::int
                  from demo_case_messages cm join messages m on m.id = cm.message_id
                 where cm.case_id = c.id) as "messageCount",
               (select max(m.internal_date) from demo_case_messages cm
                  join messages m on m.id = cm.message_id where cm.case_id = c.id) as "lastMessageAt"
          from demo_cases c
         where c.account_id in (${sql.join(
           accountIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
         order by "lastMessageAt" desc nulls last`);
      return { cases: rows.rows };
    });

    app.get("/cases/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const found = await db.execute<CaseRow>(
        sql`select ${caseColumns} from demo_cases c where c.id = ${id}`,
      );
      const row = found.rows[0];
      if (!row) throw notFound();
      await assertAccess(db, user.id, row.accountId);
      return { case: row, messages: await messagesOfCase(db, id) };
    });

    // Expediente de un correo, con sus demás correos: para el panel de contexto.
    app.get("/by-message/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const [message] = await db.select().from(messages).where(eq(messages.id, id));
      if (!message) throw notFound();
      await assertAccess(db, user.id, message.accountId);
      const row = await caseOfMessage(db, id);
      return { case: row, messages: row ? await messagesOfCase(db, row.id) : [] };
    });

    // Etiquetas para la lista: qué correos de los pedidos están en un expediente.
    app.post("/labels", async (request) => {
      const { user } = requireSession(request);
      const { messageIds } = labelsBody.parse(request.body);
      const accountIds = await accessibleAccountIds(db, user.id);
      if (messageIds.length === 0 || accountIds.length === 0) return { labels: {} };
      const rows = await db.execute<{ messageId: string; caseId: string; number: string }>(sql`
        select cm.message_id as "messageId", c.id as "caseId", c.number
          from demo_case_messages cm join demo_cases c on c.id = cm.case_id
         where cm.message_id in (${sql.join(
           messageIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
           and c.account_id in (${sql.join(
             accountIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})`);
      return {
        labels: Object.fromEntries(
          rows.rows.map((row) => [row.messageId, { caseId: row.caseId, number: row.number }]),
        ),
      };
    });
  },
};
