/**
 * Servicio de sincronización: mantiene al día todos los buzones dados de alta.
 * (La API HTTP se añade en la Fase 3.)
 */
import { accounts } from "./db/schema.ts";
import { errorMessage } from "./imap/connection.ts";
import { openRuntime } from "./runtime.ts";
import { AccountSupervisor } from "./sync/supervisor.ts";

const now = () => new Date().toLocaleTimeString("es-ES", { hour12: false });

const runtime = await openRuntime();
const rows = await runtime.db.select().from(accounts);
if (rows.length === 0) {
  console.log("No hay buzones dados de alta. Usa `pnpm cuenta alta`.");
}

const supervisors = rows.map((account) => {
  const supervisor = new AccountSupervisor(runtime, account, {
    onCycle: (result) => {
      const { pending, ...counts } = result;
      const changes = Object.entries(counts)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `${key}=${value}`);
      if (changes.length > 0 || pending) {
        console.log(
          `${now()}  ${account.email}  ${changes.join(" ") || "sin cambios"}${pending ? "  (sigue)" : ""}`,
        );
      }
    },
    onError: (error) => console.error(`${now()}  ${account.email}  ERROR: ${errorMessage(error)}`),
  });
  supervisor.start();
  console.log(`${now()}  ${account.email}  sincronizando`);
  return supervisor;
});

const shutdown = () => {
  void Promise.all(supervisors.map((supervisor) => supervisor.stop()))
    .then(() => runtime.close())
    .finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
