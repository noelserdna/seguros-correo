/**
 * Redactar y enviar: borradores que no se duplican en el servidor, margen para deshacer,
 * una sola entrega y una sola copia en Enviados aunque el proceso se corte.
 * Requiere `pnpm dev:up`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "../src/auth/sessions.ts";
import { createUser } from "../src/auth/users.ts";
import { accountAccess, events, outboundMessages } from "../src/db/schema.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import {
  ANA,
  LUIS,
  appendMail,
  createTestAccount,
  inFolder,
  openTestEnv,
  otherClient,
  resetDb,
  resetMailbox,
  syncAll,
  waitFor,
  type TestEnv,
} from "./helpers.ts";

const PASSWORD = "contraseña-de-prueba";

let env: TestEnv;
let app: FastifyInstance;
let outlook: ImapFlow;
let luis: ImapFlow;
let account: Account;
let marta: User;
let pedro: User;
let session: Login;
let nudges: number[];

type Login = { cookie: string; csrf: string };
type Draft = {
  id: string;
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  subject: string;
  bodyHtml: string;
  state: string;
  error: string | null;
  attachments: { id: string; filename: string; size: number }[];
};
type Reply = { outbound: Draft; error?: string; message?: string };

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

/** Correos de una carpeta, ya analizados, vistos desde otro cliente. */
async function onServer(client: ImapFlow, path: string) {
  return inFolder(client, path, async () => {
    await client.noop();
    if (!client.mailbox || client.mailbox.exists === 0) return [];
    const found = await client.fetchAll("1:*", { uid: true, flags: true, source: true });
    return Promise.all(
      found.map(async (message) => ({
        uid: message.uid,
        flags: [...(message.flags ?? [])].filter((flag) => flag !== "\\Recent").sort(),
        mail: await simpleParser(message.source!),
      })),
    );
  });
}

const newDraft = async (body: object = {}) =>
  (await call("POST", "/api/outbound", { accountId: account.id, ...body })).json<Reply>().outbound;

const save = (id: string, fields: Partial<Draft> & { bcc?: Draft["to"] }) =>
  call("PUT", `/api/outbound/${id}`, {
    to: [{ name: "Luis", address: LUIS }],
    cc: [],
    bcc: [],
    subject: "Documentación del siniestro",
    bodyHtml: "<p>Adjunto la <b>póliza</b>.</p>",
    ...fields,
  });

/** Deja pasar el margen para deshacer: el envío queda listo para salir ya. */
const skipUndoWindow = (id: string) =>
  env.db
    .update(outboundMessages)
    .set({ sendAfter: new Date(Date.now() - 1000) })
    .where(eq(outboundMessages.id, id));

beforeAll(async () => {
  env = await openTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await resetMailbox(ANA);
  await resetMailbox(LUIS);
  outlook = await otherClient(ANA);
  luis = await otherClient(LUIS);
  account = await createTestAccount(env);
  await syncAll(env, account);
  nudges = [];
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    rawStore: env.rawStore,
    onOutboundChanged: (_accountId, delayMs) => nudges.push(delayMs),
  });
  marta = await createUser(env.db, { email: "marta@c.test", name: "Marta", password: PASSWORD });
  pedro = await createUser(env.db, { email: "pedro@c.test", name: "Pedro", password: PASSWORD });
  await env.db.insert(accountAccess).values([
    { userId: marta.id, accountId: account.id },
    { userId: pedro.id, accountId: account.id },
  ]);
  session = await login(marta.email);
});
afterEach(async () => {
  await app.close();
  await outlook.logout().catch(() => undefined);
  await luis.logout().catch(() => undefined);
});

