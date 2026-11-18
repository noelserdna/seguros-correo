/**
 * Módulo de expedientes: prueba que un plugin puede tener datos propios,
 * rutas y reaccionar al correo que llega, sin tocar el núcleo. Requiere `pnpm dev:up`.
 */
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "../src/auth/sessions.ts";
import { createUser } from "../src/auth/users.ts";
import { eq } from "drizzle-orm";
import { accountAccess, messages } from "../src/db/schema.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import { expedientesPlugin } from "../src/plugins/expedientes/index.ts";
import { PluginHost } from "../src/plugins/host.ts";
import {
  ANA,
  LUIS,
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

let env: TestEnv;
let app: FastifyInstance;
let host: PluginHost;
let outlook: ImapFlow;
let account: Account;
let marta: User;
let pedro: User;
let session: Login;

type Login = { cookie: string; csrf: string };
type Case = { id: string; number: string; title: string };
type CaseDetail = {
  case: Case & { insurerId: string | null; insurerName: string | null };
  messages: { id: string; subject: string; how: string; mailbox: string; excluded: boolean }[];
};
type ByMessage = { cases: CaseDetail[] };

async function login(email: string): Promise<Login> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
  return {
    cookie: `${SESSION_COOKIE}=${cookie?.value}`,
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
}

const call = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
  as = session,
) =>
  app.inject({
    method,
    url,
    headers: { cookie: as.cookie, [CSRF_HEADER]: as.csrf },
    ...(payload ? { payload } : {}),
  });

/** Sincroniza y reparte los eventos a los plugins, como hace el servidor en marcha. */
async function settle(): Promise<void> {
  await syncAll(env, account);
  await host.drain();
}

async function inbox(): Promise<{ id: string; subject: string }[]> {
  const folders = await call("GET", `/api/accounts/${account.id}/folders`);
  const folder = folders
    .json<{ folders: { id: string; path: string }[] }>()
    .folders.find((entry) => entry.path === "INBOX")!;
  const list = await call("GET", `/api/folders/${folder.id}/messages`);
  return list.json<{ items: { id: string; subject: string }[] }>().items;
}

const idOf = async (subject: string) =>
  (await inbox()).find((item) => item.subject === subject)!.id;

beforeAll(async () => {
  env = await openTestEnv();
  host = new PluginHost(env.db, [expedientesPlugin]);
  await host.setup();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await host.setup();
  await resetMailbox(ANA);
  await resetMailbox(LUIS);
  outlook = await otherClient(ANA);
  account = await createTestAccount(env);
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    rawStore: env.rawStore,
    plugins: [expedientesPlugin],
  });
  marta = await createUser(env.db, { email: "marta@c.test", name: "Marta", password: PASSWORD });
  pedro = await createUser(env.db, { email: "pedro@c.test", name: "Pedro", password: PASSWORD });
  await env.db.insert(accountAccess).values({ userId: marta.id, accountId: account.id });
  session = await login(marta.email);
});
afterEach(async () => {
  await app.close();
  await outlook.logout().catch(() => undefined);
});

