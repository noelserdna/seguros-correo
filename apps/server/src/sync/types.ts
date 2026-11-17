import type { ImapFlow } from "imapflow";
import type { Db } from "../db/client.ts";
import type { folders } from "../db/schema.ts";
import type { Account } from "../imap/connection.ts";
import type { RawStore } from "../storage/raw-store.ts";

export type Folder = typeof folders.$inferSelect;

export type SyncOptions = {
  /** Usar CONDSTORE para pedir solo lo que ha cambiado. Por defecto, si el servidor lo anuncia. */
  useCondstore?: boolean;
  /** Correos por ventana al cargar el histórico. */
  windowSize: number;
  /** Cuerpos que se descargan por ciclo. */
  bodyBatch: number;
  /** Tiempo que un correo sin ninguna copia viva espera antes de anotarse como retirado del buzón. */
  removalGraceMs: number;
};

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  windowSize: 500,
  bodyBatch: 50,
  removalGraceMs: 10 * 60_000,
};

export type SyncContext = {
  db: Db;
  client: ImapFlow;
  account: Account;
  rawStore: RawStore;
  options: SyncOptions;
};
