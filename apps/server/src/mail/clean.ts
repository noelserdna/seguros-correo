import { parse, type HTMLElement } from "node-html-parser";
import { htmlToText } from "../outbound/html.ts";

/**
 * Bloques de historial citado tal como los marcan Gmail, Apple Mail, Thunderbird y
 * Outlook en el HTML. Se quita el bloque; en los de Outlook, también todo lo que sigue,
 * porque no envuelve lo citado en un elemento propio.
 */
const QUOTE_BLOCKS = "blockquote, .gmail_quote, .gmail_quote_container, .yahoo_quoted";
const QUOTE_STARTS = "#divRplyFwdMsg, #appendonsend, .moz-cite-prefix, .gmail_attr";

/** Línea a partir de la cual empieza el historial, en texto plano. */
const REPLY_HEADERS = [
  /^El .{4,120} escribió:\s*$/im,
  /^On .{4,120} wrote:\s*$/im,
  /^Le .{4,120} a écrit\s*:\s*$/im,
  /^-{2,}\s*(Mensaje original|Original Message|Mensaje reenviado|Forwarded message)\s*-{2,}\s*$/im,
  // Bloque de cabeceras que pone Outlook: «De: … / Enviado el: …».
  /^(De|From):\s.+\r?\n(Enviado( el)?|Sent|Fecha|Date):\s.+$/im,
  /^_{10,}\s*$/m,
];

/** Párrafos de aviso legal o de confidencialidad, habituales al pie. */
const LEGAL_NOTICE =
  /^(AVISO LEGAL|AVISO DE CONFIDENCIALIDAD|CONFIDENCIALIDAD|ADVERTENCIA LEGAL|PROTECCI[ÓO]N DE DATOS|DISCLAIMER|CONFIDENTIALITY NOTICE)\b|^(Este|El presente) (mensaje|correo|e-?mail)[^.\n]{0,120}(confidencial|destinatario|privilegiad)|^De conformidad con[^.\n]{0,80}(RGPD|Reglamento|LOPD|Ley Org[áa]nica)|^En cumplimiento de[^.\n]{0,80}(RGPD|Reglamento|LOPD|protecci[óo]n de datos)|^This (e-?mail|message)[^.\n]{0,120}(confidential|intended)|^Antes de imprimir/im;

const FORWARD_SUBJECT = /^\s*(rv|fw|fwd|reenv)\s*:/i;

export type CleanBody = {
  text: string;
  /** Qué se ha quitado, para poder revisar el resultado. */
  removed: ("historial" | "firma" | "aviso legal")[];
};

function stripQuotedHtml(html: string): { html: string; found: boolean } {
  const root = parse(html, { comment: false });
  let found = false;
  for (const node of root.querySelectorAll(QUOTE_STARTS)) {
    // Desde la marca hasta el final de su contenedor.
    let current: HTMLElement | null = node;
    while (current) {
      const next: HTMLElement | null = current.nextElementSibling;
      current.remove();
      current = next;
    }
    found = true;
  }
  for (const node of root.querySelectorAll(QUOTE_BLOCKS)) {
    node.remove();
    found = true;
  }
  return { html: root.toString(), found };
}

const tidy = (text: string) =>
  text
    // Espacios duros y caracteres invisibles que deja la maquetación de los boletines.
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff|\u00ad|\u034f/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    // Líneas que solo traen separadores sueltos («-», «|»), restos de tablas de maquetación.
    // (salvo «--», que es el separador de firma y se trata después).
    .replace(/^[ \t]*(?!--[ \t]*$)[-|·•_=*]{1,3}[ \t]*$/gm, "")
    .replace(/^[ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Deja de un correo solo lo que aporta de nuevo: sin el historial que arrastra citado,
 * sin la firma y sin el aviso legal. En un hilo de diez respuestas, el primer correo
 * aparecería si no diez veces.
 *
 * Es conservador a propósito: ante la duda, deja texto de más. Un reenvío no se recorta,
 * porque ahí el contenido es precisamente el mensaje reenviado. El texto completo se
 * conserva siempre aparte.
 */
export function cleanBody(input: {
  html?: string | false;
  text?: string;
  subject?: string;
}): CleanBody {
  const removed: CleanBody["removed"] = [];
  const isForward = FORWARD_SUBJECT.test(input.subject ?? "");

  let text: string;
  if (input.html && !isForward) {
    const stripped = stripQuotedHtml(input.html);
    if (stripped.found) removed.push("historial");
    text = htmlToText(stripped.html);
  } else {
    text = input.html ? htmlToText(input.html) : (input.text ?? "");
  }
  text = tidy(text);

  if (!isForward) {
    // Líneas citadas con «>» y, si hay cabecera de respuesta, todo lo que la sigue.
    const withoutMarks = text
      .split("\n")
      .filter((line) => !line.startsWith(">"))
      .join("\n");
    if (withoutMarks.length !== text.length) {
      text = withoutMarks;
      if (!removed.includes("historial")) removed.push("historial");
    }
    let cut = -1;
    for (const pattern of REPLY_HEADERS) {
      const match = pattern.exec(text);
      if (match && (cut === -1 || match.index < cut)) cut = match.index;
    }
    // Si la cabecera está al principio, es que se responde debajo de lo citado: no se corta.
    if (cut > 0 && text.slice(0, cut).trim().length > 0) {
      text = text.slice(0, cut);
      if (!removed.includes("historial")) removed.push("historial");
    }
    text = tidy(text);
  }

  const legal = LEGAL_NOTICE.exec(text);
  if (legal && legal.index > 0) {
    text = tidy(text.slice(0, legal.index));
    removed.push("aviso legal");
  }

  // Firma separada con «-- », la convención de siempre.
  const signature = /^--\s?$/m.exec(text);
  if (signature && signature.index > 0) {
    text = tidy(text.slice(0, signature.index));
    removed.push("firma");
  }

  return { text, removed };
}

/** Tamaño aproximado en tokens de un texto en español, para estimar cuánto contexto ocupa. */
export const approxTokens = (chars: number) => Math.ceil(chars / 3.5);
