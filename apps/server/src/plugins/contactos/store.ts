/** Consultas de la agenda: fichas, quién escribe desde qué dirección y qué falta por revisar. */
import { sql, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.ts";
import {
  channelOfAddress,
  cleanName,
  guessRole,
  nameKey,
  phonesIn,
  WHATSAPP_DOMAIN,
  type Role,
} from "./normalize.ts";

export type Channel = {
  id: string;
  kind: "email" | "phone";
  value: string;
  label: string | null;
  source: string;
  sourceMessageId: string | null;
};

export type ContactRow = {
  id: string;
  kind: "persona" | "empresa";
  name: string;
  companyId: string | null;
  companyName: string | null;
  notes: string | null;
  archived: boolean;
  roles: Role[];
  channels: Channel[];
  /** El primer correo y teléfono, para listas y para quien solo necesita uno. */
  email: string | null;
  phone: string | null;
  openCases: number;
};

/** Si existe una tabla de otro módulo (expedientes, tramitación): la agenda vive sin ellos. */
export async function hasTable(db: Db | Tx, name: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`select to_regclass(${name}) is not null as ok`,
  );
  return rows.rows[0]?.ok ?? false;
}

/** Condición SQL: el remitente `address` (una columna) es uno de los canales de la ficha `contact`. */
const senderMatches = (address: SQL, contact: SQL) => sql`exists (
  select 1 from ct_channels ch where ch.contact_id = ${contact} and (
    (ch.kind = 'email' and ch.value = lower(${address}))
    or (ch.kind = 'phone' and lower(${address}) = ch.value || ${"@" + WHATSAPP_DOMAIN})))`;

/** Los expedientes abiertos en que aparece cada ficha: por vínculo, como interviniente o porque escribió. */
async function openCasesSql(db: Db): Promise<SQL> {
  if (!(await hasTable(db, "exp_cases"))) return sql`0`;
  const parties = (await hasTable(db, "tra_case_parties"))
    ? sql`union select p.case_id from tra_case_parties p where p.contact_id = c.id`
    : sql``;
  return sql`(select count(*)::int from exp_cases e where e.status = 'abierto' and e.id in (
      select l.target_id from ct_links l where l.contact_id = c.id and l.target_kind = 'case'
      ${parties}
      union select cm.case_id from exp_case_messages cm join messages m on m.id = cm.message_id
       where ${senderMatches(sql`m.from_address`, sql`c.id`)}))`;
}

