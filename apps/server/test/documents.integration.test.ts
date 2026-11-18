/**
 * Capa de texto: cuerpo limpio de cada correo y texto de sus adjuntos, accesible para la
 * búsqueda y para quien arme el contexto de un expediente. Requiere `pnpm dev:up`.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "../src/auth/sessions.ts";
import { createUser } from "../src/auth/users.ts";
import { accountAccess, documentPages, documentTexts, events, messages } from "../src/db/schema.ts";
import { ExtractionWorker } from "../src/documents/worker.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import { demoPlugin } from "../src/plugins/demo/index.ts";
import { PluginHost } from "../src/plugins/host.ts";
import { makeDocx, makePdf } from "./documents.ts";
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
let worker: ExtractionWorker;
let outlook: ImapFlow;
let account: Account;
let marta: User;
let session: { cookie: string; csrf: string };

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
    ...(payload ? { payload } : {}),
  });

const bySubject = async (subject: string) => {
  const [row] = await env.db.select().from(messages).where(eq(messages.subject, subject));
  return row!;
};

/** Sincroniza y lee el texto de los adjuntos, como hace el servidor en marcha. */
async function settle(): Promise<void> {
  await syncAll(env, account);
  while ((await worker.drain()) > 0);
}

const poliza = makePdf([
  "Condiciones particulares de la poliza 88/2231907",
  "",
  "Franquicia de trescientos euros en lunas y retrovisores",
]);

beforeAll(async () => {
  env = await openTestEnv();
  worker = new ExtractionWorker(env.db, env.rawStore);
  await new PluginHost(env.db, [demoPlugin]).setup();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await env.db.delete(documentTexts);
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
  await env.db.insert(accountAccess).values({ userId: marta.id, accountId: account.id });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: marta.email, password: PASSWORD },
  });
  session = {
    cookie: `${SESSION_COOKIE}=${login.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`,
    csrf: login.json<{ csrfToken: string }>().csrfToken,
  };
});
afterEach(async () => {
  await app.close();
  await outlook.logout().catch(() => undefined);
});

