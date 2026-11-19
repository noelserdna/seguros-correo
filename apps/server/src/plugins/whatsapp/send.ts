/**
 * Responder por WhatsApp desde la aplicación: un correo cuyo destinatario es un contacto de
 * WhatsApp sale por la API de Meta en lugar de por SMTP. Solo el texto nuevo (sin la cita del
 * mensaje anterior ni la firma) y cada adjunto como un mensaje aparte. La copia queda en el
 * hilo del contacto, no en Enviados.
 */
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { cleanBody } from "../../mail/clean.ts";
import type { OutboundTransport } from "../../outbound/transports.ts";
import { mediaKind, sendMessage, uploadMedia } from "./graph.ts";
import { WA_DOMAIN } from "./mail.ts";
import type { WaMessage } from "./meta.ts";
import { currentSettings } from "./settings.ts";
import { appendToThread, ensureFolder, windowOf, type WaFile } from "./thread.ts";

const isWhatsApp = (address: string) => address.toLowerCase().endsWith(`@${WA_DOMAIN}`);

/** El teléfono de una dirección de WhatsApp («34600111222@whatsapp.invalid»). */
export const phoneOf = (address: string) => address.split("@")[0]!.replace(/\D/g, "");

export const whatsappTransport: OutboundTransport = {
  id: "whatsapp",
  claims: (outbound) =>
    [...outbound.to, ...outbound.cc, ...outbound.bcc].some((address) =>
      isWhatsApp(address.address),
    ),

  async deliver({ db, client, account, rawStore, outbound, files }) {
    const settings = currentSettings();
    const recipients = [...outbound.to, ...outbound.cc, ...outbound.bcc];
    if (recipients.length !== 1) {
      throw new Error(
        "Un WhatsApp va a un solo contacto: quita los demás destinatarios o envíales un correo aparte.",
      );
    }
    const phone = phoneOf(recipients[0]!.address);
    const window = await windowOf(db, account.id, phone);
    if (!window.open) {
      throw new Error(
        "Han pasado más de 24 horas desde el último mensaje de este contacto: WhatsApp solo deja escribirle con una plantilla aprobada por Meta, y eso aún no se puede desde aquí.",
      );
    }
    const text = cleanBody({ html: outbound.bodyHtml, subject: outbound.subject }).text.trim();
    if (!text && files.length === 0) throw new Error("El mensaje está vacío.");

    // Si se contesta a un mensaje concreto, WhatsApp lo enseña citado.
    const quoted = outbound.sourceMessageId
      ? (
          await db.execute<{ wamid: string }>(sql`
            select w.wamid from wa_messages w join messages m on m.message_id_header = w.mail_id
             where m.id = ${outbound.sourceMessageId} limit 1`)
        ).rows[0]?.wamid
      : undefined;

    const sent: { message: WaMessage; file: WaFile | null }[] = [];
    const out = (id: string, kind: string, body: string, raw: unknown): WaMessage => ({
      id,
      direction: "out",
      phone,
      name: window.name,
      at: new Date(),
      kind,
      text: body,
      media: null,
      replyTo: sent.length === 0 ? (quoted ?? null) : null,
      history: false,
      raw,
    });

    let failure: Error | null = null;
    try {
      if (text) {
        const body = {
          to: phone,
          type: "text",
          text: { body: text, preview_url: true },
          ...(quoted ? { context: { message_id: quoted } } : {}),
        };
        sent.push({
          message: out(await sendMessage(settings, body), "text", text, body),
          file: null,
        });
      }
      for (const file of files) {
        const content = await readFile(rawStore.pathFor(file.sha256));
        const mediaId = await uploadMedia(settings, {
          filename: file.filename,
          contentType: file.contentType,
          content,
        });
        const kind = mediaKind(file.contentType);
        const body = {
          to: phone,
          type: kind,
          [kind]: kind === "document" ? { id: mediaId, filename: file.filename } : { id: mediaId },
        };
        sent.push({
          message: out(await sendMessage(settings, body), kind, `(${file.filename})`, body),
          file: { filename: file.filename, content, contentType: file.contentType },
        });
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    // La copia de lo que ha salido, en el hilo del contacto.
    try {
      await ensureFolder(client, settings.folder);
      for (const entry of sent) {
        await appendToThread({ db, client, account, folder: settings.folder, ...entry });
      }
    } catch (error) {
      console.error("WhatsApp: enviado, pero sin copia en el hilo:", error);
    }
    if (failure) {
      // Lo que ya salió no se puede deshacer: se dice, para que nadie lo reenvíe entero.
      throw sent.length === 0
        ? failure
        : new Error(
            `Se envió una parte (${sent.length} de ${(text ? 1 : 0) + files.length} mensajes) y el resto falló: ${failure.message}`,
          );
    }
  },
};
