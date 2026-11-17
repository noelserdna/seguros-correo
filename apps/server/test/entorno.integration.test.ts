/**
 * Comprueba que el entorno de desarrollo funciona de punta a punta:
 * Postgres responde, se puede enviar por SMTP y el correo aparece por IMAP.
 * Requiere `pnpm dev:up`.
 */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { detectSpecialUse } from "@correo/shared";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const ANA = "ana@correo.test";
const LUIS = "luis@correo.test";

// El servidor de pruebas usa un certificado autofirmado.
const tls = { rejectUnauthorized: false };

function imapClient(user: string): ImapFlow {
  return new ImapFlow({
    host: config.TEST_IMAP_HOST,
    port: config.TEST_IMAP_PORT,
    secure: true,
    tls,
    auth: { user, pass: config.TEST_MAIL_PASSWORD },
    logger: false,
  });
}

describe("entorno de desarrollo", () => {
  const clients: ImapFlow[] = [];

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.logout().catch(() => undefined)));
  });

  it("Postgres responde", async () => {
    const db = new pg.Client({ connectionString: config.DATABASE_URL });
    await db.connect();
    try {
      const result = await db.query<{ ok: number }>("select 1 as ok");
      expect(result.rows[0]?.ok).toBe(1);
    } finally {
      await db.end();
    }
  });

  it("el servidor IMAP anuncia las extensiones que usa la sincronización", async () => {
    const client = imapClient(ANA);
    clients.push(client);
    await client.connect();

    const capabilities = [...client.capabilities.keys()];
    expect(capabilities).toEqual(
      expect.arrayContaining(["IDLE", "CONDSTORE", "QRESYNC", "MOVE", "UIDPLUS", "SPECIAL-USE"]),
    );

    const folders = await client.list();
    expect(folders.map((folder) => detectSpecialUse(folder))).toContain("inbox");
  });

  it("un correo enviado por SMTP llega al buzón del destinatario por IMAP", async () => {
    const subject = `Prueba de entorno ${Date.now()}`;

    const transport = nodemailer.createTransport({
      host: config.TEST_SMTP_HOST,
      port: config.TEST_SMTP_PORT,
      secure: false,
      requireTLS: true,
      tls,
      auth: { user: ANA, pass: config.TEST_MAIL_PASSWORD },
    });
    const sent = await transport.sendMail({
      from: ANA,
      to: LUIS,
      subject,
      text: "Cuerpo de prueba con acentos: siniestro, peritación, póliza.",
    });
    transport.close();
    expect(sent.accepted).toContain(LUIS);

    const client = imapClient(LUIS);
    clients.push(client);
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      let uids: number[] = [];
      for (let attempt = 0; attempt < 40 && uids.length === 0; attempt++) {
        await client.noop();
        uids = (await client.search({ header: { subject } }, { uid: true })) || [];
        if (uids.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(uids).toHaveLength(1);

      const message = await client.fetchOne(String(uids[0]), { envelope: true }, { uid: true });
      expect(message && message.envelope?.messageId).toBe(sent.messageId);
    } finally {
      lock.release();
    }
  });
});
