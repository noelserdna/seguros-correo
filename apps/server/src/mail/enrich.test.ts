import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { describe, expect, it } from "vitest";
import { extractStructured } from "./enrich.ts";

async function structured(options: Mail.Options, account = "siniestros@correduria.test") {
  const compiled = new MailComposer({ from: "Luis Gil <luis@albor.test>", ...options }).compile();
  (compiled as unknown as { keepBcc: boolean }).keepBcc = true;
  return extractStructured(await simpleParser(await compiled.build()), account);
}

describe("datos estructurados de un correo", () => {
  it("lista a cada participante con su papel y su dominio, sin repetir", async () => {
    const data = await structured({
      to: ["Marta <SINIESTROS@correduria.test>", "otra@correduria.test"],
      cc: "Perito <perito@gabinete.test>",
      replyTo: "tramitacion@albor.test",
    });
    expect(data.addresses).toEqual([
      { role: "from", address: "luis@albor.test", domain: "albor.test", name: "Luis Gil" },
      {
        role: "to",
        address: "siniestros@correduria.test",
        domain: "correduria.test",
        name: "Marta",
      },
      { role: "to", address: "otra@correduria.test", domain: "correduria.test", name: "" },
      { role: "cc", address: "perito@gabinete.test", domain: "gabinete.test", name: "Perito" },
      { role: "reply_to", address: "tramitacion@albor.test", domain: "albor.test", name: "" },
    ]);
    expect(data.replyTo).toEqual([{ name: "", address: "tramitacion@albor.test" }]);
    expect(data.direction).toBe("in");
  });

  it("distingue lo enviado desde el buzón y conserva la copia oculta", async () => {
    const data = await structured({
      from: "Siniestros <Siniestros@Correduria.test>",
      to: "luis@albor.test",
      bcc: "direccion@correduria.test",
    });
    expect(data.direction).toBe("out");
    expect(data.bcc).toEqual([{ name: "", address: "direccion@correduria.test" }]);
  });

  it("reconoce respuestas automáticas y la prioridad que usan Outlook y otros", async () => {
    expect((await structured({ headers: { "Auto-Submitted": "auto-replied" } })).autoReply).toBe(
      true,
    );
    expect((await structured({ headers: { "Auto-Submitted": "no" } })).autoReply).toBe(false);
    expect((await structured({ headers: { "X-Autoreply": "yes" } })).autoReply).toBe(true);
    expect((await structured({})).autoReply).toBe(false);

    expect((await structured({ headers: { Importance: "High" } })).priority).toBe("high");
    expect((await structured({ headers: { "X-Priority": "5 (Lowest)" } })).priority).toBe("low");
    expect((await structured({ headers: { "X-Priority": "3" } })).priority).toBeNull();
  });

  it("guarda todas las cabeceras y prepara destinatarios y adjuntos para la búsqueda", async () => {
    const data = await structured({
      to: "Marta Ruiz <marta@correduria.test>",
      subject: "Parte",
      text: "Va  el parte.\n\nUn saludo",
      // El logotipo va incrustado en el texto: no cuenta como adjunto.
      html: '<p>Va el parte.</p><img src="cid:logo@x">',
      headers: { "X-Referencia-Interna": "ABC-123" },
      attachments: [
        { filename: "Parte amistoso.pdf", content: "pdf" },
        { filename: "logo.png", content: "png", cid: "logo@x" },
      ],
    });
    expect(data.headers["x-referencia-interna"]).toEqual(["ABC-123"]);
    expect(data.headers.subject).toEqual(["Parte"]);
    expect(data.searchExtra).toBe("Marta Ruiz marta@correduria.test Parte amistoso.pdf");
    expect(data.hasAttachments).toBe(true);
    expect(data.snippet).toBe("Va el parte. Un saludo");
  });
});
