import { eq } from "drizzle-orm";
import type { SecretBox } from "../crypto/secrets.ts";
import type { Db } from "../db/client.ts";
import { accounts } from "../db/schema.ts";
import { errorMessage, imapClientFor, isAuthError, type Account } from "../imap/connection.ts";
import type { RawStore } from "../storage/raw-store.ts";
import { downloadBodies } from "./bodies.ts";
import { backfillFolder, syncFolder } from "./folder-sync.ts";
import { syncFolderList } from "./folders.ts";
import { reapDeleted } from "./reaper.ts";
import { DEFAULT_SYNC_OPTIONS, type SyncContext, type SyncOptions } from "./types.ts";

export type SyncDeps = { db: Db; secrets: SecretBox; rawStore: RawStore };

export type CycleResult = {
  created: number;
  attached: number;
  flagsChanged: number;
  gone: number;
  bodies: number;
  deleted: number;
  /** Queda histórico o cuerpos por bajar: conviene lanzar otro ciclo enseguida. */
  pending: boolean;
};

/**
 * Un ciclo completo de sincronización de un buzón, con una sola conexión que se
 * cierra al terminar: carpetas, novedades de cada una, una ventana de histórico,
 * un lote de cuerpos y limpieza de borrados.
 */
export async function runSyncCycle(
  deps: SyncDeps,
  account: Account,
  options: Partial<SyncOptions> = {},
): Promise<CycleResult> {
  const result: CycleResult = {
    created: 0,
    attached: 0,
    flagsChanged: 0,
    gone: 0,
    bodies: 0,
    deleted: 0,
    pending: false,
  };
  const client = imapClientFor(account, deps.secrets);
  // Sin esto, un corte de red durante el ciclo tumbaría el proceso.
  client.on("error", () => undefined);

  try {
    await client.connect();
    const ctx: SyncContext = {
      db: deps.db,
      client,
      account,
      rawStore: deps.rawStore,
      options: { ...DEFAULT_SYNC_OPTIONS, ...options },
    };

    const folderList = await syncFolderList(ctx);
    const backfill: string[] = [];
    for (const folder of folderList) {
      const synced = await syncFolder(ctx, folder);
      result.created += synced.created;
      result.attached += synced.attached;
      result.flagsChanged += synced.flagsChanged;
      result.gone += synced.gone;
      if (synced.backfillPending) backfill.push(folder.id);
    }
    for (const folderId of backfill) {
      if (await backfillFolder(ctx, folderId)) result.pending = true;
    }

    result.bodies = await downloadBodies(ctx);
    if (result.bodies >= ctx.options.bodyBatch) result.pending = true;
    result.deleted = await reapDeleted(deps.db, account.id, ctx.options.deleteGraceMs);

    await deps.db
      .update(accounts)
      .set({ state: "ok", lastError: null, lastSyncAt: new Date() })
      .where(eq(accounts.id, account.id));
    return result;
  } catch (error) {
    await deps.db
      .update(accounts)
      .set({ state: isAuthError(error) ? "auth_error" : "offline", lastError: errorMessage(error) })
      .where(eq(accounts.id, account.id));
    throw error;
  } finally {
    await client.logout().catch(() => undefined);
  }
}
