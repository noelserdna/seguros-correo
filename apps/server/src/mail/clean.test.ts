import { describe, expect, it } from "vitest";
import { cleanBody } from "./clean.ts";

describe("texto limpio de un correo", () => {
  it("quita el historial que cita Gmail y deja la respuesta", () => {
    const { text, removed } = cleanBody({
      html: `<div dir="ltr">Recibido, mañana os mando el parte.</div><br>
        <div class="gmail_quote"><div class="gmail_attr">El lun, 16 nov 2026 a las 13:05, Laura escribió:</div>
        <blockquote class="gmail_quote">Hola, ayer tuvimos un golpe en el camión.</blockquote></div>`,
    });
    expect(text).toBe("Recibido, mañana os mando el parte.");
    expect(removed).toContain("historial");
  });

  it("quita el historial de Outlook, que no va dentro de un bloque propio", () => {
    const { text } = cleanBody({
      html: `<div class="WordSection1"><p>Buenos días:</p><p>Adjunto la póliza.</p>
        <div id="divRplyFwdMsg"><b>De:</b> Tramitación &lt;t@albor.test&gt;<br><b>Enviado el:</b> lunes</div>
        <p>Necesitamos la póliza y el parte.</p></div>`,
    });
    expect(text).toBe("Buenos días:\nAdjunto la póliza.");
  });

  it("quita el historial de Apple Mail y Thunderbird", () => {
    const apple = cleanBody({
      html: `<div>De acuerdo.</div><blockquote type="cite"><div>El 17 nov 2026, Marta escribió:</div><div>¿Te va bien el jueves?</div></blockquote>`,
    });
    expect(apple.text).toBe("De acuerdo.");
    const thunderbird = cleanBody({
      html: `<p>Sí, el jueves.</p><div class="moz-cite-prefix">El 17/11/26 a las 10:00, Marta escribió:</div><blockquote>¿Te va bien el jueves?</blockquote>`,
    });
    expect(thunderbird.text).toBe("Sí, el jueves.");
  });

  it("en texto plano corta en la cabecera de respuesta, en español y en inglés", () => {
    const spanish = cleanBody({
      text: "Perfecto, gracias.\n\nEl 17 nov 2026, a las 13:37, Andrés <a@x.test> escribió:\n> Te lo envío hoy.\n> Un saludo",
    });
    expect(spanish.text).toBe("Perfecto, gracias.");
    const outlook = cleanBody({
      text: "Va adjunto.\n\n-----Mensaje original-----\nDe: Luis\nEnviado el: lunes\nAsunto: Parte\n\n¿Me lo mandas?",
    });
    expect(outlook.text).toBe("Va adjunto.");
    const english = cleanBody({
      text: "Thanks!\n\nOn Mon, Nov 16, 2026 at 1:05 PM Laura wrote:\n> Hello",
    });
    expect(english.text).toBe("Thanks!");
    const block = cleanBody({
      text: "Lo reviso.\n\nDe: Tramitación <t@albor.test>\nEnviado el: lunes, 16 de noviembre\nPara: Siniestros\n\nNecesitamos el parte.",
    });
    expect(block.text).toBe("Lo reviso.");
  });

  it("no recorta un reenvío: ahí el contenido es el mensaje reenviado", () => {
    const { text, removed } = cleanBody({
      subject: "RV: Presupuesto del taller",
      text: "Te lo paso.\n\n-----Mensaje original-----\nDe: Taller\n\nEl presupuesto asciende a 1.240 €.",
    });
    expect(text).toContain("El presupuesto asciende a 1.240 €.");
    expect(removed).not.toContain("historial");
  });

  it("no corta cuando la respuesta va debajo de lo citado", () => {
    const { text } = cleanBody({
      text: "El 17 nov 2026, Marta escribió:\n> ¿Te va bien el jueves?\n\nSí, el jueves por la mañana.",
    });
    expect(text).toContain("Sí, el jueves por la mañana.");
  });

  it("quita la firma separada con guiones y el aviso legal del pie", () => {
    const { text, removed } = cleanBody({
      text: "Queda anotado el siniestro 2026/0142.\n\n-- \nMarta Ruiz\nSiniestros · 976 000 000\n\nAVISO LEGAL: Este mensaje y sus adjuntos son confidenciales.",
    });
    expect(text).toBe("Queda anotado el siniestro 2026/0142.");
    expect(removed).toEqual(["aviso legal", "firma"]);

    const legal = cleanBody({
      text: "Os confirmo la visita del perito.\n\nEste correo electrónico es confidencial y va dirigido exclusivamente a su destinatario.",
    });
    expect(legal.text).toBe("Os confirmo la visita del perito.");
  });

  it("deja intacto un correo sin nada que quitar", () => {
    const { text, removed } = cleanBody({
      text: "Hola:\n\nAdjunto las fotos del golpe.\n\nUn saludo,\nLaura",
    });
    expect(text).toBe("Hola:\n\nAdjunto las fotos del golpe.\n\nUn saludo,\nLaura");
    expect(removed).toEqual([]);
  });
});
