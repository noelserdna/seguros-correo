import { and, eq, isNull } from "drizzle-orm";
import type { SecretBox } from "../crypto/secrets.ts";
import type { Db } from "../db/client.ts";
import { accounts, events, folders } from "../db/schema.ts";
import { runPendingActions } from "../actions/execute.ts";
import { runOutbox } from "../outbound/outbox.ts";
import { resolveAuth } from "../accounts/auth.ts";
import { errorMessage, imapClient, isAuthError, type Account } from "../imap/connection.ts";
import type { OAuthSettings } from "../oauth/providers.ts";
import type { RawStore } from "../storage/raw-store.ts";
import { downloadBodies } from "./bodies.ts";
import { backfillFolder, syncFolder } from "./folder-sync.ts";
import { syncFolderList } from "./folders.ts";
import { markRemoved } from "./removed.ts";
import { DEFAULT_SYNC_OPTIONS, type SyncContext, type SyncOptions } from "./types.ts";

const countFolders = async (db: Db, accountId: string) =>
  (
    await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.accountId, accountId), isNull(folders.goneAt)))
  ).length;

export type SyncDeps = { db: Db; secrets: SecretBox; rawStore: RawStore; oauth?: OAuthSettings };

export type CycleResult = {
  /** Acciones de la cola atendidas (hechas o rechazadas). */
  actions: number;
  /** Correos enviados, envíos fallidos y borradores llevados al servidor. */
  sent: number;
  sendFailed: number;
  drafts: number;
  created: number;
  attached: number;
  flagsChanged: number;
  gone: number;
  bodies: number;
  removed: number;
  /** Queda histórico o cuerpos por bajar: conviene lanzar otro ciclo enseguida. */
  pending: boolean;
};

/**
 * Un ciclo completo de sincronización de un buzón, con una sola conexión que se
 * cierra al terminar: carpetas, novedades de cada una, una ventana de histórico,
 * un lote de cuerpos y anotación de los retirados del buzón.
 */
export async function runSyncCycle(
  deps: SyncDeps,
  account: Account,
  options: Partial<SyncOptions> = {},
): Promise<CycleResult> {
  const result: CycleResult = {
    actions: 0,
    sent: 0,
    sendFailed: 0,
    drafts: 0,
    created: 0,
    attached: 0,
    flagsChanged: 0,
    gone: 0,
    bodies: 0,
    removed: 0,
    pending: false,
  };
  let client: ReturnType<typeof imapClient> | null = null;

  try {
    const auth = await resolveAuth(deps, account);
    client = imapClient(account, auth);
    // Sin esto, un corte de red durante el ciclo tumbaría el proceso.
    client.on("error", () => undefined);
    await client.connect();
    const ctx: SyncContext = {
      db: deps.db,
      client,
      account,
      rawStore: deps.rawStore,
      options: { ...DEFAULT_SYNC_OPTIONS, ...options },
    };

    // Primero lo que ha pedido el usuario: la sincronización que sigue ya ve el resultado.
    const outbox = await runOutbox(ctx, auth);
    result.sent = outbox.sent;
    result.sendFailed = outbox.failed;
    result.drafts = outbox.drafts;
    result.actions = await runPendingActions(ctx);

    const foldersBefore = await countFolders(deps.db, account.id);
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
    result.removed = await markRemoved(deps.db, account.id, ctx.options.removalGraceMs);

    const [before] = await deps.db
      .select({ state: accounts.state })
      .from(accounts)
      .where(eq(accounts.id, account.id));
    await deps.db
      .update(accounts)
      .set({ state: "ok", lastError: null, lastSyncAt: new Date() })
      .where(eq(accounts.id, account.id));

    // Aviso para las pantallas abiertas. La carga del histórico y los cambios de carpetas
    // no generan eventos de correo, y sin esto un buzón recién conectado no aparecería
    // hasta recargar la página.
    const { pending, ...counts } = result;
    const changed =
      pending ||
      before?.state !== "ok" ||
      foldersBefore !== (await countFolders(deps.db, account.id)) ||
      Object.values(counts).some((count) => count > 0);
    if (changed) {
      await deps.db.insert(events).values({ accountId: account.id, type: "account.changed" });
    }
    return result;
  } catch (error) {
    await deps.db
      .update(accounts)
      .set({ state: isAuthError(error) ? "auth_error" : "offline", lastError: errorMessage(error) })
      .where(eq(accounts.id, account.id));
    throw error;
  } finally {
    await client?.logout().catch(() => undefined);
  }
}
