/**
 * Datos estructurados y datos de negocio: lo que se saca de cada correo para poder
 * consultarlo después. Requiere `pnpm dev:up`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "../src/auth/sessions.ts";
import { createUser } from "../src/auth/users.ts";
import {
  accountAccess,
  events,
  messageAddresses,
  messageFacts,
  messages,
} from "../src/db/schema.ts";
import { replaceFacts } from "../src/facts/facts.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import { enrichMessage } from "../src/mail/enrich.ts";
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

let env: TestEnv;
let app: FastifyInstance;
let outlook: ImapFlow;
let account: Account;
let marta: User;
let pedro: User;
let session: Login;

type Login = { cookie: string; csrf: string };
type FactView = { id: string; kind: string; value: string; method: string; confirmed: boolean };

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

const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object, as = session) =>
  app.inject({
    method,
    url,
    headers: { cookie: as.cookie, [CSRF_HEADER]: as.csrf },
    ...(payload ? { payload } : {}),
  });

const subjects = async (query: string) =>
  (await call("GET", `/api/search?${query}`))
    .json<{ items: { subject: string }[] }>()
    .items.map((item) => item.subject)
    .sort();

const bySubject = async (subject: string) => {
  const [row] = await env.db.select().from(messages).where(eq(messages.subject, subject));
  return row!;
};

beforeAll(async () => {
  env = await openTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await resetMailbox(ANA);
  outlook = await otherClient(ANA);
  account = await createTestAccount(env);
  app = await buildApp({ db: env.db, secrets: env.secrets, rawStore: env.rawStore });
  marta = await createUser(env.db, { email: "marta@c.test", name: "Marta", password: PASSWORD });
  pedro = await createUser(env.db, { email: "pedro@c.test", name: "Pedro", password: PASSWORD });
  await env.db.insert(accountAccess).values({ userId: marta.id, accountId: account.id });
  session = await login(marta.email);

  await appendMail(outlook, {
    from: "Tramitación <tramitacion@albor.test>",
    to: ANA,
    cc: "Perito Gómez <perito@gabinete.test>",
    subject: "Documentación pendiente",
    text: "Falta el parte firmado.",
    attachments: [{ filename: "Requerimiento-88231907.pdf", content: Buffer.from("%PDF") }],
    headers: { Importance: "high" },
  });
  await appendMail(outlook, {
    from: ANA,
    to: "cliente@riocinca.test",
    subject: "Le pedimos el parte",
    text: "Necesitamos el parte amistoso.",
  });
  await appendMail(outlook, {
    from: "boletin@colegio.test",
    to: ANA,
    subject: "Novedades",
    text: "Sin relación.",
  });
  await syncAll(env, account);
});
afterEach(async () => {
  await app.close();
  await outlook.logout().catch(() => undefined);
});

describe("datos estructurados", () => {
  it("guarda participantes, sentido, prioridad y cabeceras de cada correo, y avisa al terminar", async () => {
    const received = await bySubject("Documentación pendiente");
    expect(received).toMatchObject({ direction: "in", priority: "high", autoReply: false });
    expect(received.enrichedAt).not.toBeNull();
    expect(received.headers?.importance).toEqual(["high"]);
    expect((await bySubject("Le pedimos el parte")).direction).toBe("out");

    const people = await env.db
      .select()
      .from(messageAddresses)
      .where(eq(messageAddresses.messageId, received.id));
    expect(people.map((row) => `${row.role} ${row.address} ${row.domain}`).sort()).toEqual([
      "cc perito@gabinete.test gabinete.test",
      "from tramitacion@albor.test albor.test",
      `to ${ANA} correo.test`,
    ]);

    const notices = await env.db
      .select()
      .from(events)
      .where(and(eq(events.type, "message.enriched"), eq(events.messageId, received.id)));
    expect(notices).toHaveLength(1);
  });

  it("busca por cualquier participante o dominio, por sentido y por nombre de adjunto", async () => {
    // El perito solo va en copia: antes la búsqueda no lo veía.
    expect(await subjects("q=perito")).toEqual(["Documentación pendiente"]);
    expect(await subjects("q=parte&with=gabinete.test")).toEqual(["Documentación pendiente"]);
    expect(await subjects("q=parte&with=riocinca")).toEqual(["Le pedimos el parte"]);
    expect(await subjects("q=parte&direction=out")).toEqual(["Le pedimos el parte"]);
    expect(await subjects("q=parte&direction=in")).toEqual(["Documentación pendiente"]);
    expect(await subjects("q=requerimiento")).toEqual(["Documentación pendiente"]);
    expect(await subjects("q=88231907")).toEqual(["Documentación pendiente"]);
  });

  it("se puede volver a procesar un correo desde su original sin duplicar nada", async () => {
    const message = await bySubject("Documentación pendiente");
    await env.db
      .update(messages)
      .set({ direction: null, headers: null })
      .where(eq(messages.id, message.id));
    await env.db.delete(messageAddresses).where(eq(messageAddresses.messageId, message.id));

    for (let round = 0; round < 2; round++) {
      await enrichMessage(env.db, env.rawStore, {
        messageId: message.id,
        accountId: account.id,
        accountEmail: account.email,
        rawSha256: message.rawSha256!,
      });
    }
    expect(await bySubject("Documentación pendiente")).toMatchObject({ direction: "in" });
    const people = await env.db
      .select()
      .from(messageAddresses)
      .where(eq(messageAddresses.messageId, message.id));
    expect(people).toHaveLength(3);
    const detail = await call("GET", `/api/messages/${message.id}`);
    expect(detail.json<{ message: { attachments: unknown[] } }>().message.attachments).toHaveLength(
      1,
    );
  });
});

describe("datos de negocio ligados al correo", () => {
  it("una regla o un modelo escribe datos con su origen; reprocesar los sustituye, no los acumula", async () => {
    const message = await bySubject("Documentación pendiente");
    const target = {
      accountId: account.id,
      messageId: message.id,
      extractor: "modelo-pruebas@1",
      method: "model" as const,
    };
    await replaceFacts(env.db, target, [
      {
        kind: "Siniestro",
        value: " 2026/0142 ",
        source: "body",
        evidence: "siniestro 2026/0142",
        confidence: 0.82,
      },
      {
        kind: "Ref. compañía",
        value: "88/2231907",
        source: "attachment:Requerimiento-88231907.pdf",
      },
    ]);
    await replaceFacts(env.db, target, [
      { kind: "siniestro", value: "2026/0142", confidence: 0.95 },
    ]);
    // Lo de otro extractor no se toca.
    await replaceFacts(env.db, { ...target, extractor: "regla-matriculas", method: "rule" }, [
      { kind: "matricula", value: "4471KLM", source: "subject" },
    ]);

    const rows = await env.db
      .select()
      .from(messageFacts)
      .where(eq(messageFacts.messageId, message.id));
    expect(rows.map((row) => `${row.kind}=${row.value} (${row.method})`).sort()).toEqual([
      "matricula=4471KLM (rule)",
      "siniestro=2026/0142 (model)",
    ]);
    expect(rows.find((row) => row.kind === "siniestro")?.confidence).toBeCloseTo(0.95);

    const listed = await call("GET", `/api/messages/${message.id}/facts`);
    expect(listed.json<{ facts: FactView[] }>().facts).toMatchObject([
      { kind: "matricula", value: "4471KLM", method: "rule", confirmed: false },
      { kind: "siniestro", value: "2026/0142", method: "model", confirmed: false },
    ]);
  });

  it("una persona añade y quita datos, y se encuentran todos los correos de un mismo dato", async () => {
    const first = await bySubject("Documentación pendiente");
    const second = await bySubject("Le pedimos el parte");

    const added = await call("POST", `/api/messages/${first.id}/facts`, {
      kind: "Siniestro",
      value: "2026/0142",
    });
    expect(added.json<{ fact: FactView }>().fact).toMatchObject({
      kind: "siniestro",
      method: "user",
      confirmed: true,
    });
    await call("POST", `/api/messages/${second.id}/facts`, {
      kind: "siniestro",
      value: "2026/0142",
    });
    const again = await call("POST", `/api/messages/${first.id}/facts`, {
      kind: "siniestro",
      value: "2026/0142",
    });
    expect(again.statusCode).toBe(409);

    const found = await call("GET", "/api/facts/messages?kind=Siniestro&value=2026%2F0142");
    expect(
      found
        .json<{ items: { subject: string }[] }>()
        .items.map((item) => item.subject)
        .sort(),
    ).toEqual(["Documentación pendiente", "Le pedimos el parte"]);

    const removed = await call(
      "DELETE",
      `/api/messages/${second.id}/facts/${(await call("GET", `/api/messages/${second.id}/facts`)).json<{ facts: FactView[] }>().facts[0]!.id}`,
    );
    expect(removed.statusCode).toBe(200);
    const after = await call("GET", "/api/facts/messages?kind=siniestro&value=2026%2F0142");
    expect(after.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it("respeta los permisos del buzón", async () => {
    const message = await bySubject("Documentación pendiente");
    await call("POST", `/api/messages/${message.id}/facts`, { kind: "siniestro", value: "X" });
    const stranger = await login(pedro.email);
    expect(
      (await call("GET", `/api/messages/${message.id}/facts`, undefined, stranger)).statusCode,
    ).toBe(404);
    expect(
      (await call("POST", `/api/messages/${message.id}/facts`, { kind: "a", value: "b" }, stranger))
        .statusCode,
    ).toBe(404);
    const found = await call(
      "GET",
      "/api/facts/messages?kind=siniestro&value=X",
      undefined,
      stranger,
    );
    expect(found.json<{ items: unknown[] }>().items).toEqual([]);
  });
});
