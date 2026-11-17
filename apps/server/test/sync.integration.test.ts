/**
 * Sincronización de solo lectura contra un servidor IMAP real (Dovecot en Docker).
 * Un segundo cliente hace el papel de Outlook. Requiere `pnpm dev:up`.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountConnectionError, createAccount } from "../src/accounts/accounts.ts";
import {
  accounts,
  attachments,
  auditLog,
  events,
  folderMessages,
  folders,
  messages,
} from "../src/db/schema.ts";
import type { Account } from "../src/imap/connection.ts";
import { runSyncCycle } from "../src/sync/cycle.ts";
import { AccountSupervisor } from "../src/sync/supervisor.ts";
import {
  ANA,
  LUIS,
  accountInput,
  appendMail,
  config,
  createTestAccount,
  inFolder,
  openTestEnv,
  otherClient,
  resetDb,
  resetMailbox,
  sendMail,
  syncAll,
  waitFor,
  type TestEnv,
} from "./helpers.ts";

let env: TestEnv;
let outlook: ImapFlow;
let account: Account;

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
});
afterEach(async () => {
  await outlook.logout().catch(() => undefined);
});

const allMessages = () => env.db.select().from(messages).orderBy(asc(messages.internalDate));
const eventTypes = async () =>
  (await env.db.select().from(events).orderBy(asc(events.id))).map((event) => event.type);

/** Presencias de un correo, con la ruta de su carpeta. */
const instancesOf = (messageId: string) =>
  env.db
    .select({ path: folders.path, uid: folderMessages.uid, goneAt: folderMessages.goneAt })
    .from(folderMessages)
    .innerJoin(folders, eq(folders.id, folderMessages.folderId))
    .where(eq(folderMessages.messageId, messageId));

const liveFlags = async (messageId: string) => {
  const [row] = await env.db
    .select({ flags: folderMessages.flags })
    .from(folderMessages)
    .where(and(eq(folderMessages.messageId, messageId), isNull(folderMessages.goneAt)));
  return row?.flags;
};

describe("alta de buzón", () => {
  it("guarda la contraseña cifrada y las capacidades del servidor", async () => {
    expect(account.secretEncrypted).not.toContain(config.TEST_MAIL_PASSWORD);
    expect(env.secrets.decrypt(account.secretEncrypted)).toBe(config.TEST_MAIL_PASSWORD);
    expect(account.capabilities).toEqual(expect.arrayContaining(["IDLE", "CONDSTORE", "MOVE"]));
    const audit = await env.db.select().from(auditLog).where(eq(auditLog.accountId, account.id));
    expect(audit.map((entry) => entry.action)).toContain("account.created");
  });

  it("rechaza una contraseña incorrecta sin crear el buzón", async () => {
    const attempt = createAccount(
      env.db,
      env.secrets,
      accountInput(LUIS, { password: "no-es-esta" }),
    );
    await expect(attempt).rejects.toBeInstanceOf(AccountConnectionError);
    await expect(attempt).rejects.toMatchObject({ kind: "auth" });
    expect(await env.db.select().from(accounts)).toHaveLength(1);
  });
});

describe("carga inicial", () => {
  it("carga el histórico por ventanas, de lo más reciente a lo más antiguo, sin eventos", async () => {
    for (let n = 1; n <= 5; n++) await appendMail(outlook, { subject: `Histórico ${n}` });

    const first = await runSyncCycle(env, account, { windowSize: 2 });
    expect(first.pending).toBe(true);
    expect((await allMessages()).map((m) => m.subject).sort()).toEqual([
      "Histórico 4",
      "Histórico 5",
    ]);

    await syncAll(env, account, { windowSize: 2 });
    expect(await allMessages()).toHaveLength(5);
    expect(await eventTypes()).toEqual([]);
  });

  it("descarga el original, extrae el texto y da de alta los adjuntos", async () => {
    await appendMail(outlook, {
      subject: "Parte de siniestro",
      text: "Adjunto el parte de la peritación.",
      attachments: [{ filename: "parte.pdf", content: Buffer.from("%PDF-1.4 contenido") }],
    });
    await syncAll(env, account);

    const [message] = await allMessages();
    expect(message?.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await env.rawStore.has(message!.rawSha256!)).toBe(true);
    expect(message?.bodyText).toContain("peritación");
    expect(message?.snippet).toContain("Adjunto el parte");
    expect(message?.hasAttachments).toBe(true);

    const files = await env.db.select().from(attachments);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: "parte.pdf", contentType: "application/pdf" });
  });

  it("reconoce las carpetas especiales", async () => {
    await syncAll(env, account);
    const rows = await env.db.select().from(folders).where(eq(folders.accountId, account.id));
    const byUse = new Map(rows.map((row) => [row.specialUse, row.path]));
    expect(byUse.get("inbox")).toBe("INBOX");
    expect(byUse.get("sent")).toBe("Sent");
    expect(byUse.get("drafts")).toBe("Drafts");
    expect(byUse.get("trash")).toBe("Trash");
  });
});

