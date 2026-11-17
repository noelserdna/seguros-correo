import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { events, folderMessages, folders } from "../db/schema.ts";
import { ENVELOPE_QUERY, ingestMessages, normalizeFlags, toRemoteMessage } from "./ingest.ts";
import type { Folder, SyncContext } from "./types.ts";

export type FolderSyncResult = {
  created: number;
  attached: number;
  flagsChanged: number;
  gone: number;
  /** Queda histórico por cargar en esta carpeta. */
  backfillPending: boolean;
};

const sameFlags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((f, i) => f === b[i]);

/** `n:*` devuelve el último correo aunque su uid sea menor que n; por eso se filtra después. */
const fromUid = <T extends { uid: number }>(list: T[], min: number) =>
  list.filter((item) => item.uid >= min);

/**
 * Pone al día una carpeta: correos nuevos, cambios de marcas y correos que ya no están.
 * No baja cuerpos ni histórico; eso lo hacen `backfillFolder` y `downloadBodies`.
 */
export async function syncFolder(ctx: SyncContext, folder: Folder): Promise<FolderSyncResult> {
  const { db, client, account, options } = ctx;
  const result: FolderSyncResult = {
    created: 0,
    attached: 0,
    flagsChanged: 0,
    gone: 0,
    backfillPending: false,
  };
  const useCondstore = options.useCondstore ?? account.capabilities.includes("CONDSTORE");

  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    if (!mailbox) throw new Error(`No se pudo abrir la carpeta «${folder.path}».`);
    const uidValidity = Number(mailbox.uidValidity);
    const uidNext = mailbox.uidNext;
    const modseq = mailbox.highestModseq ?? null;
    let state = folder;

    // El servidor ha renumerado la carpeta: lo que sabíamos de ella ya no vale.
    if (state.uidValidity !== null && state.uidValidity !== uidValidity) {
      const stale = await db
        .update(folderMessages)
        .set({ goneAt: new Date() })
        .where(and(eq(folderMessages.folderId, folder.id), isNull(folderMessages.goneAt)))
        .returning({ id: folderMessages.id });
      result.gone += stale.length;
      state = { ...state, uidNextSynced: null, backfillBelow: null, highestModseq: null };
    }

    // Primera vez: se anota desde dónde es «nuevo» y el histórico queda pendiente.
    if (state.uidNextSynced === null) {
      await db
        .update(folders)
        .set({
          uidValidity,
          uidNextSynced: uidNext,
          backfillBelow: uidNext,
          highestModseq: modseq,
          existsCount: mailbox.exists,
        })
        .where(eq(folders.id, folder.id));
      result.backfillPending = uidNext > 1;
      return result;
    }

    const loadedFrom = state.backfillBelow ?? 1;
    const unchanged =
      useCondstore &&
      modseq !== null &&
      state.highestModseq === modseq &&
      state.uidNextSynced === uidNext &&
      state.existsCount === mailbox.exists;

    if (!unchanged && mailbox.exists > 0) {
      // 1. Correos nuevos.
      if (uidNext > state.uidNextSynced) {
        const fetched = await client.fetchAll(`${state.uidNextSynced}:*`, ENVELOPE_QUERY, {
          uid: true,
        });
        const fresh = fromUid(fetched.map(toRemoteMessage), state.uidNextSynced);
        const ingested = await ingestMessages(db, folder, uidValidity, fresh, { emitEvents: true });
        result.created += ingested.created;
        result.attached += ingested.attached;
      }

      // 2. Cambios de marcas en lo ya cargado.
      const incremental = useCondstore && modseq !== null && state.highestModseq !== null;
      const remoteFlags = fromUid(
        await client.fetchAll(
          `${loadedFrom}:*`,
          { uid: true, flags: true },
          incremental ? { uid: true, changedSince: state.highestModseq! } : { uid: true },
        ),
        loadedFrom,
      );
      if (remoteFlags.length > 0) {
        const local = await db
          .select()
          .from(folderMessages)
          .where(
            and(
              eq(folderMessages.folderId, folder.id),
              eq(folderMessages.uidValidity, uidValidity),
              isNull(folderMessages.goneAt),
              inArray(
                folderMessages.uid,
                remoteFlags.map((message) => message.uid),
              ),
            ),
          );
        const byUid = new Map(local.map((row) => [row.uid, row]));
        for (const remote of remoteFlags) {
          const row = byUid.get(remote.uid);
          if (!row) continue;
          const flags = normalizeFlags(remote.flags);
          if (sameFlags(row.flags, flags)) continue;
          await db.transaction(async (tx) => {
            await tx
              .update(folderMessages)
              .set({ flags, modseq: remote.modseq ?? row.modseq })
              .where(eq(folderMessages.id, row.id));
            await tx.insert(events).values({
              accountId: account.id,
              type: "message.flagsChanged",
              messageId: row.messageId,
              payload: {
                folderId: folder.id,
                flags,
                added: flags.filter((flag) => !row.flags.includes(flag)),
                removed: row.flags.filter((flag) => !flags.includes(flag)),
              },
            });
          });
          result.flagsChanged++;
        }
      }
    }

    // 3. Correos que ya no están en la carpeta (movidos, borrados o purgados).
    if (!unchanged) {
      const remoteUids =
        mailbox.exists === 0
          ? []
          : (await client.search({ uid: `${loadedFrom}:*` }, { uid: true })) || [];
      const present = new Set(remoteUids);
      const live = await db
        .select({ id: folderMessages.id, uid: folderMessages.uid })
        .from(folderMessages)
        .where(
          and(
            eq(folderMessages.folderId, folder.id),
            isNull(folderMessages.goneAt),
            gte(folderMessages.uid, loadedFrom),
          ),
        );
      const missing = live.filter((row) => !present.has(row.uid)).map((row) => row.id);
      if (missing.length > 0) {
        // Se marcan, no se borran: si el correo reaparece en otra carpeta conserva su identidad.
        await db
          .update(folderMessages)
          .set({ goneAt: new Date() })
          .where(inArray(folderMessages.id, missing));
        result.gone += missing.length;
      }
    }

    await db
      .update(folders)
      .set({
        uidValidity,
        uidNextSynced: uidNext,
        highestModseq: modseq,
        existsCount: mailbox.exists,
      })
      .where(eq(folders.id, folder.id));
    result.backfillPending = loadedFrom > 1;
    return result;
  } finally {
    lock.release();
  }
}

