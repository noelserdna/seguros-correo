import { loadConfig, requireMasterKey, type Config } from "./config.ts";
import { SecretBox } from "./crypto/secrets.ts";
import { openDb, runMigrations, type Db } from "./db/client.ts";
import { RawStore } from "./storage/raw-store.ts";
import type { SyncDeps } from "./sync/cycle.ts";

export type Runtime = SyncDeps & { db: Db; config: Config; close: () => Promise<void> };

/** Carga la configuración (.env si existe), abre la base y aplica las migraciones. */
export async function openRuntime(): Promise<Runtime> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Sin fichero .env: solo variables de entorno.
  }
  const config = loadConfig();
  const secrets = new SecretBox(requireMasterKey(config));
  const { db, close } = openDb(config.DATABASE_URL);
  await runMigrations(db);
  return { db, secrets, config, rawStore: new RawStore(config.DATA_DIR), close };
}