for (const useCondstore of [true, false]) {
  describe(`cambios hechos desde otro cliente (${useCondstore ? "con" : "sin"} CONDSTORE)`, () => {
    const options = { useCondstore, deleteGraceMs: 0 };

    it("detecta un correo nuevo y emite el evento", async () => {
      await syncAll(env, account, options);
      await appendMail(outlook, { subject: "Recién llegado" });
      const [result] = await syncAll(env, account, options);

      expect(result?.created).toBe(1);
      expect((await allMessages()).map((m) => m.subject)).toEqual(["Recién llegado"]);
      expect(await eventTypes()).toEqual(["message.received"]);
    });

    it("refleja las marcas, incluidas las palabras clave propias del otro cliente", async () => {
      const uid = await appendMail(outlook);
      await syncAll(env, account, options);
      const [message] = await allMessages();
      expect(await liveFlags(message!.id)).toEqual([]);

      await inFolder(outlook, "INBOX", () =>
        outlook.messageFlagsAdd(String(uid), ["\\Seen", "\\Flagged", "$MailFlagBit0"], {
          uid: true,
        }),
      );
      await syncAll(env, account, options);
      expect(await liveFlags(message!.id)).toEqual(["$MailFlagBit0", "\\Flagged", "\\Seen"]);

      await inFolder(outlook, "INBOX", () =>
        outlook.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true }),
      );
      await syncAll(env, account, options);
      expect(await liveFlags(message!.id)).toEqual(["$MailFlagBit0", "\\Flagged"]);

      const flagEvents = (await env.db.select().from(events)).filter(
        (event) => event.type === "message.flagsChanged",
      );
      expect(flagEvents).toHaveLength(2);
      expect(flagEvents[1]?.payload).toMatchObject({ removed: ["\\Seen"], added: [] });
    });

    it("un correo movido conserva su identificador, en los dos sentidos", async () => {
      await outlook.mailboxCreate("Siniestros");
      const uid = await appendMail(outlook, { subject: "Se va a mover" }, "INBOX", ["\\Seen"]);
      await syncAll(env, account, options);
      const [before] = await allMessages();

      // Entrada → Siniestros: la carpeta de origen se sincroniza antes que la de destino.
      await inFolder(outlook, "INBOX", () =>
        outlook.messageMove(String(uid), "Siniestros", { uid: true }),
      );
      await syncAll(env, account, options);

      let rows = await allMessages();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(before!.id);
      expect(rows[0]?.deletedOnServerAt).toBeNull();
      let instances = await instancesOf(before!.id);
      expect(instances.find((i) => i.path === "INBOX")?.goneAt).not.toBeNull();
      expect(instances.find((i) => i.path === "Siniestros")?.goneAt).toBeNull();
      expect(await liveFlags(before!.id)).toEqual(["\\Seen"]);
      expect(await eventTypes()).toEqual(["message.moved"]);

      // Siniestros → Entrada: ahora el destino se sincroniza antes que el origen.
      await inFolder(outlook, "Siniestros", () => outlook.messageMove("1:*", "INBOX"));
      await syncAll(env, account, options);

      rows = await allMessages();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(before!.id);
      expect(rows[0]?.deletedOnServerAt).toBeNull();
      instances = await instancesOf(before!.id);
      expect(instances.filter((i) => i.goneAt === null).map((i) => i.path)).toEqual(["INBOX"]);
    });

    it("da por borrado un correo solo cuando no queda ninguna copia y pasa el periodo de gracia", async () => {
      const uid = await appendMail(outlook, { subject: "Se va a borrar" });
      await syncAll(env, account, options);

      await inFolder(outlook, "INBOX", () => outlook.messageDelete(String(uid), { uid: true }));

      // Con el periodo de gracia normal todavía no cuenta como borrado.
      await syncAll(env, account, { useCondstore });
      expect((await allMessages())[0]?.deletedOnServerAt).toBeNull();

      await syncAll(env, account, options);
      expect((await allMessages())[0]?.deletedOnServerAt).not.toBeNull();
      expect(await eventTypes()).toEqual(["message.deleted"]);
    });
  });
}