describe("borradores", () => {
  it("un borrador guardado varias veces es uno solo en el servidor, con la última versión", async () => {
    const draft = await newDraft();
    await save(draft.id, { subject: "Primera versión" });
    await syncAll(env, account);
    await save(draft.id, { subject: "Segunda versión" });
    await syncAll(env, account);
    await save(draft.id, { subject: "Versión final" });
    await syncAll(env, account);

    const drafts = await onServer(outlook, "Drafts");
    expect(drafts.map((entry) => entry.mail.subject)).toEqual(["Versión final"]);
    expect(drafts[0]?.flags).toContain("\\Draft");
    expect(drafts[0]?.mail.to).toMatchObject({ value: [{ address: LUIS }] });

    // En la interfaz se reconoce como borrador propio; las versiones viejas no van al archivo.
    await syncAll(env, account, { removalGraceMs: 0 });
    const archive = await call("GET", `/api/accounts/${account.id}/archive`);
    expect(archive.json<{ items: unknown[] }>().items).toEqual([]);
    const search = await call("GET", "/api/search?q=version");
    expect(
      search.json<{ items: { subject: string }[] }>().items.map((item) => item.subject),
    ).toEqual(["Versión final"]);
  });

  it("descartar lo quita también del servidor, y nadie más puede verlo ni tocarlo", async () => {
    const draft = await newDraft();
    await save(draft.id, {});
    await syncAll(env, account);
    expect(await onServer(outlook, "Drafts")).toHaveLength(1);

    const other = await login(pedro.email);
    expect((await call("GET", `/api/outbound/${draft.id}`, undefined, other)).statusCode).toBe(404);
    expect((await call("DELETE", `/api/outbound/${draft.id}`, undefined, other)).statusCode).toBe(
      404,
    );

    expect((await call("DELETE", `/api/outbound/${draft.id}`)).statusCode).toBe(200);
    await syncAll(env, account);
    expect(await onServer(outlook, "Drafts")).toEqual([]);
    expect(await env.db.select().from(outboundMessages)).toEqual([]);
  });

  it("limpia lo que manda el editor y rechaza direcciones mal escritas", async () => {
    const draft = await newDraft();
    const saved = await save(draft.id, {
      bodyHtml: `<p onclick="x()">Hola</p><script>robar()</script>`,
    });
    expect(saved.json<Reply>().outbound.bodyHtml).toBe("<p>Hola</p>");

    const bad = await save(draft.id, { to: [{ name: "", address: "no-es-un-correo" }] });
    expect(bad.statusCode).toBe(400);
  });
});

