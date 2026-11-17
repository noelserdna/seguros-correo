/**
 * API HTTP: acceso, sesiones, permisos por buzón y lectura. Requiere `pnpm dev:up`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttemptLimiter } from "../src/auth/rate-limit.ts";
import type { User } from "../src/auth/sessions.ts";
import { createUser } from "../src/auth/users.ts";
import { accountAccess, auditLog } from "../src/db/schema.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import {
  ANA,
  accountInput,
  appendMail,
  createTestAccount,
  inFolder,
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
let created: Account[];
let admin: User;
let tramitador: User;
let ajeno: User;

type Login = { cookie: string; csrf: string };

async function login(email: string, password = PASSWORD): Promise<Login> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
  return {
    cookie: `${SESSION_COOKIE}=${cookie?.value}`,
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
}

const get = (url: string, session?: Login) =>
  app.inject({ method: "GET", url, headers: session ? { cookie: session.cookie } : {} });

const send = (method: "POST" | "PUT" | "DELETE", url: string, session: Login, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
    ...(payload ? { payload } : {}),
  });

beforeAll(async () => {
  env = await openTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  created = [];
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    limiter: new AttemptLimiter(5, 60_000),
    onAccountCreated: (account) => created.push(account),
  });
  admin = await createUser(env.db, {
    email: "admin@correduria.test",
    name: "Admin",
    password: PASSWORD,
    role: "admin",
  });
  tramitador = await createUser(env.db, {
    email: "marta@correduria.test",
    name: "Marta",
    password: PASSWORD,
  });
  ajeno = await createUser(env.db, {
    email: "pedro@correduria.test",
    name: "Pedro",
    password: PASSWORD,
  });
});
afterEach(async () => {
  await app.close();
});

describe("acceso", () => {
  it("abre sesión con una cookie que el navegador no expone ni envía a otros sitios", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "Marta@Correduria.test", password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    expect(response.body).not.toContain("passwordHash");
    expect(response.body).not.toContain("scrypt");

    const session = await get("/api/auth/session", {
      cookie: `${SESSION_COOKIE}=${cookie?.value}`,
      csrf: "",
    });
    expect(session.json<{ user: User }>().user).toMatchObject({ email: tramitador.email });
  });

  it("responde igual a una contraseña mala que a un usuario que no existe", async () => {
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: tramitador.email, password: "no-es-esta" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nadie@correduria.test", password: "no-es-esta" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("bloquea tras varios intentos fallidos, aunque luego la contraseña sea buena", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: tramitador.email, password: "mala" },
      });
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: tramitador.email, password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("exige sesión para todo lo demás", async () => {
    expect((await get("/api/accounts")).statusCode).toBe(401);
    expect((await get("/api/auth/session")).statusCode).toBe(401);
    expect((await get("/api/admin/users")).statusCode).toBe(401);
  });

  it("rechaza los cambios que no traen el token de la sesión, y cierra la sesión", async () => {
    const session = await login(tramitador.email);
    const forged = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: session.cookie },
    });
    expect(forged.statusCode).toBe(403);
    expect((await get("/api/auth/session", session)).statusCode).toBe(200);

    expect((await send("POST", "/api/auth/logout", session)).statusCode).toBe(200);
    expect((await get("/api/auth/session", session)).statusCode).toBe(401);
  });
});

describe("administración", () => {
  it("solo un administrador gestiona usuarios", async () => {
    const user = await login(tramitador.email);
    expect((await get("/api/admin/users", user)).statusCode).toBe(403);

    const session = await login(admin.email);
    const payload = { email: "nueva@correduria.test", name: "Nueva", password: PASSWORD };
    const ok = await send("POST", "/api/admin/users", session, payload);
    expect(ok.statusCode).toBe(201);
    expect(ok.body).not.toContain("scrypt");

    const duplicate = await send("POST", "/api/admin/users", session, payload);
    expect(duplicate.statusCode).toBe(422);
    const weak = await send("POST", "/api/admin/users", session, {
      ...payload,
      email: "otra@correduria.test",
      password: "corta",
    });
    expect(weak.statusCode).toBe(422);
  });

  it("da de alta un buzón comprobando la conexión, sin devolver nunca la contraseña", async () => {
    const session = await login(admin.email);
    const input = accountInput(ANA);

    const bad = await send("POST", "/api/admin/accounts", session, {
      ...input,
      password: "no-es-esta",
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: "connection_auth" });

    const ok = await send("POST", "/api/admin/accounts", session, input);
    expect(ok.statusCode).toBe(201);
    expect(ok.body).not.toContain(input.password);
    expect(ok.body).not.toContain("secret");
    expect(created.map((account) => account.email)).toEqual([ANA]);

    const list = await get("/api/admin/accounts", session);
    expect(list.body).not.toContain("secret");
    expect(list.json<{ accounts: unknown[] }>().accounts).toHaveLength(1);
  });
});

describe("permisos por buzón y lectura", () => {
  let outlook: ImapFlow;
  let account: Account;

  beforeEach(async () => {
    await resetMailbox(ANA);
    outlook = await otherClient(ANA);
    account = await createTestAccount(env);
    await env.db.insert(accountAccess).values({ accountId: account.id, userId: tramitador.id });
  });
  afterEach(async () => {
    await outlook.logout().catch(() => undefined);
  });

  type Folder = { id: string; path: string; total: number; unread: number };
  type Item = { id: string; subject: string; flags: string[] };
  type Page = { items: Item[]; nextCursor: string | null };

  async function inbox(session: Login): Promise<Folder> {
    const response = await get(`/api/accounts/${account.id}/folders`, session);
    const found = response.json<{ folders: Folder[] }>().folders.find((f) => f.path === "INBOX");
    if (!found) throw new Error("No aparece la Entrada.");
    return found;
  }

  it("lista carpetas con sus contadores y pagina los correos de más reciente a más antiguo", async () => {
    for (const subject of ["Primero", "Segundo", "Tercero"]) {
      await appendMail(outlook, { subject }, "INBOX", subject === "Primero" ? ["\\Seen"] : []);
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    await syncAll(env, account);
    const session = await login(tramitador.email);

    const folder = await inbox(session);
    expect(folder).toMatchObject({ total: 3, unread: 2 });

    const first = (await get(`/api/folders/${folder.id}/messages?limit=2`, session)).json<Page>();
    expect(first.items.map((item) => item.subject)).toEqual(["Tercero", "Segundo"]);
    expect(first.nextCursor).not.toBeNull();

    const second = (
      await get(
        `/api/folders/${folder.id}/messages?limit=2&before=${encodeURIComponent(first.nextCursor!)}`,
        session,
      )
    ).json<Page>();
    expect(second.items.map((item) => item.subject)).toEqual(["Primero"]);
    expect(second.items[0]?.flags).toEqual(["\\Seen"]);
    expect(second.nextCursor).toBeNull();
  });

  it("muestra el correo con su texto, adjuntos y carpeta, y deja constancia de la lectura", async () => {
    await appendMail(outlook, {
      subject: "Parte",
      text: "Adjunto el parte.",
      attachments: [{ filename: "parte.pdf", content: Buffer.from("%PDF-1.4") }],
    });
    await syncAll(env, account);
    const session = await login(tramitador.email);
    const folder = await inbox(session);
    const { items } = (await get(`/api/folders/${folder.id}/messages`, session)).json<Page>();

    const detail = (await get(`/api/messages/${items[0]!.id}`, session)).json<{
      message: {
        bodyText: string;
        bodyPending: boolean;
        attachments: { filename: string }[];
        locations: { path: string }[];
      };
    }>().message;
    expect(detail.bodyText).toContain("Adjunto el parte.");
    expect(detail.bodyPending).toBe(false);
    expect(detail.attachments.map((file) => file.filename)).toEqual(["parte.pdf"]);
    expect(detail.locations.map((location) => location.path)).toEqual(["INBOX"]);

    const reads = await env.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "message.read"), eq(auditLog.target, items[0]!.id)));
    expect(reads.map((entry) => entry.userId)).toEqual([tramitador.id]);
  });

  it("quien no tiene concedido el buzón no ve nada, ni siquiera el administrador", async () => {
    await appendMail(outlook, { subject: "Confidencial" });
    await syncAll(env, account);
    const owner = await login(tramitador.email);
    const folder = await inbox(owner);
    const { items } = (await get(`/api/folders/${folder.id}/messages`, owner)).json<Page>();
    const messageId = items[0]!.id;

    for (const email of [ajeno.email, admin.email]) {
      const session = await login(email);
      expect((await get("/api/accounts", session)).json()).toEqual({ accounts: [] });
      for (const url of [
        `/api/accounts/${account.id}/folders`,
        `/api/folders/${folder.id}/messages`,
        `/api/messages/${messageId}`,
      ]) {
        expect((await get(url, session)).statusCode, `${email} ${url}`).toBe(404);
      }
    }
  });

  it("el administrador concede y retira el acceso", async () => {
    const adminSession = await login(admin.email);
    const other = await login(ajeno.email);
    const url = `/api/admin/accounts/${account.id}/access/${ajeno.id}`;

    expect((await send("PUT", url, adminSession)).statusCode).toBe(200);
    expect((await get(`/api/accounts/${account.id}/folders`, other)).statusCode).toBe(200);

    expect((await send("DELETE", url, adminSession)).statusCode).toBe(200);
    expect((await get(`/api/accounts/${account.id}/folders`, other)).statusCode).toBe(404);
  });

  it("un correo retirado del buzón sigue disponible en el archivo", async () => {
    const uid = await appendMail(outlook, { subject: "Vaciado", text: "Se libera espacio." });
    await syncAll(env, account);
    const session = await login(tramitador.email);
    const folder = await inbox(session);
    const { items } = (await get(`/api/folders/${folder.id}/messages`, session)).json<Page>();

    await inFolder(outlook, "INBOX", () => outlook.messageDelete(String(uid), { uid: true }));
    await syncAll(env, account, { removalGraceMs: 0 });

    expect((await inbox(session)).total).toBe(0);
    const detail = (await get(`/api/messages/${items[0]!.id}`, session)).json<{
      message: { bodyText: string; removedFromServerAt: string | null; locations: unknown[] };
    }>().message;
    expect(detail.removedFromServerAt).not.toBeNull();
    expect(detail.bodyText).toContain("Se libera espacio.");
    expect(detail.locations).toEqual([]);
  });
});