describe("identidad e hilos", () => {
  it("no fusiona dos correos distintos que comparten Message-ID", async () => {
    const messageId = "<repetido@escaner.test>";
    await appendMail(outlook, { messageId, subject: "Documento escaneado 1", text: "Primero" });
    await appendMail(outlook, { messageId, subject: "Documento escaneado 2", text: "El segundo" });
    await syncAll(env, account);

    const rows = await allMessages();
    expect(rows.map((m) => m.subject).sort()).toEqual([
      "Documento escaneado 1",
      "Documento escaneado 2",
    ]);
    expect(new Set(rows.map((m) => m.id)).size).toBe(2);
  });

  it("no comparte correos entre buzones aunque sean el mismo correo", async () => {
    await resetMailbox(LUIS);
    const luis = await createTestAccount(env, LUIS);
    const other = await otherClient(LUIS);
    try {
      const shared = { messageId: "<circular@correo.test>", subject: "Circular interna" };
      await appendMail(outlook, shared);
      await appendMail(other, shared);
    } finally {
      await other.logout();
    }
    await syncAll(env, account);
    await syncAll(env, luis);

    const rows = await allMessages();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((m) => m.accountId))).toEqual(new Set([account.id, luis.id]));
    expect(rows[0]?.threadId).not.toBe(rows[1]?.threadId);
  });

  it("agrupa las respuestas en el hilo por cabeceras, nunca por asunto", async () => {
    await appendMail(outlook, { messageId: "<origen@correo.test>", subject: "Siniestro" });
    await appendMail(outlook, {
      messageId: "<respuesta@correo.test>",
      subject: "RE: Siniestro",
      inReplyTo: "<origen@correo.test>",
      references: ["<origen@correo.test>"],
    });
    await appendMail(outlook, { messageId: "<otro@correo.test>", subject: "Siniestro" });
    await syncAll(env, account);

    const byHeader = new Map((await allMessages()).map((m) => [m.messageIdHeader, m.threadId]));
    const origin = byHeader.get("<origen@correo.test>");
    expect(origin).toBeDefined();
    expect(byHeader.get("<respuesta@correo.test>")).toBe(origin);
    expect(byHeader.get("<otro@correo.test>")).not.toBe(origin);
  });

  it("une dos hilos cuando llega tarde el correo que los enlaza", async () => {
    await syncAll(env, account);
    // Llegan primero dos respuestas al mismo correo, que aún no hemos visto.
    await appendMail(outlook, {
      messageId: "<r1@correo.test>",
      references: ["<raiz@correo.test>"],
    });
    await syncAll(env, account);
    await appendMail(outlook, { messageId: "<suelto@correo.test>" });
    await syncAll(env, account);
    await appendMail(outlook, {
      messageId: "<raiz@correo.test>",
      references: ["<suelto@correo.test>"],
    });
    await syncAll(env, account);

    expect(new Set((await allMessages()).map((m) => m.threadId)).size).toBe(1);
  });
});

describe("robustez", () => {
  it("se recupera cuando el servidor renumera una carpeta (cambio de UIDVALIDITY)", async () => {
    await outlook.mailboxCreate("Temporal");
    await appendMail(outlook, { subject: "Antes" }, "Temporal");
    await syncAll(env, account);

    await outlook.mailboxDelete("Temporal");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await outlook.mailboxCreate("Temporal");
    await appendMail(outlook, { subject: "Después" }, "Temporal");
    await syncAll(env, account, { deleteGraceMs: 0 });

    const rows = await allMessages();
    const live = rows.filter((m) => m.deletedOnServerAt === null).map((m) => m.subject);
    expect(live).toEqual(["Después"]);
    expect(rows.find((m) => m.subject === "Antes")?.deletedOnServerAt).not.toBeNull();
  });

  it("marca la carpeta que desaparece y conserva los correos que pasaron a otra", async () => {
    await outlook.mailboxCreate("Vieja");
    await appendMail(outlook, { subject: "Viajero" }, "Vieja");
    await syncAll(env, account);
    const [before] = await allMessages();

    await outlook.mailboxRename("Vieja", "Nueva");
    await syncAll(env, account, { deleteGraceMs: 0 });

    const rows = await allMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before!.id);
    expect(rows[0]?.deletedOnServerAt).toBeNull();
    const paths = await env.db.select().from(folders).where(eq(folders.accountId, account.id));
    expect(paths.find((f) => f.path === "Vieja")?.goneAt).not.toBeNull();
    expect(paths.find((f) => f.path === "Nueva")?.goneAt).toBeNull();
  });

  it("anota el fallo de credenciales en el buzón", async () => {
    const broken = { ...account, secretEncrypted: env.secrets.encrypt("caducada") };
    await expect(runSyncCycle(env, broken)).rejects.toThrow();
    const [row] = await env.db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(row?.state).toBe("auth_error");
  });
});

describe("supervisor", () => {
  it("se entera al momento de lo que llega y de lo que cambia, sin esperar al sondeo", async () => {
    const errors: unknown[] = [];
    const supervisor = new AccountSupervisor(env, account, {
      pollIntervalMs: 10 * 60_000,
      onError: (error) => errors.push(error),
    });
    supervisor.start();
    try {
      // Primer ciclo terminado: a partir de aquí solo puede despertarlo un aviso del servidor.
      await waitFor(async () => {
        const [row] = await env.db.select().from(accounts).where(eq(accounts.id, account.id));
        return row?.lastSyncAt;
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await sendMail(LUIS, { to: ANA, subject: "Llega en vivo", text: "Hola" });
      const arrived = await waitFor(async () => (await allMessages())[0], 10_000);
      expect(arrived.subject).toBe("Llega en vivo");

      await inFolder(outlook, "INBOX", () => outlook.messageFlagsAdd("1:*", ["\\Seen"]));
      await waitFor(async () => (await liveFlags(arrived.id))?.includes("\\Seen"), 10_000);
      expect(errors).toEqual([]);
    } finally {
      await supervisor.stop();
    }
  });
});