describe("enviar", () => {
  it("entrega el correo con su adjunto, deja una copia en Enviados y quita el borrador", async () => {
    const draft = await newDraft();
    await save(draft.id, { bcc: [{ name: "", address: ANA }] });
    const upload = await app.inject({
      method: "POST",
      url: `/api/outbound/${draft.id}/attachments?filename=${encodeURIComponent("Póliza.pdf")}`,
      headers: {
        cookie: session.cookie,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/octet-stream",
        "x-file-type": "application/pdf",
      },
      payload: Buffer.from("%PDF-1.4 póliza"),
    });
    expect(upload.statusCode).toBe(200);
    await syncAll(env, account);
    expect(await onServer(outlook, "Drafts")).toHaveLength(1);

    const sent = await call("POST", `/api/outbound/${draft.id}/send`);
    expect(sent.json<Reply & { undoMs: number }>()).toMatchObject({
      outbound: { state: "queued" },
      undoMs: 10_000,
    });
    expect(nudges.at(-1)).toBeGreaterThan(10_000);

    // Dentro del margen para deshacer no sale nada.
    const [early] = await syncAll(env, account);
    expect(early?.sent).toBe(0);
    expect(await onServer(luis, "INBOX")).toEqual([]);

    await skipUndoWindow(draft.id);
    const [cycle] = await syncAll(env, account);
    expect(cycle?.sent).toBe(1);

    const [received] = await waitFor(async () => {
      const inbox = await onServer(luis, "INBOX");
      return inbox.length > 0 && inbox;
    });
    expect(received?.mail.subject).toBe("Documentación del siniestro");
    expect(received?.mail.html).toContain("<b>póliza</b>");
    expect(received?.mail.text).toContain("Adjunto la póliza.");
    expect(
      received?.mail.attachments.map((file) => [file.filename, file.content.toString()]),
    ).toEqual([["Póliza.pdf", "%PDF-1.4 póliza"]]);
    expect(received?.mail.headers.has("bcc")).toBe(false);

    const copies = await onServer(outlook, "Sent");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.flags).toContain("\\Seen");
    expect(copies[0]?.mail.messageId).toBe(received?.mail.messageId);
    expect(copies[0]?.mail.bcc).toMatchObject({ value: [{ address: ANA }] });
    expect(await onServer(outlook, "Drafts")).toEqual([]);

    // Ya enviado, no se puede cambiar ni volver a enviar.
    expect((await save(draft.id, {})).statusCode).toBe(409);
    expect((await call("POST", `/api/outbound/${draft.id}/send`)).statusCode).toBe(409);
    await syncAll(env, account);
    expect(await onServer(outlook, "Sent")).toHaveLength(1);
  });

  it("deshacer dentro del margen lo devuelve a borrador y no sale nada", async () => {
    const draft = await newDraft();
    await save(draft.id, {});
    await call("POST", `/api/outbound/${draft.id}/send`);
    const cancelled = await call("POST", `/api/outbound/${draft.id}/cancel`);
    expect(cancelled.json<Reply>().outbound.state).toBe("draft");

    await skipUndoWindow(draft.id);
    const [cycle] = await syncAll(env, account);
    expect(cycle?.sent).toBe(0);
    expect(await onServer(outlook, "Sent")).toEqual([]);
    expect((await call("POST", `/api/outbound/${draft.id}/cancel`)).statusCode).toBe(409);
  });

  it("no envía sin destinatarios", async () => {
    const draft = await newDraft();
    await save(draft.id, { to: [] });
    const reply = await call("POST", `/api/outbound/${draft.id}/send`);
    expect(reply.statusCode).toBe(409);
    expect(reply.json<Reply>().error).toBe("no_recipients");
  });

  it("si el proceso se corta tras la entrega, al volver solo deja la copia: un correo y una copia", async () => {
    const draft = await newDraft();
    await save(draft.id, {});
    await call("POST", `/api/outbound/${draft.id}/send`);
    // Simula el corte: el servidor de salida ya lo aceptó, pero no dio tiempo a más.
    await env.db
      .update(outboundMessages)
      .set({ state: "sending", sendAfter: new Date(), smtpAcceptedAt: new Date() })
      .where(eq(outboundMessages.id, draft.id));

    await syncAll(env, account);
    await syncAll(env, account);
    expect(await onServer(outlook, "Sent")).toHaveLength(1);
    // No se ha vuelto a entregar: al destinatario no le llega nada desde aquí.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await onServer(luis, "INBOX")).toEqual([]);
    const [row] = await env.db.select().from(outboundMessages);
    expect(row?.state).toBe("sent");
  });

  it("si la copia ya estaba en Enviados (corte tras guardarla), no la duplica", async () => {
    const draft = await newDraft();
    await save(draft.id, {});
    await call("POST", `/api/outbound/${draft.id}/send`);
    await skipUndoWindow(draft.id);
    await syncAll(env, account);
    expect(await onServer(outlook, "Sent")).toHaveLength(1);

    // Como si el corte hubiera llegado justo después de guardar la copia.
    await env.db
      .update(outboundMessages)
      .set({ state: "sending" })
      .where(eq(outboundMessages.id, draft.id));
    await syncAll(env, account);
    expect(await onServer(outlook, "Sent")).toHaveLength(1);
  });

  it("si se corta sin saber si salió, no reenvía a ciegas: lo deja como fallido y avisa", async () => {
    const draft = await newDraft();
    await save(draft.id, {});
    await call("POST", `/api/outbound/${draft.id}/send`);
    await env.db
      .update(outboundMessages)
      .set({ state: "sending", sendAfter: new Date() })
      .where(eq(outboundMessages.id, draft.id));

    const [cycle] = await syncAll(env, account);
    expect(cycle?.sendFailed).toBe(1);
    const outbox = await call("GET", `/api/accounts/${account.id}/outbox`);
    const [item] = outbox.json<{ items: { state: string; error: string }[] }>().items;
    expect(item).toMatchObject({ state: "failed" });
    expect(item?.error).toContain("no sabemos si llegó a salir");
    const failures = await env.db
      .select()
      .from(events)
      .where(and(eq(events.type, "outbound.failed"), eq(events.accountId, account.id)));
    expect(failures[0]?.payload).toMatchObject({ userId: marta.id });
    expect(await onServer(outlook, "Sent")).toEqual([]);
  });
});

