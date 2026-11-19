/**
 * Módulo de contactos: una ficha por persona o empresa con todos sus correos y teléfonos,
 * para reconocerla escriba por donde escriba (correo o WhatsApp). Se rellena casi sola, pero
 * nada entra sin que alguien lo confirme: la aplicación propone y una persona decide.
 * La agenda es de toda la oficina; los correos de cada ficha, solo de los buzones que se ven.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accessibleAccountIds, assertAccess } from "../../http/access.ts";
import { audit, HttpError, requireAdmin, requireSession } from "../../http/app.ts";
import type { ServerPlugin } from "../host.ts";
import { channelOfAddress, cleanName, guessRole, normalizeChannel, ROLES } from "./normalize.ts";
import { setupContactos } from "./schema.ts";
import {
  activityOf,
  casesOf,
  channelEvidence,
  contactIdForAddress,
  hasTable,
  listContacts,
  mergeContacts,
  suggestions,
} from "./store.ts";

const idParams = z.object({ id: z.uuid() });
const channelBody = z.object({
  kind: z.enum(["email", "phone"]),
  value: z.string().trim().min(3).max(320),
  label: z.string().trim().max(40).nullable().optional(),
  sourceMessageId: z.uuid().nullable().optional(),
});
const contactBody = z.object({
  kind: z.enum(["persona", "empresa"]).default("persona"),
  name: z.string().trim().min(1).max(160),
  companyId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  channels: z.array(channelBody).max(20).default([]),
});
const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.enum(ROLES).optional(),
  archived: z.enum(["0", "1"]).optional(),
});
const mergeBody = z.object({ keepId: z.uuid(), dropId: z.uuid() });
const dismissBody = z.object({
  kind: z.enum(["nuevo", "duplicado"]),
  key: z.string().min(1).max(400),
});
const addressQuery = z.object({ address: z.string().trim().min(3).max(320) });
const clientBody = z.object({ contactId: z.uuid().nullable() });

class ChannelTaken extends HttpError {
  constructor(value: string, owner: string) {
    super(
      409,
      "channel_taken",
      `${value} ya es de «${owner}». Si son la misma persona, une las fichas.`,
    );
  }
}

export const contactosPlugin: ServerPlugin = {
  id: "contactos",
  name: "Contactos",
  description:
    "Una ficha por persona o empresa con todos sus correos y teléfonos: se la reconoce escriba por correo o por WhatsApp.",
  setup: setupContactos,
  async routes(app, { context }) {
    const { db } = context;

    /** Guarda los canales de una ficha. Uno que ya sea de otra ficha se rechaza con su dueño. */
    async function saveChannels(
      contactId: string,
      channels: z.infer<typeof channelBody>[],
      userId: string,
      replace: boolean,
    ) {
      await db.transaction(async (tx) => {
        if (replace) await tx.execute(sql`delete from ct_channels where contact_id = ${contactId}`);
        for (const channel of channels) {
          const value = normalizeChannel(channel.kind, channel.value);
          const owner = await tx.execute<{ id: string; name: string }>(sql`
            select c.id, c.name from ct_channels ch join ct_contacts c on c.id = ch.contact_id
             where ch.kind = ${channel.kind} and ch.value = ${value}`);
          const taken = owner.rows[0];
          if (taken && taken.id !== contactId) throw new ChannelTaken(channel.value, taken.name);
          if (taken) continue;
          await tx.execute(sql`
            insert into ct_channels (contact_id, kind, value, label, source, source_message_id, created_by)
            values (${contactId}, ${channel.kind}, ${value}, ${channel.label ?? null},
                    ${channel.sourceMessageId ? "correo" : "manual"}, ${channel.sourceMessageId ?? null}, ${userId})`);
        }
      });
    }

    async function detail(userId: string, id: string) {
      const [contact] = await listContacts(db, { ids: [id] }).then(async (rows) =>
        rows.length > 0 ? rows : listContacts(db, { ids: [id], archived: true }),
      );
      if (!contact) throw new HttpError(404, "not_found", "No encontrado.");
      const accountIds = await accessibleAccountIds(db, userId);
      const evidence = await channelEvidence(db, id);
      const members =
        contact.kind === "empresa"
          ? (
              await db.execute<{ id: string; name: string }>(
                sql`select id, name from ct_contacts where company_id = ${id} and not archived order by lower(name)`,
              )
            ).rows
          : [];
      return {
        contact: {
          ...contact,
          channels: contact.channels.map((channel) => ({
            ...channel,
            ...evidence.get(channel.id),
          })),
        },
        members,
        cases: await casesOf(db, id, accountIds),
        activity: await activityOf(db, id, accountIds),
      };
    }

    app.get("/contacts", async (request) => {
      requireSession(request);
      const query = listQuery.parse(request.query);
      const contacts = await listContacts(db, {
        q: query.q,
        role: query.role,
        archived: query.archived === "1",
      });
      const counts = await db.execute<{ role: string; n: number }>(sql`
        select r.role, count(*)::int as n from ct_roles r join ct_contacts c on c.id = r.contact_id
         where not c.archived group by r.role`);
      const total = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from ct_contacts where not archived`,
      );
      return {
        contacts,
        counts: Object.fromEntries(counts.rows.map((row) => [row.role, row.n])),
        total: total.rows[0]!.n,
      };
    });

    app.get("/contacts/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      return detail(user.id, id);
    });

    app.post("/contacts", async (request) => {
      const { user } = requireSession(request);
      const body = contactBody.parse(request.body);
      const [created] = (
        await db.execute<{ id: string }>(sql`
          insert into ct_contacts (kind, name, company_id, notes, created_by)
          values (${body.kind}, ${body.name}, ${body.companyId ?? null}, ${body.notes ?? null}, ${user.id}) returning id`)
      ).rows;
      try {
        await saveChannels(created!.id, body.channels, user.id, false);
      } catch (error) {
        await db.execute(sql`delete from ct_contacts where id = ${created!.id}`);
        throw error;
      }
      for (const role of body.roles) {
        await db.execute(
          sql`insert into ct_roles (contact_id, role) values (${created!.id}, ${role}) on conflict do nothing`,
        );
      }
      await audit(db, {
        userId: user.id,
        action: "plugin.contactos.created",
        target: created!.id,
        detail: { name: body.name },
      });
      return detail(user.id, created!.id);
    });

    app.put("/contacts/:id", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const body = contactBody.parse(request.body);
      if (body.companyId === id)
        throw new HttpError(400, "invalid", "Una ficha no puede ser su propia empresa.");
      const updated = await db.execute(sql`
        update ct_contacts set kind = ${body.kind}, name = ${body.name}, company_id = ${body.companyId ?? null},
               notes = ${body.notes ?? null}, updated_at = now()
         where id = ${id} returning id`);
      if (updated.rows.length === 0) throw new HttpError(404, "not_found", "No encontrado.");
      await saveChannels(id, body.channels, user.id, true);
      await db.transaction(async (tx) => {
        await tx.execute(sql`delete from ct_roles where contact_id = ${id}`);
        for (const role of body.roles) {
          await tx.execute(sql`insert into ct_roles (contact_id, role) values (${id}, ${role})`);
        }
      });
      await audit(db, { userId: user.id, action: "plugin.contactos.updated", target: id });
      return detail(user.id, id);
    });

    // «Es de…»: una dirección que ha escrito pasa a ser de una ficha.
    app.post("/contacts/:id/channels", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const body = channelBody.parse(request.body);
      await saveChannels(id, [body], user.id, false);
      await audit(db, {
        userId: user.id,
        action: "plugin.contactos.channel_added",
        target: id,
        detail: { kind: body.kind },
      });
      return detail(user.id, id);
    });

    app.post("/contacts/:id/archive", async (request) => {
      const { user } = requireAdmin(request);
      const { id } = idParams.parse(request.params);
      const { archived } = z.object({ archived: z.boolean() }).parse(request.body);
      await db.execute(
        sql`update ct_contacts set archived = ${archived}, updated_at = now() where id = ${id}`,
      );
      await audit(db, {
        userId: user.id,
        action: archived ? "plugin.contactos.archived" : "plugin.contactos.restored",
        target: id,
      });
      return detail(user.id, id);
    });

    app.post("/merge", async (request) => {
      const { user } = requireSession(request);
      const { keepId, dropId } = mergeBody.parse(request.body);
      if (keepId === dropId) throw new HttpError(400, "invalid", "Es la misma ficha.");
      await db.transaction((tx) => mergeContacts(tx, keepId, dropId));
      await audit(db, {
        userId: user.id,
        action: "plugin.contactos.merged",
        target: keepId,
        detail: { dropId },
      });
      return detail(user.id, keepId);
    });

    // Por revisar: quien escribe sin ficha y posibles duplicados.
    app.get("/review", async (request) => {
      const { user } = requireSession(request);
      return { suggestions: await suggestions(db, await accessibleAccountIds(db, user.id)) };
    });

    app.post("/review/dismiss", async (request) => {
      const { user } = requireSession(request);
      const { kind, key } = dismissBody.parse(request.body);
      await db.execute(sql`
        insert into ct_dismissed (kind, key, dismissed_by) values (${kind}, ${key}, ${user.id}) on conflict do nothing`);
      return { ok: true };
    });

    // Para el panel de contexto: quién es el remitente, o qué parece si no tiene ficha.
    app.get("/by-address", async (request) => {
      const { user } = requireSession(request);
      const { address } = addressQuery.parse(request.query);
      const id = await contactIdForAddress(db, address);
      if (id) {
        const { contact, cases } = await detail(user.id, id);
        return {
          contact,
          cases: cases.filter((entry) => entry.status === "abierto"),
          suggestion: null,
        };
      }
      const accountIds = await accessibleAccountIds(db, user.id);
      if (accountIds.length === 0) return { contact: null, cases: [], suggestion: null };
      const { kind, value } = channelOfAddress(address);
      const accounts = sql.join(
        accountIds.map((entry) => sql`${entry}::uuid`),
        sql`, `,
      );
      const seen = await db.execute<{
        name: string | null;
        count: number;
        subjects: string[];
        cases: number;
      }>(sql`
        select max(m.from_name) as name, count(*)::int as count, (array_agg(m.subject order by m.internal_date desc))[1:5] as subjects,
               ${(await hasTable(db, "exp_case_messages")) ? sql`(select count(distinct cm.case_id)::int from exp_case_messages cm join messages x on x.id = cm.message_id where lower(x.from_address) = lower(${address}))` : sql`0`} as cases
          from messages m where m.account_id in (${accounts}) and lower(m.from_address) = lower(${address})`);
      const row = seen.rows[0];
      return {
        contact: null,
        cases: [],
        suggestion: {
          name: cleanName(row?.name) || (kind === "phone" ? `+${value}` : value),
          channel: { kind, value },
          count: row?.count ?? 0,
          cases: row?.cases ?? 0,
          guess: guessRole({ address, subjects: row?.subjects ?? [] }),
        },
      };
    });

    // El cliente de un expediente (si el módulo de expedientes está activo).
    async function caseAccount(userId: string, caseId: string) {
      if (!(await hasTable(db, "exp_cases")))
        throw new HttpError(404, "not_found", "No hay expedientes.");
      const [row] = (
        await db.execute<{ accountId: string }>(
          sql`select account_id as "accountId" from exp_cases where id = ${caseId}`,
        )
      ).rows;
      if (!row) throw new HttpError(404, "not_found", "No encontrado.");
      await assertAccess(db, userId, row.accountId);
    }

    app.get("/cases/:id/client", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      await caseAccount(user.id, id);
      const linked = await db.execute<{ contactId: string }>(sql`
        select contact_id as "contactId" from ct_links where target_kind = 'case' and target_id = ${id} and role = 'cliente' limit 1`);
      const clientId = linked.rows[0]?.contactId;
      // Sugerencia: quien escribió el primer correo del expediente, si tiene ficha.
      const first = clientId
        ? null
        : (
            await db.execute<{ address: string }>(sql`
              select m.from_address as address from exp_case_messages cm join messages m on m.id = cm.message_id
               where cm.case_id = ${id} and m.from_address not in (select email from accounts)
               order by m.internal_date limit 1`)
          ).rows[0];
      const suggestedId = first ? await contactIdForAddress(db, first.address) : null;
      const [client] = clientId ? await listContacts(db, { ids: [clientId] }) : [];
      const [suggested] = suggestedId ? await listContacts(db, { ids: [suggestedId] }) : [];
      return {
        client: client ?? null,
        suggested: suggested ?? null,
        suggestedAddress: first?.address ?? null,
      };
    });

    app.put("/cases/:id/client", async (request) => {
      const { user } = requireSession(request);
      const { id } = idParams.parse(request.params);
      const { contactId } = clientBody.parse(request.body);
      await caseAccount(user.id, id);
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`delete from ct_links where target_kind = 'case' and target_id = ${id} and role = 'cliente'`,
        );
        if (contactId) {
          await tx.execute(sql`
            insert into ct_links (contact_id, target_kind, target_id, role, created_by)
            values (${contactId}, 'case', ${id}, 'cliente', ${user.id})`);
          await tx.execute(
            sql`insert into ct_roles (contact_id, role) values (${contactId}, 'cliente') on conflict do nothing`,
          );
        }
      });
      await audit(db, {
        userId: user.id,
        action: "plugin.contactos.case_client",
        target: id,
        detail: { contactId },
      });
      return { ok: true };
    });
  },
};
