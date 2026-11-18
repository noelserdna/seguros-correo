/**
 * Conexión de buzones con Google y Microsoft 365, contra un proveedor simulado.
 * Lo que no cubre: la entrada real por IMAP con el permiso (XOAUTH2), que solo se
 * puede comprobar contra los proveedores de verdad.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAuth } from "../src/accounts/auth.ts";
import type { User } from "../src/auth/sessions.ts";
import { createUser } from "../src/auth/users.ts";
import { accountAccess, accounts } from "../src/db/schema.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import { OAuthError, type OAuthSettings, type TokenSet } from "../src/oauth/providers.ts";
import { openTestEnv, resetDb, type TestEnv } from "./helpers.ts";

const PASSWORD = "contraseña-de-prueba";

let env: TestEnv;
let app: FastifyInstance;
let provider: Server;
let oauth: OAuthSettings;
let admin: User;
let started: Account[];
/** Lo que el proveedor simulado ha recibido y lo que debe contestar. */
let requests: URLSearchParams[];
let answer: { status: number; body: Record<string, unknown> };

const idToken = (email: string) =>
  `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.x`;

async function login(email: string) {
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
type Login = Awaited<ReturnType<typeof login>>;

const start = (session: Login, id = "google") =>
  app.inject({
    method: "POST",
    url: `/api/admin/oauth/${id}/start`,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
  });

const callback = (session: Login, query: Record<string, string>) =>
  app.inject({
    method: "GET",
    url: `/api/oauth/callback?${new URLSearchParams(query).toString()}`,
    headers: { cookie: session.cookie },
  });

const landing = (location: unknown) => new URL(String(location), "http://x").searchParams;

beforeAll(async () => {
  env = await openTestEnv();
  provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      requests.push(new URLSearchParams(body));
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const tokenUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/token`;
  oauth = {
    redirectUri: "http://127.0.0.1:3000/api/oauth/callback",
    clients: { google: { clientId: "cliente-de-prueba", clientSecret: "secreto-de-prueba" } },
    overrides: { google: { tokenUrl } },
  };
});
afterAll(async () => {
  await new Promise((resolve) => provider.close(resolve));
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  requests = [];
  started = [];
  answer = {
    status: 200,
    body: {
      access_token: "acceso-1",
      refresh_token: "duradero-1",
      expires_in: 3600,
      id_token: idToken("siniestros@correduria.test"),
    },
  };
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    rawStore: env.rawStore,
    oauth,
    verifyOAuthConnection: async () => ["IDLE", "MOVE"],
    onAccountCreated: (account) => started.push(account),
  });
  admin = await createUser(env.db, {
    email: "admin@c.test",
    name: "Admin",
    password: PASSWORD,
    role: "admin",
  });
  await createUser(env.db, { email: "marta@c.test", name: "Marta", password: PASSWORD });
});
afterEach(async () => {
  await app.close();
});

describe("conectar un buzón", () => {
  it("solo ofrece los proveedores configurados, y solo al administrador", async () => {
    const session = await login(admin.email);
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/oauth/providers",
      headers: { cookie: session.cookie },
    });
    expect(list.json()).toEqual({ providers: [{ id: "google", label: "Google" }] });
    expect((await start(session, "microsoft")).statusCode).toBe(409);
    expect((await start(await login("marta@c.test"))).statusCode).toBe(403);
  });

  it("pide el permiso justo, canjea el código y deja el buzón dado de alta con los permisos cifrados", async () => {
    const session = await login(admin.email);
    const url = new URL((await start(session)).json<{ url: string }>().url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://mail.google.com/ openid email");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(oauth.redirectUri);
    const state = url.searchParams.get("state")!;

    const done = await callback(session, { state, code: "codigo-de-un-uso" });
    expect(done.statusCode).toBe(302);
    expect(landing(done.headers.location).get("buzon_conectado")).toBe(
      "siniestros@correduria.test",
    );

    // Al proveedor le llegó el código con la prueba de que quien canjea es quien pidió.
    expect(requests[0]?.get("code")).toBe("codigo-de-un-uso");
    expect(requests[0]?.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(requests[0]?.get("client_secret")).toBe("secreto-de-prueba");

    const [account] = await env.db.select().from(accounts);
    expect(account).toMatchObject({
      email: "siniestros@correduria.test",
      authType: "oauth_google",
      imapHost: "imap.gmail.com",
      smtpHost: "smtp.gmail.com",
      serverSavesSent: true,
    });
    expect(account!.secretEncrypted).not.toContain("duradero-1");
    expect(JSON.parse(env.secrets.decrypt(account!.secretEncrypted))).toMatchObject({
      accessToken: "acceso-1",
      refreshToken: "duradero-1",
    });
    expect(started.map((entry) => entry.id)).toEqual([account!.id]);
    const access = await env.db.select().from(accountAccess);
    expect(access).toMatchObject([{ userId: admin.id, accountId: account!.id }]);

    // El código de vuelta no vale dos veces.
    const again = await callback(session, { state, code: "codigo-de-un-uso" });
    expect(landing(again.headers.location).get("buzon_error")).toContain("caducado");
    expect(await env.db.select().from(accounts)).toHaveLength(1);
  });

  it("rechaza una vuelta que no empezó este usuario o que el proveedor ha denegado", async () => {
    const session = await login(admin.email);
    const state = new URL((await start(session)).json<{ url: string }>().url).searchParams.get(
      "state",
    )!;

    const other = await callback(await login("marta@c.test"), { state, code: "x" });
    expect(landing(other.headers.location).get("buzon_error")).toContain("caducado");

    const second = new URL((await start(session)).json<{ url: string }>().url).searchParams.get(
      "state",
    )!;
    const denied = await callback(session, { state: second, error: "access_denied" });
    expect(landing(denied.headers.location).get("buzon_error")).toContain(
      "No se ha dado el permiso",
    );
    expect(await env.db.select().from(accounts)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("volver a conectar el mismo buzón renueva sus permisos sin duplicarlo", async () => {
    const session = await login(admin.email);
    const connect = async () => {
      const url = new URL((await start(session)).json<{ url: string }>().url);
      return callback(session, { state: url.searchParams.get("state")!, code: "c" });
    };
    await connect();
    await env.db.update(accounts).set({ state: "auth_error", lastError: "caducado" });
    answer.body = { ...answer.body, access_token: "acceso-2", refresh_token: "duradero-2" };
    await connect();

    const rows = await env.db.select().from(accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "new", lastError: null });
    expect(JSON.parse(env.secrets.decrypt(rows[0]!.secretEncrypted))).toMatchObject({
      refreshToken: "duradero-2",
    });
    expect(started).toHaveLength(2);
  });
});

describe("permisos del buzón", () => {
  async function connected(tokens: TokenSet): Promise<Account> {
    const [account] = await env.db
      .insert(accounts)
      .values({
        name: "g",
        email: "g@correduria.test",
        imapHost: "imap.gmail.com",
        imapPort: 993,
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        authType: "oauth_google",
        username: "g@correduria.test",
        secretEncrypted: env.secrets.encrypt(JSON.stringify(tokens)),
      })
      .returning();
    return account!;
  }
  const deps = () => ({ db: env.db, secrets: env.secrets, oauth });

  it("usa el permiso vigente sin molestar al proveedor", async () => {
    const account = await connected({
      accessToken: "vigente",
      refreshToken: "duradero",
      expiresAt: Date.now() + 30 * 60_000,
    });
    expect(await resolveAuth(deps(), account)).toEqual({
      user: "g@correduria.test",
      accessToken: "vigente",
    });
    expect(requests).toEqual([]);
  });

  it("lo renueva cuando está a punto de caducar y guarda el nuevo", async () => {
    const account = await connected({
      accessToken: "viejo",
      refreshToken: "duradero",
      expiresAt: Date.now() + 60_000,
    });
    answer.body = { access_token: "nuevo", expires_in: 3600 };
    expect(await resolveAuth(deps(), account)).toMatchObject({ accessToken: "nuevo" });
    expect(requests[0]?.get("grant_type")).toBe("refresh_token");
    expect(requests[0]?.get("refresh_token")).toBe("duradero");

    // La copia en memoria del buzón sigue siendo la antigua: manda lo guardado.
    expect(await resolveAuth(deps(), account)).toMatchObject({ accessToken: "nuevo" });
    expect(requests).toHaveLength(1);
    const [row] = await env.db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(JSON.parse(env.secrets.decrypt(row!.secretEncrypted))).toMatchObject({
      accessToken: "nuevo",
      refreshToken: "duradero",
    });
  });

  it("si el permiso se ha retirado, lo trata como credenciales caducadas", async () => {
    const account = await connected({
      accessToken: "viejo",
      refreshToken: "retirado",
      expiresAt: 0,
    });
    answer = { status: 400, body: { error: "invalid_grant", error_description: "Token revoked" } };
    const error = await resolveAuth(deps(), account).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).authenticationFailed).toBe(true);
    expect((error as OAuthError).message).toContain("Token revoked");
  });

  it("los buzones con contraseña siguen igual", async () => {
    const [account] = await env.db
      .insert(accounts)
      .values({
        name: "p",
        email: "p@correduria.test",
        imapHost: "imap.x.test",
        imapPort: 993,
        smtpHost: "smtp.x.test",
        smtpPort: 465,
        username: "p@correduria.test",
        secretEncrypted: env.secrets.encrypt("clave-del-buzón"),
      })
      .returning();
    expect(await resolveAuth(deps(), account!)).toEqual({
      user: "p@correduria.test",
      pass: "clave-del-buzón",
    });
  });
});
