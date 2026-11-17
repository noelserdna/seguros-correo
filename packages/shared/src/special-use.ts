/** Carpetas con un papel especial en un buzón. */
export const SPECIAL_USES = ["inbox", "sent", "drafts", "trash", "junk", "archive"] as const;
export type SpecialUse = (typeof SPECIAL_USES)[number];

/** Atributos de uso especial que anuncia el servidor (RFC 6154). */
const BY_ATTRIBUTE: Record<string, SpecialUse> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
};

/**
 * Nombres habituales cuando el servidor no anuncia el uso especial.
 * Incluye los que crean Outlook y los hostings en español e inglés.
 */
const BY_NAME: Record<string, SpecialUse> = {
  sent: "sent",
  "sent items": "sent",
  "sent messages": "sent",
  "sent mail": "sent",
  enviados: "sent",
  "elementos enviados": "sent",
  "correo enviado": "sent",
  drafts: "drafts",
  draft: "drafts",
  borradores: "drafts",
  borrador: "drafts",
  trash: "trash",
  "deleted items": "trash",
  "deleted messages": "trash",
  papelera: "trash",
  "elementos eliminados": "trash",
  junk: "junk",
  "junk e-mail": "junk",
  "junk email": "junk",
  spam: "junk",
  "correo no deseado": "junk",
  archive: "archive",
  archivo: "archive",
  archivados: "archive",
};

/**
 * Decide el papel de una carpeta. Manda lo que anuncia el servidor; el nombre
 * solo se usa como respaldo, y solo en carpetas de primer nivel (una subcarpeta
 * «Clientes/Enviados» no es la carpeta de enviados del buzón).
 */
export function detectSpecialUse(folder: {
  path: string;
  delimiter?: string | undefined;
  specialUse?: string | undefined;
  flags?: Iterable<string> | undefined;
}): SpecialUse | null {
  if (folder.path.toUpperCase() === "INBOX") return "inbox";

  const attributes = [folder.specialUse, ...(folder.flags ?? [])];
  for (const attribute of attributes) {
    const use = attribute ? BY_ATTRIBUTE[attribute.toLowerCase()] : undefined;
    if (use) return use;
  }

  const delimiter = folder.delimiter ?? "/";
  const parts = folder.path.split(delimiter);
  // Algunos servidores cuelgan todo de INBOX («INBOX.Sent»): eso cuenta como primer nivel.
  if (parts[0]?.toUpperCase() === "INBOX") parts.shift();
  if (parts.length !== 1) return null;

  return BY_NAME[parts[0]!.trim().toLowerCase()] ?? null;
}
