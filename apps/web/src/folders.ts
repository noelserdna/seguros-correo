import type { Folder } from "./api.ts";

const SPECIAL_NAMES: Record<string, string> = {
  inbox: "Entrada",
  sent: "Enviados",
  drafts: "Borradores",
  trash: "Papelera",
  junk: "Correo no deseado",
};
const SPECIAL_ORDER = ["inbox", "drafts", "sent", "archive", "trash", "junk"];

export type FolderRow = { folder: Folder; name: string; depth: number };

/** Nombre de una carpeta tal como lo ve el usuario. */
export function folderName(folder: Pick<Folder, "path" | "delimiter" | "specialUse">): string {
  const special = folder.specialUse ? SPECIAL_NAMES[folder.specialUse] : undefined;
  if (special) return special;
  const parts = folder.path.split(folder.delimiter || "/");
  return parts.at(-1) || folder.path;
}

/** Dónde está un correo, en palabras: «Enviados», «Siniestros / 2024». */
export function locationName(path: string, specialUse: string | null, delimiter = "/"): string {
  return (specialUse && SPECIAL_NAMES[specialUse]) || folderTrail(path, delimiter);
}

/**
 * Deja un solo mensaje por cabecera Message-ID. La copia de Enviados y la recibida
 * comparten cabecera cuando alguien se escribe a sí mismo o se pone en copia: en la
 * conversación es el mismo mensaje. Se conserva el indicado en `keep`.
 */
export function uniqueByHeader<T extends { id: string; messageIdHeader: string | null }>(
  list: T[],
  keep: string | null,
): T[] {
  const kept = new Map<string, T>();
  const result: T[] = [];
  for (const entry of list) {
    const header = entry.messageIdHeader;
    if (!header) {
      result.push(entry);
      continue;
    }
    const previous = kept.get(header);
    if (!previous) {
      kept.set(header, entry);
      result.push(entry);
    } else if (entry.id === keep) {
      result[result.indexOf(previous)] = entry;
      kept.set(header, entry);
    }
  }
  return result;
}

/** Ruta legible: «Siniestros / 2024». */
export function folderTrail(path: string, delimiter = "/"): string {
  const parts = path.split(delimiter);
  if (parts[0]?.toUpperCase() === "INBOX") parts[0] = "Entrada";
  return parts.join(" / ");
}

/**
 * Ordena las carpetas como un árbol: primero las especiales, en su orden de siempre,
 * y después el resto por nombre, cada una seguida de sus subcarpetas.
 */
export function folderRows(folders: Folder[]): FolderRow[] {
  const segments = (folder: Folder) => {
    const parts = folder.path.split(folder.delimiter || "/");
    // Algunos servidores cuelgan todo de INBOX: no cuenta como nivel.
    return parts.length > 1 && parts[0]?.toUpperCase() === "INBOX" ? parts.slice(1) : parts;
  };
  const rank = (folder: Folder) => {
    const index = SPECIAL_ORDER.indexOf(folder.specialUse ?? "");
    return index === -1 ? SPECIAL_ORDER.length : index;
  };
  const byParent = new Map<string, Folder[]>();
  const keyOf = (parts: string[]) => parts.join("\u0000");
  const known = new Set(folders.map((folder) => keyOf(segments(folder))));

  for (const folder of folders) {
    const parts = segments(folder);
    // Si falta la carpeta madre (no seleccionable), la hija sube al primer nivel.
    let parent = parts.slice(0, -1);
    while (parent.length > 0 && !known.has(keyOf(parent))) parent = parent.slice(0, -1);
    const key = keyOf(parent);
    byParent.set(key, [...(byParent.get(key) ?? []), folder]);
  }

  const rows: FolderRow[] = [];
  const visit = (parentKey: string, depth: number) => {
    const children = (byParent.get(parentKey) ?? []).sort(
      (a, b) => rank(a) - rank(b) || folderName(a).localeCompare(folderName(b), "es"),
    );
    for (const folder of children) {
      rows.push({ folder, name: folderName(folder), depth });
      visit(keyOf(segments(folder)), depth + 1);
    }
  };
  visit("", 0);
  return rows;
}