describe("responder y reenviar", () => {
  async function received(options: Parameters<typeof appendMail>[1]) {
    await appendMail(outlook, options);
    await syncAll(env, account);
    const folders = await call("GET", `/api/accounts/${account.id}/folders`);
    const inbox = folders
      .json<{ folders: { id: string; path: string }[] }>()
      .folders.find((folder) => folder.path === "INBOX")!;
    const list = await call("GET", `/api/folders/${inbox.id}/messages`);
    return list.json<{ items: { id: string }[] }>().items[0]!.id;
  }

  it("responder cita el original, hila la conversación y lo marca como respondido", async () => {
    await call("PUT", `/api/accounts/${account.id}/identity`, {
      signature: "Marta Ruiz\nSiniestros",
    });
    const sourceId = await received({
      from: `Luis Gil <${LUIS}>`,
      to: [ANA, "otra@correo.test"],
      cc: "copia@correo.test",
      subject: "Parte de daños",
      messageId: "<original@correo.test>",
      html: `<p>Necesitamos el <i>parte</i>.</p><script>robar()</script>`,
    });

    const reply = await newDraft({ kind: "reply", sourceMessageId: sourceId });
    expect(reply.subject).toBe("RE: Parte de daños");
    expect(reply.to).toEqual([{ name: "Luis Gil", address: LUIS }]);
    expect(reply.cc).toEqual([]);
    expect(reply.bodyHtml).toContain("Marta Ruiz<br>Siniestros");
    expect(reply.bodyHtml).toContain("Luis Gil escribió:");
    expect(reply.bodyHtml).toContain("<blockquote");
    expect(reply.bodyHtml).toContain("<i>parte</i>");
    expect(reply.bodyHtml).not.toContain("robar");

    const all = await newDraft({ kind: "replyAll", sourceMessageId: sourceId });
    expect(all.to.map((entry) => entry.address)).toEqual([LUIS]);
    expect(all.cc.map((entry) => entry.address)).toEqual(["otra@correo.test", "copia@correo.test"]);

    await save(reply.id, {
      subject: reply.subject,
      bodyHtml: `<p>Va adjunto.</p>${reply.bodyHtml}`,
    });
    await call("POST", `/api/outbound/${reply.id}/send`);
    await skipUndoWindow(reply.id);
    await syncAll(env, account);
    await syncAll(env, account);

    const [copy] = await onServer(outlook, "Sent");
    expect(copy?.mail.inReplyTo).toBe("<original@correo.test>");
    expect(copy?.mail.references).toBe("<original@correo.test>");
    const [original] = await onServer(outlook, "INBOX");
    expect(original?.flags).toContain("\\Answered");

    // Original y respuesta quedan en la misma conversación.
    const detail = await call("GET", `/api/messages/${sourceId}`);
    const thread = await call(
      "GET",
      `/api/threads/${detail.json<{ message: { threadId: string } }>().message.threadId}`,
    );
    expect(
      thread.json<{ messages: { subject: string }[] }>().messages.map((entry) => entry.subject),
    ).toEqual(["Parte de daños", "RE: Parte de daños"]);
  });

  it("reenviar lleva la cabecera del original y sus adjuntos, sin destinatarios puestos", async () => {
    const sourceId = await received({
      from: `Luis Gil <${LUIS}>`,
      subject: "RE: Fotos del golpe",
      text: "Van las fotos.",
      attachments: [{ filename: "foto.jpg", content: Buffer.from("jpg-falso") }],
    });
    const forward = await newDraft({ kind: "forward", sourceMessageId: sourceId });
    expect(forward.subject).toBe("RV: RE: Fotos del golpe");
    expect(forward.to).toEqual([]);
    expect(forward.bodyHtml).toContain("Mensaje reenviado");
    expect(forward.bodyHtml).toContain("Van las fotos.");
    expect(forward.attachments.map((file) => file.filename)).toEqual(["foto.jpg"]);

    const removed = await call(
      "DELETE",
      `/api/outbound/${forward.id}/attachments/${forward.attachments[0]!.id}`,
    );
    expect(removed.statusCode).toBe(200);
    const again = await call("GET", `/api/outbound/${forward.id}`);
    expect(again.json<Reply>().outbound.attachments).toEqual([]);
  });
});
