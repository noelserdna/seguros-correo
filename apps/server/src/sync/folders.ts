import { and, eq, isNull, notInArray } from "drizzle-orm";
import { detectSpecialUse } from "@correo/shared";
import { folders } from "../db/schema.ts";
import type { Folder, SyncContext } from "./types.ts";

/** Carpetas virtuales de Gmail: repiten correos que ya están en otras carpetas. */
const VIRTUAL = new Set(["\\all", "\\flagged", "\\important"]);
/**
 * Exchange enseña por IMAP carpetas que no son de correo (calendario, contactos, tareas…).
 * Solo se apartan en buzones de Microsoft: en otro servidor, «Notas» puede ser una carpeta real.
 */
const EXCHANGE_NOT_MAIL = new Set([
  "calendar",
  "calendario",
  "contacts",
  "contactos",
  "journal",
  "diario",
  "notes",
  "notas",
  "tasks",
  "tareas",
  "outbox",
  "bandeja de salida",
]);
const NOT_SELECTABLE = new Set(["\\noselect", "\\nonexistent"]);

const ORDER = ["inbox", "sent", "drafts", "archive", "trash", "junk"];

/**
 * Trae la lista de carpetas del servidor y la deja reflejada en la base.
 * Devuelve las carpetas a sincronizar, con la Entrada primero.
 */
export async function syncFolderList({ db, client, account }: SyncContext): Promise<Folder[]> {
  const remote = await client.list();
  const paths: string[] = [];

  for (const entry of remote) {
    const flags = [...(entry.flags ?? [])].map((flag) => flag.toLowerCase());
    const selectable = !flags.some((flag) => NOT_SELECTABLE.has(flag));
    // El papel puede venir como uso especial o solo entre los atributos (\\Important).
    const virtual =
      VIRTUAL.has((entry.specialUse ?? "").toLowerCase()) ||
      flags.some((flag) => VIRTUAL.has(flag));
    const notMail =
      account.authType === "oauth_microsoft" && EXCHANGE_NOT_MAIL.has(entry.path.toLowerCase());
    const values = {
      delimiter: entry.delimiter || "/",
      specialUse: detectSpecialUse(entry),
      subscribed: entry.subscribed ?? true,
      syncEnabled: selectable && !virtual && !notMail,
      goneAt: null,
    };
    await db
      .insert(folders)
      .values({ accountId: account.id, path: entry.path, ...values })
      .onConflictDoUpdate({ target: [folders.accountId, folders.path], set: values });
    paths.push(entry.path);
  }

  // Lo que ya no está en el servidor se marca, no se borra: sus correos pueden
  // haber pasado a otra carpeta (por ejemplo, tras renombrarla).
  await db
    .update(folders)
    .set({ goneAt: new Date() })
    .where(
      and(
        eq(folders.accountId, account.id),
        isNull(folders.goneAt),
        paths.length > 0 ? notInArray(folders.path, paths) : undefined,
      ),
    );

  const active = await db
    .select()
    .from(folders)
    .where(
      and(eq(folders.accountId, account.id), isNull(folders.goneAt), eq(folders.syncEnabled, true)),
    );
  const rank = (folder: Folder) => {
    const index = ORDER.indexOf(folder.specialUse ?? "");
    return index === -1 ? ORDER.length : index;
  };
  return active.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}
