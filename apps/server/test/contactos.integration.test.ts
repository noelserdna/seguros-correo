/**
 * Agenda de contactos de punta a punta: fichas con varios correos y teléfonos, quién escribe
 * desde qué dirección (también por WhatsApp), qué falta por revisar, unir fichas, el cliente
 * de un expediente y el paso del antiguo directorio de la tramitación a la agenda.
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../src/auth/users.ts";
import { accountAccess } from "../src/db/schema.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import { contactosPlugin } from "../src/plugins/contactos/index.ts";
import { normalizePhone, phonesIn } from "../src/plugins/contactos/normalize.ts";
import { expedientesPlugin } from "../src/plugins/expedientes/index.ts";
import { orderPlugins, PluginHost } from "../src/plugins/host.ts";
import { tramitacionPlugin } from "../src/plugins/tramitacion/index.ts";
import {
  ANA,
  appendMail,
  createTestAccount,
  openTestEnv,
  otherClient,
  resetDb,
  resetMailbox,
  syncAll,
  type TestEnv,
} from "./helpers.ts";

const PASSWORD = "contraseña-de-prueba";
const C = "/api/plugins/contactos";

let env: TestEnv;
let app: FastifyInstance;
let host: PluginHost;
let outlook: ImapFlow;
let account: Account;
let session: { cookie: string; csrf: string };

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
    ...(payload ? { payload } : {}),
  });

type Contact = {
  id: string;
  name: string;
  roles: string[];
  channels: { kind: string; value: string }[];
};

beforeAll(async () => {
  env = await openTestEnv();
  host = new PluginHost(
    env.db,
    orderPlugins([tramitacionPlugin, expedientesPlugin, contactosPlugin]),
  );
  await host.setup();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await env.db.execute(sql`truncate table ct_contacts, ct_dismissed cascade`);
  await resetMailbox(ANA);
  outlook = await otherClient(ANA);
  account = await createTestAccount(env);
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    rawStore: env.rawStore,
    plugins: [expedientesPlugin, contactosPlugin, tramitacionPlugin],
  });
  const marta = await createUser(env.db, {
    email: "marta@c.test",
    name: "Marta",
    password: PASSWORD,
  });
  await env.db.insert(accountAccess).values({ userId: marta.id, accountId: account.id });
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: marta.email, password: PASSWORD },
  });
  const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
  session = {
    cookie: `${SESSION_COOKIE}=${cookie?.value}`,
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
});
afterEach(async () => {
  await app.close();
  await outlook.logout().catch(() => undefined);
});

const create = async (body: object) => {
  const response = await call("POST", `${C}/contacts`, body);
  expect(response.statusCode).toBe(200);
  return response.json<{ contact: Contact }>().contact;
};
const idOf = async (subject: string) =>
  (await env.db.execute<{ id: string }>(sql`select id from messages where subject = ${subject}`))
    .rows[0]!.id;

describe("contactos", () => {
  it("normaliza teléfonos y los encuentra en una firma", () => {
    expect(normalizePhone("+34 600 111 222")).toBe("34600111222");
    expect(normalizePhone("600111222")).toBe("34600111222");
    expect(normalizePhone("0034 600 111 222")).toBe("34600111222");
    expect(phonesIn("Un saludo,\nPilar\nMóvil 600 111 222 · Oficina 974.000.120")).toEqual([
      "34600111222",
      "34974000120",
    ]);
  });

  it("una ficha con varios canales; cada canal de una sola ficha; se busca por teléfono", async () => {
    const pilar = await create({
      name: "Pilar Ferrer",
      roles: ["cliente"],
      channels: [
        { kind: "email", value: "Pilar@Rio.test" },
        { kind: "phone", value: "600 111 222", label: "WhatsApp" },
      ],
    });
    expect(pilar.channels.map((channel) => [channel.kind, channel.value])).toEqual([
      ["email", "pilar@rio.test"],
      ["phone", "34600111222"],
    ]);
    const taken = await call("POST", `${C}/contacts`, {
      name: "Otra",
      channels: [{ kind: "phone", value: "+34600111222" }],
    });
    expect(taken.statusCode).toBe(409);
    const found = (await call("GET", `${C}/contacts?q=111222`)).json<{ contacts: Contact[] }>()
      .contacts;
    expect(found.map((contact) => contact.name)).toEqual(["Pilar Ferrer"]);
    const byRole = (await call("GET", `${C}/contacts?role=cliente`)).json<{
      counts: Record<string, number>;
    }>();
    expect(byRole.counts.cliente).toBe(1);
  });

  it("reconoce al remitente por correo o por WhatsApp, y propone lo que falta por revisar", async () => {
    const pilar = await create({
      name: "Pilar Ferrer",
      roles: ["cliente"],
      channels: [{ kind: "email", value: "pilar@rio.test" }],
    });
    await appendMail(outlook, {
      from: "Pilar Ferrer <pilar@rio.test>",
      subject: "Documentación",
      text: "Os mando el DNI.\n\nPilar Ferrer\nMóvil 600 111 222",
    });
    await appendMail(outlook, {
      from: "Pilar Ferrer · WhatsApp <34600111222@whatsapp.invalid>",
      subject: "WhatsApp · Pilar",
      text: "Hola",
    });
    await appendMail(outlook, {
      from: "Pilar Ferrer · WhatsApp <34600111222@whatsapp.invalid>",
      subject: "WhatsApp · Pilar",
      text: "¿Me llamáis?",
    });
    await appendMail(outlook, {
      from: "Gabinete Pericial <gabinete@ebro.test>",
      subject: "Informe pericial 7192-LKX",
      text: "Adjunto.",
    });
    await appendMail(outlook, {
      from: "Gabinete Pericial <gabinete@ebro.test>",
      subject: "Cita de peritación",
      text: "Jueves.",
    });
    await syncAll(env, account);

    const byMail = (await call("GET", `${C}/by-address?address=pilar@rio.test`)).json<{
      contact: Contact | null;
    }>();
    expect(byMail.contact?.id).toBe(pilar.id);
    const unknown = (await call("GET", `${C}/by-address?address=gabinete@ebro.test`)).json<{
      contact: null;
      suggestion: { name: string; guess: string; count: number };
    }>();
    expect(unknown.suggestion).toMatchObject({
      name: "Gabinete Pericial",
      guess: "perito",
      count: 2,
    });

    // El móvil de la firma de Pilar escribe por WhatsApp: se propone unirlo a su ficha.
    const review = (await call("GET", `${C}/review`)).json<{
      suggestions: {
        kind: string;
        key: string;
        reason?: string;
        guess?: string;
        contact?: { id: string };
      }[];
    }>().suggestions;
    const duplicate = review.find((entry) => entry.kind === "duplicado");
    expect(duplicate).toMatchObject({
      contact: { id: pilar.id },
      reason: "Su firma de correo trae este móvil.",
    });
    const fresh = review.find((entry) => entry.kind === "nuevo");
    expect(fresh).toMatchObject({ key: "gabinete@ebro.test", guess: "perito" });

    // «Es de…»: el WhatsApp pasa a la ficha y ya se reconoce.
    await call("POST", `${C}/contacts/${pilar.id}/channels`, {
      kind: "phone",
      value: "34600111222",
      sourceMessageId: await idOf("Documentación"),
    });
    const byWhatsApp = (
      await call("GET", `${C}/by-address?address=34600111222@whatsapp.invalid`)
    ).json<{ contact: Contact | null }>();
    expect(byWhatsApp.contact?.id).toBe(pilar.id);

    // Descartar una sugerencia: no vuelve.
    await call("POST", `${C}/review/dismiss`, { kind: "nuevo", key: "gabinete@ebro.test" });
    const after = (await call("GET", `${C}/review`)).json<{ suggestions: { key: string }[] }>()
      .suggestions;
    expect(after.map((entry) => entry.key)).toEqual([]);

    // La ficha enseña lo último que ha mandado, por correo y por WhatsApp.
    const detail = (await call("GET", `${C}/contacts/${pilar.id}`)).json<{
      activity: { subject: string; whatsapp: boolean }[];
    }>();
    expect(detail.activity).toHaveLength(3);
    expect(detail.activity.filter((entry) => entry.whatsapp)).toHaveLength(2);
  });

  it("unir dos fichas lleva canales, papeles e intervinientes a la que se queda", async () => {
    const a = await create({
      name: "Talleres Ebro",
      roles: ["taller"],
      channels: [{ kind: "email", value: "taller@ebro.test" }],
    });
    const b = await create({
      name: "Talleres Ebro S.L.",
      roles: ["otro"],
      channels: [{ kind: "phone", value: "976000333" }],
    });
    const merged = (await call("POST", `${C}/merge`, { keepId: a.id, dropId: b.id })).json<{
      contact: Contact;
    }>().contact;
    expect(merged.channels.map((channel) => channel.value).sort()).toEqual([
      "34976000333",
      "taller@ebro.test",
    ]);
    expect(merged.roles).toEqual(["otro", "taller"]);
    expect((await call("GET", `${C}/contacts/${b.id}`)).statusCode).toBe(404);
  });

  it("el cliente del expediente: se propone quien escribió el primer correo", async () => {
    const oscar = await create({
      name: "Óscar Biel",
      channels: [{ kind: "email", value: "oscar@biel.test" }],
    });
    await appendMail(outlook, {
      from: "Óscar Biel <oscar@biel.test>",
      subject: "Atestado 7781-JVM",
      text: "Os mando el atestado.",
    });
    await syncAll(env, account);
    const kase = (
      await call("POST", "/api/plugins/expedientes/cases", {
        messageId: await idOf("Atestado 7781-JVM"),
      })
    ).json<{ case: { id: string } }>().case;
    const before = (await call("GET", `${C}/cases/${kase.id}/client`)).json<{
      client: null;
      suggested: Contact;
    }>();
    expect(before.client).toBeNull();
    expect(before.suggested.id).toBe(oscar.id);
    await call("PUT", `${C}/cases/${kase.id}/client`, { contactId: oscar.id });
    const after = (await call("GET", `${C}/cases/${kase.id}/client`)).json<{ client: Contact }>();
    expect(after.client.id).toBe(oscar.id);
    expect(after.client.roles).toContain("cliente");
    const list = (await call("GET", `${C}/contacts?q=oscar`)).json<{
      contacts: { openCases: number }[];
    }>();
    expect(list.contacts[0]!.openCases).toBe(1);

    // Otro correo del cliente: antes de abrir otro expediente, se avisa del que ya tiene.
    // De un tercero con ficha (la aseguradora escribe en muchos) no se avisa.
    await create({
      kind: "empresa",
      name: "Mutua del Ebro",
      roles: ["aseguradora"],
      channels: [{ kind: "email", value: "siniestros@mutua.test" }],
    });
    await appendMail(outlook, {
      from: "Óscar Biel <oscar@biel.test>",
      subject: "Otro golpe",
      text: "Hola de nuevo.",
    });
    await appendMail(outlook, {
      from: "Mutua del Ebro <siniestros@mutua.test>",
      subject: "Alta de siniestro",
      text: "Alta.",
    });
    await syncAll(env, account);
    const already = (
      await call("GET", `/api/plugins/expedientes/open-of-sender/${await idOf("Otro golpe")}`)
    ).json<{ cases: { id: string }[] }>().cases;
    expect(already.map((entry) => entry.id)).toEqual([kase.id]);
    // La mutua no ha escrito en el expediente, pero aunque lo hubiera hecho no avisaría.
    await call("POST", `/api/plugins/expedientes/cases/${kase.id}/messages`, {
      messageId: await idOf("Alta de siniestro"),
    });
    await appendMail(outlook, {
      from: "Mutua del Ebro <siniestros@mutua.test>",
      subject: "Otra alta",
      text: "Alta.",
    });
    await syncAll(env, account);
    const insurer = (
      await call("GET", `/api/plugins/expedientes/open-of-sender/${await idOf("Otra alta")}`)
    ).json<{ cases: unknown[] }>().cases;
    expect(insurer).toEqual([]);
  });

  it("el directorio antiguo de la tramitación pasa a la agenda con los mismos identificadores", async () => {
    await env.db.execute(sql`
      create table tra_contacts (id uuid primary key default gen_random_uuid(), role text not null, name text not null,
        email text, phone text, notes text, active boolean not null default true, created_by uuid,
        created_at timestamptz not null default now())`);
    const [old] = (
      await env.db.execute<{ id: string }>(sql`
        insert into tra_contacts (role, name, email, phone) values ('perito', 'Peritaciones Norte', ' Informes@Norte.test ', '976 000 111')
        returning id`)
    ).rows;
    await host.setup();
    const [migrated] = (await call("GET", `${C}/contacts`)).json<{ contacts: Contact[] }>()
      .contacts;
    expect(migrated).toMatchObject({ id: old!.id, name: "Peritaciones Norte", roles: ["perito"] });
    expect(migrated!.channels.map((channel) => channel.value).sort()).toEqual([
      "34976000111",
      "informes@norte.test",
    ]);
    const gone = await env.db.execute<{ ok: boolean }>(
      sql`select to_regclass('tra_contacts') is null as ok`,
    );
    expect(gone.rows[0]!.ok).toBe(true);
  });
});
