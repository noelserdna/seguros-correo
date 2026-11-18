/** Servicio: API HTTP y sincronización en vivo de todos los buzones dados de alta. */
import { fileURLToPath } from "node:url";
import { ExtractionWorker } from "./documents/worker.ts";
import { buildApp } from "./http/app.ts";
import { expedientesPlugin } from "./plugins/expedientes/index.ts";
import { PluginHost, type ServerPlugin } from "./plugins/host.ts";
import { ocrPlugin } from "./plugins/ocr/index.ts";
import { visionPlugin } from "./plugins/vision/index.ts";
import { openRuntime } from "./runtime.ts";
import { SyncService } from "./sync/service.ts";

const runtime = await openRuntime();
const sync = new SyncService(runtime);

const available: Record<string, ServerPlugin> = {
  expedientes: expedientesPlugin,
  ocr: ocrPlugin,
  vision: visionPlugin,
};
const plugins = runtime.config.PLUGINS.split(",")
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => {
    const plugin = available[id];
    if (!plugin) throw new Error(`PLUGINS nombra un módulo que no existe: «${id}».`);
    return plugin;
  });
console.log(`Módulos: ${plugins.map((plugin) => plugin.id).join(", ") || "ninguno"}`);
const pluginHost = new PluginHost(runtime.db, plugins, runtime.rawStore, runtime.config);
await pluginHost.setup();
pluginHost.start();

const documents = new ExtractionWorker(runtime.db, runtime.rawStore);
documents.start();

const app = await buildApp({
  plugins,
  config: runtime.config,
  availablePlugins: Object.values(available),
  db: runtime.db,
  secrets: runtime.secrets,
  rawStore: runtime.rawStore,
  oauth: runtime.oauth,
  webDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  cookieSecure: runtime.config.COOKIE_SECURE,
  onAccountCreated: (account) => sync.start(account),
  onActionQueued: (accountId) => sync.nudge(accountId),
  onOutboundChanged: (accountId, delayMs) => sync.nudgeIn(accountId, delayMs),
});
await app.listen({ host: runtime.config.HOST, port: runtime.config.PORT });
console.log(`API en http://${runtime.config.HOST}:${runtime.config.PORT}`);

if ((await sync.startAll()) === 0) {
  console.log("No hay buzones dados de alta. Usa `pnpm cuenta alta`.");
}

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  // Si algo impide un cierre limpio, se sale igualmente: un servidor a medio apagar
  // seguiría sincronizando por detrás junto al nuevo.
  setTimeout(() => process.exit(0), 5000).unref();
  pluginHost.stop();
  documents.stop();
  void app
    .close()
    .then(() => sync.stopAll())
    .then(() => runtime.close())
    .finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
