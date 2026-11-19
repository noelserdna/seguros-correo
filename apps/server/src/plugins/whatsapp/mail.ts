/**
 * Un mensaje de WhatsApp como correo: mismo remitente y destinatario de siempre para cada
 * contacto, asunto fijo y cabeceras que lo encadenan con el anterior, para que cada
 * conversación sea un hilo. Lo que mande el cliente llega a la carpeta como recibido; lo que
 * conteste la empresa, como enviado por el buzón.
 */
import { createHash } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { formatPhone, type WaMessage } from "./meta.ts";

/** Dominio reservado: estas direcciones nunca se pueden enviar por correo por error. */
export const WA_DOMAIN = "whatsapp.invalid";

export const contactAddress = (phone: string) => `${phone}@${WA_DOMAIN}`;

/** Identificador de correo estable para cada mensaje de WhatsApp. */
export const mailIdOf = (wamid: string) =>
  `<wa.${createHash("sha256").update(wamid).digest("hex").slice(0, 32)}@${WA_DOMAIN}>`;

export const subjectOf = (phone: string, name: string | null) =>
  `WhatsApp · ${name ? `${name} (${formatPhone(phone)})` : formatPhone(phone)}`;

export type MailInput = {
  message: WaMessage;
  name: string | null;
  office: { name: string; address: string };
  /** El mensaje anterior de la conversación (o el citado), y el primero. */
  inReplyTo: string | null;
  references: string[];
  file: { filename: string; content: Buffer; contentType: string } | null;
};

export async function buildMail(input: MailInput): Promise<Buffer> {
  const { message, office } = input;
  const contact = {
    name: input.name ? `${input.name} · WhatsApp` : `${formatPhone(message.phone)} · WhatsApp`,
    address: contactAddress(message.phone),
  };
  const sender = { name: `${office.name} · WhatsApp`, address: office.address };
  const lines = [message.text];
  if (message.history) lines.push("", "— Traído del historial de WhatsApp al conectar el número.");
  return new MailComposer({
    from: message.direction === "in" ? contact : sender,
    to: message.direction === "in" ? sender : contact,
    subject: subjectOf(message.phone, input.name),
    text: lines.join("\n"),
    date: message.at,
    messageId: mailIdOf(message.id),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references.length > 0 ? { references: input.references } : {}),
    headers: {
      "X-WhatsApp-Id": message.id,
      "X-WhatsApp-Phone": `+${message.phone}`,
      "X-WhatsApp-Type": message.kind,
    },
    attachments: input.file ? [input.file] : [],
  })
    .compile()
    .build();
}
