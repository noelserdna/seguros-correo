/**
 * Plugin de demostración (expedientes): prueba que un plugin puede tener datos propios,
 * rutas y reaccionar al correo que llega, sin tocar el núcleo. Requiere `pnpm dev:up`.
 */
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "../src/auth/sessions.ts";
import { createUser } from "../src/auth/users.ts";
import { accountAccess } from "../src/db/schema.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import { demoPlugin } from "../src/plugins/demo/index.ts";
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
type CaseDetail = { case: Case | null; messages: { subject: string; how: string }[] };

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

const call = (method: "GET" | "POST", url: string, payload?: object, as = session) =>
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
  host = new PluginHost(env.db, [demoPlugin]);
  await host.setup();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await host.setup();
  await resetMailbox(ANA);
  outlook = await otherClient(ANA);
  account = await createTestAccount(env);
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    rawStore: env.rawStore,
    plugins: [demoPlugin],
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

describe("expedientes (plugin de demostración)", () => {
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

    const created = await call("POST", "/api/plugins/demo/cases", {
      messageId: await idOf("Golpe en el camión"),
    });
    const body = created.json<{ case: Case; created: boolean }>();
    expect(body.created).toBe(true);
    expect(body.case.number).toMatch(/^EXP-\d{4}-\d{4}$/);
    expect(body.case.title).toBe("Golpe en el camión");

    const detail = await call("GET", `/api/plugins/demo/cases/${body.case.id}`);
    expect(detail.json<CaseDetail>().messages.map((m) => [m.subject, m.how])).toEqual([
      ["Golpe en el camión", "manual"],
      ["RE: Golpe en el camión", "thread"],
    ]);

    // Pedirlo otra vez desde un correo que ya está dentro no crea otro.
    const again = await call("POST", "/api/plugins/demo/cases", {
      messageId: await idOf("RE: Golpe en el camión"),
    });
    expect(again.json<{ case: Case; created: boolean }>()).toMatchObject({
      created: false,
      case: { id: body.case.id },
    });
  });

  it("asigna solos los correos que llegan después: por conversación y por número en el asunto", async () => {
    await appendMail(outlook, { subject: "Rotura de lunas", messageId: "<lunas@exp.test>" });
    await settle();
    const { case: opened } = (
      await call("POST", "/api/plugins/demo/cases", { messageId: await idOf("Rotura de lunas") })
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

    const detail = await call("GET", `/api/plugins/demo/cases/${opened.id}`);
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
    const labels = await call("POST", "/api/plugins/demo/labels", {
      messageIds: items.map((item) => item.id),
    });
    const labelled = labels.json<{ labels: Record<string, { number: string }> }>().labels;
    expect(
      items.filter((item) => labelled[item.id]?.number === opened.number).map((i) => i.subject),
    ).toHaveLength(3);
    expect(labelled[await idOf("Sin relación")]).toBeUndefined();

    const context = await call(
      "GET",
      `/api/plugins/demo/by-message/${await idOf("RE: Rotura de lunas")}`,
    );
    expect(context.json<CaseDetail>()).toMatchObject({ case: { number: opened.number } });
    expect(context.json<CaseDetail>().messages).toHaveLength(3);

    const list = await call("GET", "/api/plugins/demo/cases");
    expect(list.json<{ cases: { number: string; messageCount: number }[] }>().cases).toMatchObject([
      { number: opened.number, messageCount: 3 },
    ]);
  });

  it("respeta los permisos del buzón: quien no lo tiene no ve ni crea expedientes", async () => {
    await appendMail(outlook, { subject: "Reservado" });
    await settle();
    const messageId = await idOf("Reservado");
    const { case: opened } = (await call("POST", "/api/plugins/demo/cases", { messageId })).json<{
      case: Case;
    }>();

    const stranger = await login(pedro.email);
    expect(
      (await call("POST", "/api/plugins/demo/cases", { messageId }, stranger)).statusCode,
    ).toBe(404);
    expect(
      (await call("GET", `/api/plugins/demo/cases/${opened.id}`, undefined, stranger)).statusCode,
    ).toBe(404);
    expect(
      (await call("GET", `/api/plugins/demo/by-message/${messageId}`, undefined, stranger))
        .statusCode,
    ).toBe(404);
    expect(
      (await call("GET", "/api/plugins/demo/cases", undefined, stranger)).json<{
        cases: unknown[];
      }>().cases,
    ).toEqual([]);
    const labels = await call(
      "POST",
      "/api/plugins/demo/labels",
      { messageIds: [messageId] },
      stranger,
    );
    expect(labels.json<{ labels: object }>().labels).toEqual({});
  });
});
