import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import type { SecretBox } from "../crypto/secrets.ts";
import type { outboundAttachments, outboundMessages } from "../db/schema.ts";
import type { Account } from "../imap/connection.ts";
import type { RawStore } from "../storage/raw-store.ts";
import { htmlToText } from "./html.ts";

export type Outbound = typeof outboundMessages.$inferSelect;
export type OutboundAttachment = typeof outboundAttachments.$inferSelect;

export function smtpTransportFor(account: Account, secrets: SecretBox) {
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    requireTLS: !account.smtpSecure,
    tls: { rejectUnauthorized: !account.tlsInsecure },
    auth: { user: account.username, pass: secrets.decrypt(account.secretEncrypted) },
  });
}

/** Opciones del correo. Con la misma fecha, dos montajes dan el mismo correo. */
export function mailOptions(
  account: Account,
  outbound: Outbound,
  files: OutboundAttachment[],
  rawStore: RawStore,
  date: Date,
): Mail.Options {
  return {
    from:
      account.name && account.name !== account.email
        ? { name: account.name, address: account.email }
        : account.email,
    to: outbound.to,
    cc: outbound.cc,
    bcc: outbound.bcc,
    subject: outbound.subject,
    html: outbound.bodyHtml,
    text: htmlToText(outbound.bodyHtml),
    messageId: outbound.messageIdHeader,
    inReplyTo: outbound.inReplyTo ?? undefined,
    references: outbound.references.length > 0 ? outbound.references : undefined,
    date,
    attachments: files.map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      path: rawStore.pathFor(file.sha256),
    })),
  };
}

/** El correo montado, tal como se guarda en una carpeta (con los destinatarios ocultos). */
export async function buildRaw(options: Mail.Options): Promise<Buffer> {
  const compiled = new MailComposer(options).compile();
  // En la copia propia sí deben constar los destinatarios en copia oculta.
  (compiled as unknown as { keepBcc: boolean }).keepBcc = true;
  return compiled.build();
}