/**
 * Carga una ventana más del histórico de la carpeta, de lo más reciente a lo más
 * antiguo. Devuelve si queda histórico por cargar. No emite eventos de correo nuevo.
 */
export async function backfillFolder(ctx: SyncContext, folderId: string): Promise<boolean> {
  const { db, client, options } = ctx;
  const [folder] = await db.select().from(folders).where(eq(folders.id, folderId));
  if (!folder || folder.uidValidity === null || folder.backfillBelow === null) return false;
  if (folder.backfillBelow <= 1) return false;

  const top = folder.backfillBelow - 1;

  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    if (!client.mailbox || Number(client.mailbox.uidValidity) !== folder.uidValidity) return true;

    // Se avanza por los correos que existen, no por rangos de numeración: en un buzón
    // con muchos correos borrados casi todos los números están vacíos.
    const older =
      client.mailbox.exists === 0
        ? []
        : (await client.search({ uid: `1:${top}` }, { uid: true })) || [];
    const window = older
      .filter((uid) => uid <= top)
      .sort((a, b) => b - a)
      .slice(0, options.windowSize);
    const bottom = window.at(-1);
    if (bottom === undefined) {
      await db.update(folders).set({ backfillBelow: 1 }).where(eq(folders.id, folder.id));
      return false;
    }

    const fetched = await client.fetchAll(`${bottom}:${top}`, ENVELOPE_QUERY, { uid: true });
    const remote = fetched
      .map(toRemoteMessage)
      .filter((message) => message.uid >= bottom && message.uid <= top)
      .sort((a, b) => b.uid - a.uid);
    await ingestMessages(db, folder, folder.uidValidity, remote, { emitEvents: false });

    const done = window.length < options.windowSize || bottom <= 1;
    await db
      .update(folders)
      .set({ backfillBelow: done ? 1 : bottom })
      .where(eq(folders.id, folder.id));
    return !done;
  } finally {
    lock.release();
  }
}
