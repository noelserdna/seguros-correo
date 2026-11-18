import type { Address } from "./api.ts";

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Destinatarios tal como se escriben en el campo: «Nombre <correo>» o solo el correo. */
export const formatRecipients = (list: Address[]) =>
  list
    .map((entry) => {
      if (!entry.name) return entry.address;
      const name = /[,;]/.test(entry.name) ? `"${entry.name}"` : entry.name;
      return `${name} <${entry.address}>`;
    })
    .join(", ");

/** Trocea por coma, punto y coma o salto de línea, salvo dentro de comillas: «"Albor, S.A." <…>». */
function splitOutsideQuotes(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === "," || char === ";" || char === "\n")) {
      pieces.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  pieces.push(current);
  return pieces;
}

/**
 * Lee un campo de destinatarios separados por coma, punto y coma o salto de línea.
 * Devuelve los válidos y, aparte, los trozos que no son una dirección de correo.
 */
export function parseRecipients(text: string): { list: Address[]; invalid: string[] } {
  const list: Address[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const piece of splitOutsideQuotes(text)) {
    const part = piece.trim();
    if (!part) continue;
    const named = /^(.*)<([^<>]+)>$/.exec(part);
    const address = (named ? named[2]! : part).trim();
    const name = named ? named[1]!.trim().replace(/^"|"$/g, "") : "";
    if (!EMAIL.test(address)) {
      invalid.push(part);
      continue;
    }
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    list.push({ name, address });
  }
  return { list, invalid };
}
