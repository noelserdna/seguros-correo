/** Servicio: API HTTP y sincronización en vivo de todos los buzones dados de alta. */
import { buildApp } from "./http/app.ts";
import { openRuntime } from "./runtime.ts";
import { SyncService } from "./sync/service.ts";

const runtime = await openRuntime();
const sync = new SyncService(runtime);

const app = await buildApp({
  db: runtime.db,
  secrets: runtime.secrets,
  rawStore: runtime.rawStore,
  cookieSecure: runtime.config.COOKIE_SECURE,
  onAccountCreated: (account) => sync.start(account),
});
await app.listen({ host: runtime.config.HOST, port: runtime.config.PORT });
console.log(`API en http://${runtime.config.HOST}:${runtime.config.PORT}`);

if ((await sync.startAll()) === 0) {
  console.log("No hay buzones dados de alta. Usa `pnpm cuenta alta`.");
}

const shutdown = () => {
  void app
    .close()
    .then(() => sync.stopAll())
    .then(() => runtime.close())
    .finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