export async function listContacts(
  db: Db,
  filter: { q?: string; role?: string; archived?: boolean; ids?: string[]; limit?: number },
): Promise<ContactRow[]> {
  const conditions: SQL[] = [sql`c.archived = ${filter.archived ?? false}`];
  if (filter.role)
    conditions.push(
      sql`exists (select 1 from ct_roles r where r.contact_id = c.id and r.role = ${filter.role})`,
    );
  if (filter.ids) {
    if (filter.ids.length === 0) return [];
    conditions.push(
      sql`c.id in (${sql.join(
        filter.ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  }
  if (filter.q) {
    const pattern = `%${filter.q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`;
    const digits = filter.q.replace(/\D/g, "");
    conditions.push(sql`(lower(c.name) like ${pattern}
      or lower(coalesce(co.name, '')) like ${pattern}
      or exists (select 1 from ct_channels ch where ch.contact_id = c.id and (ch.value like ${pattern}
        ${digits.length >= 3 ? sql`or (ch.kind = 'phone' and ch.value like ${`%${digits}%`})` : sql``})))`);
  }
  const rows = await db.execute<ContactRow>(sql`
    select c.id, c.kind, c.name, c.company_id as "companyId", co.name as "companyName", c.notes, c.archived,
           coalesce((select array_agg(r.role order by r.role) from ct_roles r where r.contact_id = c.id), '{}') as roles,
           coalesce((select json_agg(json_build_object('id', ch.id, 'kind', ch.kind, 'value', ch.value, 'label', ch.label,
                                                       'source', ch.source, 'sourceMessageId', ch.source_message_id)
                                      order by ch.kind, ch.created_at)
                       from ct_channels ch where ch.contact_id = c.id), '[]') as channels,
           (select ch.value from ct_channels ch where ch.contact_id = c.id and ch.kind = 'email' order by ch.created_at limit 1) as email,
           (select ch.value from ct_channels ch where ch.contact_id = c.id and ch.kind = 'phone' order by ch.created_at limit 1) as phone,
           ${await openCasesSql(db)} as "openCases"
      from ct_contacts c left join ct_contacts co on co.id = c.company_id
     where ${sql.join(conditions, sql` and `)}
     order by lower(c.name) limit ${filter.limit ?? 500}`);
  return rows.rows;
}

/** La ficha de quien usa esta dirección (correo o WhatsApp), si la hay. */
export async function contactIdForAddress(db: Db | Tx, address: string): Promise<string | null> {
  const { kind, value } = channelOfAddress(address);
  const rows = await db.execute<{ id: string }>(sql`
    select ch.contact_id as id from ct_channels ch join ct_contacts c on c.id = ch.contact_id
     where ch.kind = ${kind} and ch.value = ${value} and not c.archived limit 1`);
  return rows.rows[0]?.id ?? null;
}

/** Correos y mensajes recientes de una ficha, solo de los buzones que ve quien pregunta. */
export async function activityOf(db: Db, contactId: string, accountIds: string[], limit = 8) {
  if (accountIds.length === 0) return [];
  const accounts = sql.join(
    accountIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const cases = (await hasTable(db, "exp_case_messages"))
    ? sql`coalesce((select array_agg(distinct e.number) from exp_case_messages cm join exp_cases e on e.id = cm.case_id
                      where cm.message_id = m.id), '{}')`
    : sql`'{}'::text[]`;
  const rows = await db.execute<{
    id: string;
    accountId: string;
    subject: string;
    preview: string;
    at: string;
    whatsapp: boolean;
    files: number;
    cases: string[];
  }>(sql`
    select m.id, m.account_id as "accountId", m.subject, left(coalesce(m.body_text, ''), 160) as preview,
           m.internal_date as at, lower(m.from_address) like ${"%@" + WHATSAPP_DOMAIN} as whatsapp,
           (select count(*)::int from attachments a where a.message_id = m.id) as files,
           ${cases} as cases
      from messages m
     where m.account_id in (${accounts}) and ${senderMatches(sql`m.from_address`, sql`${contactId}::uuid`)}
     order by m.internal_date desc limit ${limit}`);
  return rows.rows;
}

/** Cuántas veces se ha visto cada canal como remitente. */
export async function channelEvidence(db: Db, contactId: string) {
  const rows = await db.execute<{ id: string; seen: number; since: string | null }>(sql`
    select ch.id,
           (select count(*)::int from messages m where (ch.kind = 'email' and lower(m.from_address) = ch.value)
                or (ch.kind = 'phone' and lower(m.from_address) = ch.value || ${"@" + WHATSAPP_DOMAIN})) as seen,
           (select min(m.internal_date) from messages m where (ch.kind = 'email' and lower(m.from_address) = ch.value)
                or (ch.kind = 'phone' and lower(m.from_address) = ch.value || ${"@" + WHATSAPP_DOMAIN})) as since
      from ct_channels ch where ch.contact_id = ${contactId}`);
  return new Map(rows.rows.map((row) => [row.id, { seen: row.seen, since: row.since }]));
}

export async function casesOf(db: Db, contactId: string, accountIds: string[]) {
  if (!(await hasTable(db, "exp_cases")) || accountIds.length === 0) return [];
  const accounts = sql.join(
    accountIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const parties = (await hasTable(db, "tra_case_parties"))
    ? sql`union select p.case_id, p.role from tra_case_parties p where p.contact_id = ${contactId}`
    : sql``;
  const rows = await db.execute<{
    id: string;
    number: string;
    title: string;
    status: string;
    role: string | null;
  }>(sql`
    with found as (
      select l.target_id as case_id, l.role from ct_links l where l.contact_id = ${contactId} and l.target_kind = 'case'
      ${parties}
      union select cm.case_id, null from exp_case_messages cm join messages m on m.id = cm.message_id
       where ${senderMatches(sql`m.from_address`, sql`${contactId}::uuid`)})
    select e.id, e.number, e.title, e.status, (array_agg(f.role) filter (where f.role is not null))[1] as role
      from exp_cases e join found f on f.case_id = e.id
     where e.account_id in (${accounts})
     group by e.id order by e.status, e.created_at desc limit 50`);
  return rows.rows;
}

export type Suggestion =
  | {
      kind: "nuevo";
      key: string;
      address: string;
      name: string;
      whatsapp: boolean;
      count: number;
      cases: number;
      subject: string;
      messageId: string;
      guess: Role | null;
    }
  | {
      kind: "duplicado";
      key: string;
      contact: { id: string; name: string; detail: string };
      other: { address: string; name: string; whatsapp: boolean };
      reason: string;
      messageId: string | null;
    };

/** Lo que hay por revisar: quien escribe sin ficha y fichas que podrían ser la misma persona. */
/** Buzones que no son de nadie: avisos, boletines y similares. */
const AUTOMATED_SENDER =
  "(^|[._+-])(no-?reply|do-?not-?reply|noreply|notifications?|notificaciones|alertas?|mailer-daemon|postmaster|bounces?|newsletter|boletin|info|news)([._+-]|$)";

export async function suggestions(db: Db, accountIds: string[]): Promise<Suggestion[]> {
  if (accountIds.length === 0) return [];
  const accounts = sql.join(
    accountIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const inCases = (await hasTable(db, "exp_case_messages"))
    ? sql`count(distinct cm.case_id)::int`
    : sql`0`;
  const casesJoin = (await hasTable(db, "exp_case_messages"))
    ? sql`left join exp_case_messages cm on cm.message_id = m.id`
    : sql``;
  const unknown = await db.execute<{
    address: string;
    name: string | null;
    count: number;
    cases: number;
    subjects: string[];
    messageId: string;
  }>(sql`
    select lower(m.from_address) as address, max(m.from_name) as name, count(distinct m.id)::int as count,
           ${inCases} as cases,
           (array_agg(m.subject order by m.internal_date desc))[1:5] as subjects,
           (array_agg(m.id order by m.internal_date desc))[1] as "messageId"
      from messages m ${casesJoin}
     where m.account_id in (${accounts}) and m.from_address <> ''
       and lower(m.from_address) not in (select lower(email) from accounts)
       and lower(m.from_address) not in (select lower(email) from users)
       and not exists (select 1 from ct_channels ch where (ch.kind = 'email' and ch.value = lower(m.from_address))
             or (ch.kind = 'phone' and lower(m.from_address) = ch.value || ${"@" + WHATSAPP_DOMAIN}))
       and not exists (select 1 from ct_dismissed d where d.kind = 'nuevo' and d.key = lower(m.from_address))
       -- Los envíos automáticos (avisos, boletines, respuestas de ausencia) no son contactos.
       and not m.auto_reply
       and split_part(lower(m.from_address), '@', 1) !~ ${AUTOMATED_SENDER}
     group by lower(m.from_address)
    having count(distinct m.id) >= 2 or ${inCases} >= 1
     order by ${inCases} desc, count(distinct m.id) desc limit 40`);

  const contacts = await db.execute<{ id: string; name: string; detail: string }>(sql`
    select c.id, c.name,
           concat_ws(' · ', (select string_agg(r.role, ', ') from ct_roles r where r.contact_id = c.id),
                     (select ch.value from ct_channels ch where ch.contact_id = c.id order by ch.kind, ch.created_at limit 1)) as detail
      from ct_contacts c where not c.archived`);
  const byName = new Map(contacts.rows.map((row) => [nameKey(row.name), row]));
  const dismissed = new Set(
    (
      await db.execute<{ key: string }>(sql`select key from ct_dismissed where kind = 'duplicado'`)
    ).rows.map((row) => row.key),
  );

  const out: Suggestion[] = [];
  const asWhatsApp = (address: string) => address.endsWith(`@${WHATSAPP_DOMAIN}`);

  // Un móvil que aparece en la firma de los correos de una ficha y escribe por WhatsApp sin ficha.
  const unknownPhones = new Map(
    unknown.rows
      .filter((row) => asWhatsApp(row.address))
      .map((row) => [channelOfAddress(row.address).value, row]),
  );
  if (unknownPhones.size > 0) {
    const bodies = await db.execute<{ contactId: string; messageId: string; body: string }>(sql`
      select ch.contact_id as "contactId", m.id as "messageId", m.body_text as body
        from messages m join ct_channels ch on ch.kind = 'email' and ch.value = lower(m.from_address)
       where m.account_id in (${accounts}) and m.body_text is not null
       order by m.internal_date desc limit 2000`);
    for (const row of bodies.rows) {
      for (const phone of phonesIn(row.body)) {
        const other = unknownPhones.get(phone);
        const contact = contacts.rows.find((entry) => entry.id === row.contactId);
        const key = `${row.contactId}:${other?.address}`;
        if (!other || !contact || dismissed.has(key) || out.some((entry) => entry.key === key))
          continue;
        out.push({
          kind: "duplicado",
          key,
          contact,
          other: { address: other.address, name: cleanName(other.name) || phone, whatsapp: true },
          reason: `Su firma de correo trae este móvil.`,
          messageId: row.messageId,
        });
      }
    }
  }
  // Mismo nombre que una ficha, desde otra dirección.
  for (const row of unknown.rows) {
    const match = byName.get(nameKey(row.name ?? ""));
    const key = match ? `${match.id}:${row.address}` : "";
    if (!match || dismissed.has(key) || out.some((entry) => entry.key === key)) continue;
    out.push({
      kind: "duplicado",
      key,
      contact: match,
      other: { address: row.address, name: cleanName(row.name), whatsapp: asWhatsApp(row.address) },
      reason: "Mismo nombre, otra dirección.",
      messageId: row.messageId,
    });
  }
  const paired = new Set(
    out.map((entry) => (entry.kind === "duplicado" ? entry.other.address : "")),
  );
  for (const row of unknown.rows) {
    if (paired.has(row.address)) continue;
    const whatsapp = asWhatsApp(row.address);
    out.push({
      kind: "nuevo",
      key: row.address,
      address: row.address,
      name:
        cleanName(row.name) || (whatsapp ? `+${channelOfAddress(row.address).value}` : row.address),
      whatsapp,
      count: row.count,
      cases: row.cases,
      subject: row.subjects[0] ?? "",
      messageId: row.messageId,
      guess: guessRole({ address: row.address, subjects: row.subjects }),
    });
  }
  return out;
}

/** Une dos fichas: todo lo de `dropId` pasa a `keepId`, también en otros módulos. */
export async function mergeContacts(tx: Tx, keepId: string, dropId: string): Promise<void> {
  await tx.execute(sql`update ct_channels set contact_id = ${keepId} where contact_id = ${dropId}`);
  await tx.execute(sql`
    insert into ct_roles (contact_id, role) select ${keepId}, role from ct_roles where contact_id = ${dropId}
    on conflict do nothing`);
  await tx.execute(sql`
    insert into ct_links (contact_id, target_kind, target_id, role, created_by, created_at)
    select ${keepId}, target_kind, target_id, role, created_by, created_at from ct_links where contact_id = ${dropId}
    on conflict do nothing`);
  await tx.execute(sql`update ct_external set contact_id = ${keepId} where contact_id = ${dropId}`);
  await tx.execute(sql`update ct_contacts set company_id = ${keepId} where company_id = ${dropId}`);
  if (await hasTable(tx, "tra_case_parties")) {
    await tx.execute(sql`
      insert into tra_case_parties (case_id, contact_id, role, reference, added_at)
      select case_id, ${keepId}, role, reference, added_at from tra_case_parties where contact_id = ${dropId}
      on conflict do nothing`);
    await tx.execute(
      sql`update tra_tasks set waiting_contact_id = ${keepId} where waiting_contact_id = ${dropId}`,
    );
  }
  await tx.execute(sql`
    update ct_contacts k set notes = nullif(concat_ws(E'\n\n', k.notes, d.notes), ''), updated_at = now()
      from ct_contacts d where k.id = ${keepId} and d.id = ${dropId}`);
  await tx.execute(sql`delete from ct_contacts where id = ${dropId}`);
}
