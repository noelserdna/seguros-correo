import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { buildMail, contactAddress, mailIdOf } from "./mail.ts";
import { formatPhone, messagesOf, signBody, validSignature } from "./meta.ts";
import { echoes, history, incoming, location, media, text } from "./simulate.ts";

const BUSINESS = "34976000100";
const CLIENT = "34600111222";
const at = new Date("2026-11-18T09:30:00Z");

describe("avisos de Meta", () => {
  it("comprueba la firma del cuerpo exacto", () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const signature = signBody(body, "secreto");
    expect(validSignature(body, signature, "secreto")).toBe(true);
    expect(validSignature(body, signature, "otro")).toBe(false);
    expect(validSignature(Buffer.from("{}"), signature, "secreto")).toBe(false);
    expect(validSignature(body, undefined, "secreto")).toBe(false);
  });

  it("entiende lo que escribe el cliente, con su nombre, adjuntos y ubicación", () => {
    const payload = incoming(
      BUSINESS,
      [{ phone: CLIENT, name: "Pilar Ferrer" }],
      [
        text(CLIENT, at, "Hola, os mando las fotos del golpe"),
        media(CLIENT, new Date(at.getTime() + 60_000), "image", "M1", "image/jpeg", {
          caption: "Lateral",
        }),
        media(CLIENT, new Date(at.getTime() + 120_000), "audio", "M2", "audio/ogg; codecs=opus", {
          voice: true,
        }),
        location(CLIENT, new Date(at.getTime() + 180_000), 41.65, -0.88, "Nave de Plaza"),
      ],
    );
    const messages = messagesOf(payload);
    expect(
      messages.map((message) => [message.direction, message.phone, message.name, message.kind]),
    ).toEqual([
      ["in", CLIENT, "Pilar Ferrer", "text"],
      ["in", CLIENT, "Pilar Ferrer", "image"],
      ["in", CLIENT, "Pilar Ferrer", "audio"],
      ["in", CLIENT, "Pilar Ferrer", "location"],
    ]);
    expect(messages[1]).toMatchObject({
      text: "Lateral",
      media: { id: "M1", mime: "image/jpeg", filename: "foto.jpg" },
    });
    expect(messages[2]).toMatchObject({
      text: "(Nota de voz)",
      media: { mime: "audio/ogg", filename: "nota_de_voz.ogg" },
    });
    expect(messages[3]!.text).toContain("Nave de Plaza");
    expect(messages[3]!.text).toContain("maps?q=41.65,-0.88");
  });

  it("las respuestas desde el móvil son salientes y el historial va al teléfono del hilo", () => {
    const sent = messagesOf(echoes(BUSINESS, [text(BUSINESS, at, "Recibido, gracias", CLIENT)]));
    expect(sent[0]).toMatchObject({ direction: "out", phone: CLIENT, text: "Recibido, gracias" });
    const old = messagesOf(
      history(BUSINESS, [
        {
          phone: CLIENT,
          messages: [text(CLIENT, at, "Mensaje antiguo"), text(BUSINESS, at, "Respuesta antigua")],
        },
      ]),
    );
    expect(old.map((message) => [message.direction, message.phone, message.history])).toEqual([
      ["in", CLIENT, true],
      ["out", CLIENT, true],
    ]);
  });

  it("no se rompe con avisos que no traen mensajes", () => {
    expect(messagesOf({})).toEqual([]);
    expect(
      messagesOf({
        entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "x" }] } }] }],
      }),
    ).toEqual([]);
  });

  it("formatea los teléfonos españoles", () => {
    expect(formatPhone(CLIENT)).toBe("+34 600 111 222");
    expect(formatPhone("447700900123")).toBe("+447700900123");
  });
});

describe("el mensaje como correo", () => {
  it("lleva remitente, asunto fijo, hilo y adjunto", async () => {
    const [message] = messagesOf(
      incoming(
        BUSINESS,
        [{ phone: CLIENT, name: "Pilar Ferrer" }],
        [media(CLIENT, at, "document", "D1", "application/pdf", { filename: "DNI.pdf" })],
      ),
    );
    const raw = await buildMail({
      message: message!,
      name: "Pilar Ferrer",
      office: { name: "Siniestros", address: "siniestros@correo.test" },
      inReplyTo: "<anterior@whatsapp.invalid>",
      references: ["<primero@whatsapp.invalid>", "<anterior@whatsapp.invalid>"],
      file: {
        filename: "DNI.pdf",
        content: Buffer.from("%PDF-1.4"),
        contentType: "application/pdf",
      },
    });
    const parsed = await simpleParser(raw);
    expect(parsed.from?.value[0]).toMatchObject({
      name: "Pilar Ferrer · WhatsApp",
      address: contactAddress(CLIENT),
    });
    expect(parsed.to && "value" in parsed.to ? parsed.to.value[0]?.address : null).toBe(
      "siniestros@correo.test",
    );
    expect(parsed.subject).toBe("WhatsApp · Pilar Ferrer (+34 600 111 222)");
    expect(parsed.messageId).toBe(mailIdOf(message!.id));
    expect(parsed.inReplyTo).toBe("<anterior@whatsapp.invalid>");
    expect(parsed.date?.toISOString()).toBe(at.toISOString());
    expect(parsed.attachments.map((file) => file.filename)).toEqual(["DNI.pdf"]);
    expect(parsed.headers.get("x-whatsapp-id")).toBe(message!.id);
  });
});
