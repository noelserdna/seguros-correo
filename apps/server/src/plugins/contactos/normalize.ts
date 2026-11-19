/** Cómo se guarda cada correo y teléfono, para que la misma persona se reconozca siempre. */

export const ROLES = [
  "cliente",
  "aseguradora",
  "perito",
  "taller",
  "abogado",
  "policia",
  "medico",
  "grua",
  "otro",
] as const;
export type Role = (typeof ROLES)[number];

/** Dominio de las direcciones con que el módulo de WhatsApp escribe sus correos. */
export const WHATSAPP_DOMAIN = "whatsapp.invalid";

export const normalizeEmail = (value: string) => value.trim().toLowerCase();

/** Solo dígitos, con prefijo de país; un número español de 9 cifras recibe el 34. */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^00/, "");
  return digits.length === 9 && /^[6789]/.test(digits) ? `34${digits}` : digits;
}

export function normalizeChannel(kind: "email" | "phone", value: string): string {
  return kind === "email" ? normalizeEmail(value) : normalizePhone(value);
}

/** De una dirección de correo, el canal con que se busca: correo o, si es de WhatsApp, teléfono. */
export function channelOfAddress(address: string): { kind: "email" | "phone"; value: string } {
  const email = normalizeEmail(address);
  const [local, domain] = email.split("@");
  if (domain === WHATSAPP_DOMAIN && local) return { kind: "phone", value: normalizePhone(local) };
  return { kind: "email", value: email };
}

/** «Pilar Ferrer · WhatsApp» → «Pilar Ferrer». */
export const cleanName = (name: string | null | undefined) =>
  (name ?? "").replace(/\s*·\s*WhatsApp$/i, "").trim();

/** Para comparar nombres: sin acentos, mayúsculas ni espacios de más. */
export const nameKey = (name: string) =>
  cleanName(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Teléfonos españoles escritos en un texto (una firma, por ejemplo). */
export function phonesIn(text: string): string[] {
  const found = text.match(/(?:\+34|0034)?[\s.-]?[6789]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/g) ?? [];
  return [...new Set(found.map(normalizePhone).filter((phone) => phone.length === 11))];
}

/**
 * Qué parece quien escribe, por reglas sencillas sobre lo que manda. Solo una pista para
 * quien revisa: nada se guarda sin que alguien lo confirme.
 */
export function guessRole(input: { address: string; subjects: string[] }): Role | null {
  const { kind, value } = channelOfAddress(input.address);
  const text = `${value} ${input.subjects.join(" ")}`.toLowerCase();
  if (/perit|tasaci/.test(text)) return "perito";
  if (/abogad|bufete|letrad|despacho/.test(text)) return "abogado";
  if (/polic[ií]a|guardia ?civil|atestados@|tr[aá]fico/.test(text)) return "policia";
  if (/presupuesto|reparad|taller|carrocer|chapa/.test(text)) return "taller";
  if (/gr[uú]a/.test(text)) return "grua";
  if (/segur|mutua|asegurad/.test(value)) return "aseguradora";
  if (kind === "phone") return "cliente";
  return null;
}

export const ROLE_LABEL: Record<Role, string> = {
  cliente: "cliente",
  aseguradora: "aseguradora",
  perito: "perito",
  taller: "taller",
  abogado: "abogado",
  policia: "policía o juzgado",
  medico: "médico",
  grua: "grúa",
  otro: "otro",
};