describe("módulo de expedientes", () => {
  it("crea un expediente desde un correo y mete en él toda su conversación", async () => {
    await appendMail(outlook, { subject: "Golpe en el camión", messageId: "<a@exp.test>" });
    await appendMail(outlook, {
      subject: "RE: Golpe en el camión",
      messageId: "<b@exp.test>",
      inReplyTo: "<a@exp.test>",
      references: ["<a@exp.test>"],
    });
    await appendMail(outlook, { subject: "Otra cosa" });
    await settle();

    const created = await call("POST", "/api/plugins/expedientes/cases", {
      messageId: await idOf("Golpe en el camión"),
    });
    const body = created.json<{ case: Case; created: boolean }>();
    expect(body.created).toBe(true);
    expect(body.case.number).toMatch(/^EXP-\d{4}-\d{4}$/);
    expect(body.case.title).toBe("Golpe en el camión");

    const detail = await call("GET", `/api/plugins/expedientes/cases/${body.case.id}`);
    expect(detail.json<CaseDetail>().messages.map((m) => [m.subject, m.how])).toEqual([
      ["Golpe en el camión", "manual"],
      ["RE: Golpe en el camión", "thread"],
    ]);

    // Un mismo correo puede estar en dos expedientes (por ejemplo, si trata de dos siniestros).
    const second = (
      await call("POST", "/api/plugins/expedientes/cases", { messageId: await idOf("Otra cosa") })
    ).json<{ case: Case }>().case;
    const shared = await idOf("RE: Golpe en el camión");
    const added = await call("POST", `/api/plugins/expedientes/cases/${second.id}/messages`, {
      messageId: shared,
    });
    // Al añadirlo entra también el resto de su conversación.
    expect(added.json<{ added: boolean; count: number }>()).toMatchObject({
      added: true,
      count: 2,
    });
    const secondDetail = await call("GET", `/api/plugins/expedientes/cases/${second.id}`);
    expect(
      secondDetail
        .json<CaseDetail>()
        .messages.map((m) => m.subject)
        .sort(),
    ).toEqual(["Golpe en el camión", "Otra cosa", "RE: Golpe en el camión"]);
    const repeated = await call("POST", `/api/plugins/expedientes/cases/${second.id}/messages`, {
      messageId: shared,
    });
    expect(repeated.json<{ added: boolean }>().added).toBe(false);

    const both = await call("GET", `/api/plugins/expedientes/by-message/${shared}`);
    expect(both.json<ByMessage>().cases.map((entry) => entry.case.number)).toEqual([
      body.case.number,
      second.number,
    ]);
    const labels = await call("POST", "/api/plugins/expedientes/labels", { messageIds: [shared] });
    expect(labels.json<{ labels: Record<string, string[]> }>().labels[shared]).toEqual([
      body.case.number,
      second.number,
    ]);
  });

  it("asigna solos los correos que llegan después: por conversación y por número en el asunto", async () => {
    await appendMail(outlook, { subject: "Rotura de lunas", messageId: "<lunas@exp.test>" });
    await settle();
    const { case: opened } = (
      await call("POST", "/api/plugins/expedientes/cases", {
        messageId: await idOf("Rotura de lunas"),
      })
    ).json<{ case: Case }>();

    await appendMail(outlook, {
      from: LUIS,
      subject: "RE: Rotura de lunas",
      inReplyTo: "<lunas@exp.test>",
      references: ["<lunas@exp.test>"],
    });
    await appendMail(outlook, { from: LUIS, subject: `Peritación ${opened.number.toLowerCase()}` });
    await appendMail(outlook, { from: LUIS, subject: "Publicidad EXP-1999-0000" });
    await appendMail(outlook, { from: LUIS, subject: "Sin relación" });
    await settle();

    const detail = await call("GET", `/api/plugins/expedientes/cases/${opened.id}`);
    // Los tres llegan en el mismo segundo: se compara sin depender del orden.
    const assigned = detail.json<CaseDetail>().messages.map((m) => `${m.subject} · ${m.how}`);
    expect(assigned.sort()).toEqual(
      [
        "Rotura de lunas · manual",
        "RE: Rotura de lunas · thread",
        `Peritación ${opened.number.toLowerCase()} · reference`,
      ].sort(),
    );

    // Repartir de nuevo los eventos no duplica nada.
    expect(await host.drain()).toBe(0);

    // La lista sabe qué correos llevan etiqueta, y el panel de contexto ve el expediente.
    const items = await inbox();
    const labels = await call("POST", "/api/plugins/expedientes/labels", {
      messageIds: items.map((item) => item.id),
    });
    const labelled = labels.json<{ labels: Record<string, string[]> }>().labels;
    expect(items.filter((item) => labelled[item.id]?.includes(opened.number))).toHaveLength(3);
    expect(labelled[await idOf("Sin relación")]).toBeUndefined();

    const context = await call(
      "GET",
      `/api/plugins/expedientes/by-message/${await idOf("RE: Rotura de lunas")}`,
    );
    const [inContext] = context.json<ByMessage>().cases;
    expect(inContext).toMatchObject({ case: { number: opened.number } });
    expect(inContext?.messages).toHaveLength(3);

    const list = await call("GET", "/api/plugins/expedientes/cases");
    expect(list.json<{ cases: { number: string; messageCount: number }[] }>().cases).toMatchObject([
      { number: opened.number, messageCount: 3 },
    ]);
  });

  it("añade a un expediente un correo de otro buzón y lo quita, sin tocar el correo", async () => {
    const other = await createTestAccount(env, LUIS);
    await env.db.insert(accountAccess).values({ userId: marta.id, accountId: other.id });
    const luisBox = await otherClient(LUIS);
    try {
      await appendMail(luisBox, { from: ANA, to: LUIS, subject: "Llegó a otro buzón" }, "INBOX");
    } finally {
      await luisBox.logout();
    }
    await appendMail(outlook, { subject: "Siniestro principal" });
    await syncAll(env, account);
    await syncAll(env, other);
    await host.drain();

    const opened = (
      await call("POST", "/api/plugins/expedientes/cases", {
        messageId: await idOf("Siniestro principal"),
      })
    ).json<{ case: Case }>().case;
    const [foreign] = await env.db
      .select()
      .from(messages)
      .where(eq(messages.subject, "Llegó a otro buzón"));

    await call("POST", `/api/plugins/expedientes/cases/${opened.id}/messages`, {
      messageId: foreign!.id,
    });
    const detail = (
      await call("GET", `/api/plugins/expedientes/cases/${opened.id}`)
    ).json<CaseDetail>();
    expect(detail.messages.map((entry) => `${entry.subject} · ${entry.mailbox}`).sort()).toEqual([
      `Llegó a otro buzón · ${LUIS}`,
      `Siniestro principal · ${ANA}`,
    ]);

    // Quien solo tiene el buzón del expediente ve el expediente, pero no el correo ajeno.
    await env.db.insert(accountAccess).values({ userId: pedro.id, accountId: account.id });
    const partial = await login(pedro.email);
    const seen = (
      await call("GET", `/api/plugins/expedientes/cases/${opened.id}`, undefined, partial)
    ).json<CaseDetail>();
    expect(seen.messages.map((entry) => entry.subject)).toEqual(["Siniestro principal"]);
    const denied = await call(
      "POST",
      `/api/plugins/expedientes/cases/${opened.id}/messages`,
      { messageId: foreign!.id },
      partial,
    );
    expect(denied.statusCode).toBe(404);

    const removed = await call(
      "DELETE",
      `/api/plugins/expedientes/cases/${opened.id}/messages/${foreign!.id}`,
    );
    expect(removed.statusCode).toBe(200);
    const after = (
      await call("GET", `/api/plugins/expedientes/cases/${opened.id}`)
    ).json<CaseDetail>();
    expect(after.messages.map((entry) => entry.subject)).toEqual(["Siniestro principal"]);
    expect(await env.db.select().from(messages).where(eq(messages.id, foreign!.id))).toHaveLength(
      1,
    );
    const again = await call(
      "DELETE",
      `/api/plugins/expedientes/cases/${opened.id}/messages/${foreign!.id}`,
    );
    expect(again.statusCode).toBe(404);
  });

  it("excluye un correo del contexto sin sacarlo del expediente; quitar saca la conversación entera", async () => {
    await appendMail(outlook, { subject: "Daños por agua", messageId: "<agua@exp.test>" });
    await appendMail(outlook, {
      subject: "RE: Daños por agua",
      messageId: "<agua2@exp.test>",
      inReplyTo: "<agua@exp.test>",
      references: ["<agua@exp.test>"],
    });
    await settle();
    const first = await idOf("Daños por agua");
    const reply = await idOf("RE: Daños por agua");
    const opened = (
      await call("POST", "/api/plugins/expedientes/cases", { messageId: first })
    ).json<{
      case: Case;
    }>().case;
    const url = `/api/plugins/expedientes/cases/${opened.id}`;
    const state = async () =>
      Object.fromEntries(
        (await call("GET", url)).json<CaseDetail>().messages.map((m) => [m.subject, m.excluded]),
      );

    const excluded = await call("PUT", `${url}/messages/${reply}`, { excluded: true });
    expect(excluded.statusCode).toBe(200);
    expect(await state()).toEqual({ "Daños por agua": false, "RE: Daños por agua": true });
    await call("PUT", `${url}/messages/${reply}`, { excluded: false });
    expect(await state()).toEqual({ "Daños por agua": false, "RE: Daños por agua": false });

    // Quitar uno saca los dos: la conversación entra o sale entera.
    const removed = await call("DELETE", `${url}/messages/${reply}`);
    expect(removed.json<{ count: number }>().count).toBe(2);
    expect(await state()).toEqual({});
    // Y lo que llegue después a ese hilo ya no entra solo.
    await appendMail(outlook, {
      subject: "RE: RE: Daños por agua",
      inReplyTo: "<agua2@exp.test>",
      references: ["<agua@exp.test>", "<agua2@exp.test>"],
    });
    await settle();
    expect(await state()).toEqual({});
  });

  it("lleva un catálogo de aseguradoras que solo cambia un administrador, y cada expediente elige la suya", async () => {
    const admin = await createUser(env.db, {
      email: "admin@c.test",
      name: "Admin",
      password: PASSWORD,
      role: "admin",
    });
    const boss = await login(admin.email);
    type Insurer = { id: string; name: string; caseCount: number };
    const insurers = async () =>
      (await call("GET", "/api/plugins/expedientes/insurers")).json<{ insurers: Insurer[] }>()
        .insurers;

    expect(
      (await call("POST", "/api/plugins/expedientes/insurers", { name: "Albor" })).statusCode,
    ).toBe(403);
    const albor = (
      await call("POST", "/api/plugins/expedientes/insurers", { name: " Seguros Albor " }, boss)
    ).json<{ insurer: Insurer }>().insurer;
    await call("POST", "/api/plugins/expedientes/insurers", { name: "Mutua del Ebro" }, boss);
    const repeated = await call(
      "POST",
      "/api/plugins/expedientes/insurers",
      { name: "seguros albor" },
      boss,
    );
    expect(repeated.statusCode).toBe(409);
    expect((await insurers()).map((entry) => entry.name)).toEqual([
      "Mutua del Ebro",
      "Seguros Albor",
    ]);

    await appendMail(outlook, { subject: "Con aseguradora" });
    await settle();
    const opened = (
      await call("POST", "/api/plugins/expedientes/cases", {
        messageId: await idOf("Con aseguradora"),
      })
    ).json<{ case: Case }>().case;
    const set = await call("PUT", `/api/plugins/expedientes/cases/${opened.id}`, {
      insurerId: albor.id,
    });
    expect(set.json<CaseDetail>().case).toMatchObject({ insurerName: "Seguros Albor" });
    expect((await insurers()).find((entry) => entry.id === albor.id)?.caseCount).toBe(1);

    // Quitarla del catálogo deja el expediente sin aseguradora, no lo borra.
    expect((await call("DELETE", `/api/plugins/expedientes/insurers/${albor.id}`)).statusCode).toBe(
      403,
    );
    expect(
      (await call("DELETE", `/api/plugins/expedientes/insurers/${albor.id}`, undefined, boss))
        .statusCode,
    ).toBe(200);
    const after = (
      await call("GET", `/api/plugins/expedientes/cases/${opened.id}`)
    ).json<CaseDetail>();
    expect(after.case).toMatchObject({ number: opened.number, insurerId: null, insurerName: null });
  });

  it("respeta los permisos del buzón: quien no lo tiene no ve ni crea expedientes", async () => {
    await appendMail(outlook, { subject: "Reservado" });
    await settle();
    const messageId = await idOf("Reservado");
    const { case: opened } = (
      await call("POST", "/api/plugins/expedientes/cases", { messageId })
    ).json<{
      case: Case;
    }>();

    const stranger = await login(pedro.email);
    expect(
      (await call("POST", "/api/plugins/expedientes/cases", { messageId }, stranger)).statusCode,
    ).toBe(404);
    expect(
      (await call("GET", `/api/plugins/expedientes/cases/${opened.id}`, undefined, stranger))
        .statusCode,
    ).toBe(404);
    expect(
      (await call("GET", `/api/plugins/expedientes/by-message/${messageId}`, undefined, stranger))
        .statusCode,
    ).toBe(404);
    expect(
      (await call("GET", "/api/plugins/expedientes/cases", undefined, stranger)).json<{
        cases: unknown[];
      }>().cases,
    ).toEqual([]);
    const labels = await call(
      "POST",
      "/api/plugins/expedientes/labels",
      { messageIds: [messageId] },
      stranger,
    );
    expect(labels.json<{ labels: object }>().labels).toEqual({});
  });
});