describe("texto limpio y accesible", () => {
  it("guarda de cada correo lo que aporta de nuevo, y conserva el texto completo", async () => {
    await appendMail(outlook, {
      subject: "RE: Parte de daños",
      text: "Recibido, mañana os mando el parte firmado.\n\n> Necesitamos el parte amistoso y la póliza.",
      html: `<div>Recibido, mañana os mando el parte firmado.</div>
        <div class="gmail_quote"><div class="gmail_attr">El lun, 16 nov 2026, Marta escribió:</div>
        <blockquote>Necesitamos el parte amistoso y la póliza.</blockquote></div>`,
    });
    await settle();
    const message = await bySubject("RE: Parte de daños");
    expect(message.bodyClean).toBe("Recibido, mañana os mando el parte firmado.");
    expect(message.bodyText).toContain("Necesitamos el parte amistoso");
  });

  it("lee el texto de los adjuntos por páginas y lo encuentra la búsqueda, con su página", async () => {
    await appendMail(outlook, {
      subject: "Documentación de la póliza",
      text: "Va la documentación.",
      attachments: [
        { filename: "Poliza.pdf", content: poliza, contentType: "application/pdf" },
        { filename: "Informe.docx", content: makeDocx(["Informe pericial del gabinete Ebro"]) },
        { filename: "golpe.jpg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) },
      ],
    });
    await appendMail(outlook, { subject: "Otro correo", text: "Nada que ver." });
    await settle();

    const documents = await env.db.select().from(documentTexts);
    expect(
      documents.map((doc) => `${doc.filename}: ${doc.status} (${doc.pages} pág.)`).sort(),
    ).toEqual([
      "Informe.docx: ok (1 pág.)",
      "Poliza.pdf: ok (3 pág.)",
      "golpe.jpg: needs_ocr (0 pág.)",
    ]);
    expect(documents.find((doc) => doc.filename === "Poliza.pdf")?.pagesNeedingOcr).toBe(1);

    // «franquicia» solo aparece en la página 3 del PDF.
    type Hit = {
      subject: string;
      attachmentHit: { filename: string; page: number; pages: number; headline: string } | null;
    };
    const search = await call("GET", "/api/search?q=franquicia");
    const hits = search.json<{ items: Hit[]; marks: { start: string; end: string } }>();
    expect(hits.items.map((hit) => hit.subject)).toEqual(["Documentación de la póliza"]);
    expect(hits.items[0]?.attachmentHit).toMatchObject({
      filename: "Poliza.pdf",
      page: 3,
      pages: 3,
    });
    expect(hits.items[0]?.attachmentHit?.headline).toContain(
      `${hits.marks.start}Franquicia${hits.marks.end}`,
    );
    expect(
      (await call("GET", "/api/search?q=pericial")).json<{ items: Hit[] }>().items,
    ).toHaveLength(1);

    // El detalle del correo dice de qué adjuntos hay texto, y se puede pedir página a página.
    const message = await bySubject("Documentación de la póliza");
    const detail = await call("GET", `/api/messages/${message.id}`);
    const files = detail.json<{
      message: { attachments: { id: string; filename: string; textStatus: string }[] };
    }>().message.attachments;
    expect(Object.fromEntries(files.map((file) => [file.filename, file.textStatus]))).toEqual({
      "Poliza.pdf": "ok",
      "Informe.docx": "ok",
      "golpe.jpg": "needs_ocr",
    });
    const text = await call(
      "GET",
      `/api/attachments/${files.find((file) => file.filename === "Poliza.pdf")!.id}/text`,
    );
    const body = text.json<{
      status: string;
      pagesNeedingOcr: number;
      pages: { page: number; method: string }[];
    }>();
    expect(body).toMatchObject({ status: "ok", pagesNeedingOcr: 1 });
    expect(body.pages.map((page) => [page.page, page.method])).toEqual([
      [1, "capa_texto"],
      [2, "sin_texto"],
      [3, "capa_texto"],
    ]);

    const notices = await env.db
      .select()
      .from(events)
      .where(and(eq(events.type, "document.extracted"), eq(events.messageId, message.id)));
    expect(notices).toHaveLength(3);
  });

  it("un adjunto sin procesar se puede ver y anotar, y lo anotado se busca", async () => {
    const foto = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
    await appendMail(outlook, {
      subject: "Fotos del golpe",
      text: "Van las fotos.",
      attachments: [{ filename: "lateral.jpg", content: foto, contentType: "image/jpeg" }],
    });
    await appendMail(outlook, {
      subject: "Las mismas fotos, reenviadas",
      text: "Te las paso.",
      attachments: [{ filename: "IMG_0042.jpg", content: foto, contentType: "image/jpeg" }],
    });
    await settle();

    type Detail = {
      message: { attachments: Attachments };
    };
    type Attachments = {
      attachments: {
        id: string;
        textStatus: string;
        note: { text: string; author: string } | null;
        autoNote: unknown;
      }[];
    }["attachments"];
    const first = await bySubject("Fotos del golpe");
    const before = (await call("GET", `/api/messages/${first.id}`)).json<Detail>();
    const file = before.message.attachments[0]!;
    expect(file).toMatchObject({ textStatus: "needs_ocr", note: null, autoNote: null });

    // Como foto se enseña tal cual; como descarga, siempre es un fichero opaco.
    const shown = await call("GET", `/api/attachments/${file.id}?inline=1`);
    expect(shown.headers["content-type"]).toBe("image/jpeg");
    expect(shown.headers["content-disposition"]).toBe("inline");
    const download = await call("GET", `/api/attachments/${file.id}`);
    expect(download.headers["content-type"]).toBe("application/octet-stream");

    const saved = await call("PUT", `/api/attachments/${file.id}/note`, {
      text: "Lateral derecho del camión, abolladura en la puerta trasera.",
    });
    expect(saved.statusCode).toBe(200);

    // La nota va con el fichero: aparece también en el otro correo que lo lleva.
    const second = await bySubject("Las mismas fotos, reenviadas");
    const other = (await call("GET", `/api/messages/${second.id}`)).json<Detail>();
    expect(other.message.attachments[0]?.note).toMatchObject({
      text: "Lateral derecho del camión, abolladura en la puerta trasera.",
      author: marta.name,
    });

    type Hit = { subject: string; attachmentHit: { page: number; headline: string } | null };
    const search = await call("GET", "/api/search?q=abolladura");
    const hits = search.json<{ items: Hit[] }>().items;
    expect(hits.map((hit) => hit.subject).sort()).toEqual([
      "Fotos del golpe",
      "Las mismas fotos, reenviadas",
    ]);
    expect(hits[0]?.attachmentHit?.page).toBe(0);

    // Vacía, la nota se borra.
    await call("PUT", `/api/attachments/${file.id}/note`, { text: "" });
    const after = (await call("GET", `/api/messages/${first.id}`)).json<Detail>();
    expect(after.message.attachments[0]?.note).toBeNull();
  });

  it("el mismo adjunto en dos correos se lee y se guarda una sola vez", async () => {
    await appendMail(outlook, {
      subject: "Primera vez",
      attachments: [{ filename: "Poliza.pdf", content: poliza, contentType: "application/pdf" }],
    });
    await appendMail(outlook, {
      subject: "Reenviada con otro nombre",
      attachments: [{ filename: "copia.pdf", content: poliza, contentType: "application/pdf" }],
    });
    await settle();
    expect(await env.db.select().from(documentTexts)).toHaveLength(1);
    expect(await env.db.select().from(documentPages)).toHaveLength(3);
    const search = await call("GET", "/api/search?q=franquicia");
    expect(search.json<{ items: unknown[] }>().items).toHaveLength(2);
  });

  it("mide cuánto ocupa el contexto de un expediente, sin los correos excluidos", async () => {
    await appendMail(outlook, {
      subject: "Siniestro del camión",
      messageId: "<camion@doc.test>",
      text: "Adjunto la póliza del camión.",
      attachments: [
        { filename: "Poliza.pdf", content: poliza, contentType: "application/pdf" },
        { filename: "golpe.jpg", content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]) },
      ],
    });
    await appendMail(outlook, {
      subject: "RE: Siniestro del camión",
      inReplyTo: "<camion@doc.test>",
      references: ["<camion@doc.test>"],
      text: "Por cierto, ¿tenéis oferta para la flota nueva? Son doce furgonetas.",
    });
    await settle();
    const first = await bySubject("Siniestro del camión");
    const reply = await bySubject("RE: Siniestro del camión");
    const opened = (await call("POST", "/api/plugins/demo/cases", { messageId: first.id })).json<{
      case: { id: string };
    }>().case;

    type Context = {
      messages: number;
      excluded: number;
      messageChars: number;
      documents: number;
      documentChars: number;
      withoutText: { needsOcr: number };
      approxTokens: number;
    };
    const url = `/api/plugins/demo/cases/${opened.id}`;
    const before = (await call("GET", `${url}/context`)).json<Context>();
    expect(before).toMatchObject({
      messages: 2,
      excluded: 0,
      documents: 2,
      withoutText: { needsOcr: 1 },
    });
    expect(before.messageChars).toBe(first.bodyClean!.length + reply.bodyClean!.length);
    expect(before.documentChars).toBeGreaterThan(80);
    expect(before.approxTokens).toBeGreaterThan(0);

    await call("PUT", `${url}/messages/${reply.id}`, { excluded: true });
    const after = (await call("GET", `${url}/context`)).json<Context>();
    expect(after).toMatchObject({ messages: 1, excluded: 1, documents: 2 });
    expect(after.messageChars).toBe(first.bodyClean!.length);
    expect(after.approxTokens).toBeLessThan(before.approxTokens);
  });
});
