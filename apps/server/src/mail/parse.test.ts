import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { describe, expect, it } from "vitest";
import { parseMail } from "./parse.ts";

describe("análisis de un correo", () => {
  it("un correo adjunto dentro de otro sigue siendo un adjunto, no parte del cuerpo", async () => {
    const inner =
      "From: taller@example.test\r\nSubject: Recogida\r\nContent-Type: text/plain\r\n\r\nEl vehículo estará listo el viernes.\r\n";
    const raw = await new MailComposer({
      from: "a@example.test",
      to: "b@example.test",
      subject: "Te lo paso",
      text: "Va el correo del taller.",
      attachments: [{ filename: "original.eml", content: inner, contentType: "message/rfc822" }],
    })
      .compile()
      .build();

    const parsed = await parseMail(raw);
    expect(parsed.text?.trim()).toBe("Va el correo del taller.");
    expect(parsed.attachments.map((part) => `${part.filename}: ${part.contentType}`)).toEqual([
      "original.eml: message/rfc822",
    ]);
    expect(parsed.attachments[0]?.content.toString()).toContain("estará listo el viernes");
  });
});
