/**
 * Escribir mensajes de WhatsApp en su hilo: como correos en la carpeta del buzón, encadenados
 * con el anterior del mismo contacto, y apuntados para no repetirlos.
 */
import { sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import type { Db } from "../../db/client.ts";
import type { Account } from "../../imap/connection.ts";
import { buildMail, mailIdOf } from "./mail.ts";
import type { WaMessage } from "./meta.ts";

export type WaFile = { filename: string; content: Buffer; contentType: string };

export async function ensureFolder(client: ImapFlow, folder: string): Promise<void> {
  const folders = await client.list();
  if (!folders.some((entry) => entry.path === folder)) await client.mailboxCreate(folder);
}

/** Los que aún no están en el buzón (Meta reintenta: el mismo aviso puede llegar dos veces). */
export async function unseen(db: Db, messages: WaMessage[]): Promise<WaMessage[]> {
  const fresh: WaMessage[] = [];
  for (const message of messages) {
    const seen = await db.execute(sql`select 1 from wa_messages where wamid = ${message.id}`);
    if (seen.rows.length === 0) fresh.push(message);
  }
  return fresh;
}

/** El nombre que tiene este teléfono en la agenda de contactos, si la hay. */
async function agendaName(db: Db, phone: string): Promise<string | null> {
  const active = await db.execute<{ ok: boolean }>(
    sql`select to_regclass('ct_channels') is not null as ok`,
  );
  if (!active.rows[0]?.ok) return null;
  const rows = await db.execute<{ name: string }>(sql`
    select c.name from ct_channels ch join ct_contacts c on c.id = ch.contact_id
     where ch.kind = 'phone' and ch.value = ${phone} and not c.archived limit 1`);
  return rows.rows[0]?.name ?? null;
}

/** Escribe un mensaje en el hilo de su contacto. */
export async function appendToThread(input: {
  db: Db;
  client: ImapFlow;
  account: Account;
  folder: string;
  message: WaMessage;
  file: WaFile | null;
}): Promise<void> {
  const { db, client, account, folder, message, file } = input;
  const thread = (
    await db.execute<{ name: string | null; firstMailId: string; lastMailId: string }>(sql`
      select name, first_mail_id as "firstMailId", last_mail_id as "lastMailId"
        from wa_threads where account_id = ${account.id} and phone = ${message.phone}`)
  ).rows[0];
  const quoted = message.replyTo
    ? (
        await db.execute<{ mailId: string }>(
          sql`select mail_id as "mailId" from wa_messages where wamid = ${message.replyTo}`,
        )
      ).rows[0]?.mailId
    : undefined;
  const inReplyTo = quoted ?? thread?.lastMailId ?? null;
  const references = [
    ...new Set([thread?.firstMailId, inReplyTo].filter((id): id is string => Boolean(id))),
  ];
  // El nombre de la agenda, si el módulo de contactos está activo y le conoce; si no, el de su perfil.
  const name = (await agendaName(db, message.phone)) || message.name || thread?.name || null;
  const raw = await buildMail({
    message,
    name,
    office: { name: account.name, address: account.email },
    inReplyTo,
    references,
    file,
  });
  const seen = message.direction === "out" || message.history;
  await client.append(folder, raw, seen ? ["\\Seen"] : [], message.at);
  const mailId = mailIdOf(message.id);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into wa_messages (wamid, account_id, phone, direction, kind, at, mail_id, raw)
      values (${message.id}, ${account.id}, ${message.phone}, ${message.direction}, ${message.kind},
              ${message.at.toISOString()}::timestamptz, ${mailId}, ${JSON.stringify(message.raw)}::jsonb)
      on conflict do nothing`);
    await tx.execute(sql`
      insert into wa_threads (account_id, phone, name, first_mail_id, last_mail_id, last_at)
      values (${account.id}, ${message.phone}, ${name}, ${mailId}, ${mailId}, ${message.at.toISOString()}::timestamptz)
      on conflict (account_id, phone) do update set
        name = coalesce(excluded.name, wa_threads.name),
        last_mail_id = case when excluded.last_at >= wa_threads.last_at then excluded.last_mail_id else wa_threads.last_mail_id end,
        last_at = greatest(excluded.last_at, wa_threads.last_at)`);
  });
}

/**
 * La ventana de 24 horas: desde el último mensaje del cliente se le puede escribir
 * libremente; después, solo con una plantilla aprobada por Meta.
 */
export async function windowOf(
  db: Db,
  accountId: string,
  phone: string,
): Promise<{ open: boolean; until: Date | null; name: string | null }> {
  const row = (
    await db.execute<{ last: string | null; name: string | null }>(sql`
      select (select max(at) from wa_messages where account_id = ${accountId} and phone = ${phone} and direction = 'in') as last,
             (select name from wa_threads where account_id = ${accountId} and phone = ${phone}) as name`)
  ).rows[0];
  const until = row?.last ? new Date(new Date(row.last).getTime() + 24 * 3_600_000) : null;
  return { open: Boolean(until && until.getTime() > Date.now()), until, name: row?.name ?? null };
}
