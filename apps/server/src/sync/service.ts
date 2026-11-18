import { accounts } from "../db/schema.ts";
import { errorMessage, type Account } from "../imap/connection.ts";
import type { SyncDeps } from "./cycle.ts";
import { AccountSupervisor } from "./supervisor.ts";

const now = () => new Date().toLocaleTimeString("es-ES", { hour12: false });

/** Mantiene un supervisor por buzón y permite añadir buzones en caliente. */
export class SyncService {
  readonly #deps: SyncDeps;
  readonly #supervisors = new Map<string, AccountSupervisor>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(deps: SyncDeps) {
    this.#deps = deps;
  }

  async startAll(): Promise<number> {
    const rows = await this.#deps.db.select().from(accounts);
    for (const account of rows) this.start(account);
    return rows.length;
  }

  start(account: Account): void {
    // Un buzón que se vuelve a conectar (permiso renovado) arranca de nuevo con lo último.
    const previous = this.#supervisors.get(account.id);
    if (previous) void previous.stop();
    const supervisor = new AccountSupervisor(this.#deps, account, {
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
      onError: (error) =>
        console.error(`${now()}  ${account.email}  ERROR: ${errorMessage(error)}`),
    });
    this.#supervisors.set(account.id, supervisor);
    supervisor.start();
    console.log(`${now()}  ${account.email}  sincronizando`);
  }

  /** Pide un ciclo cuanto antes para un buzón (hay acciones en cola). */
  nudge(accountId: string): void {
    this.#supervisors.get(accountId)?.nudge();
  }

  /** Pide un ciclo pasado un tiempo (por ejemplo, al acabar el margen para deshacer un envío). */
  nudgeIn(accountId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.nudge(accountId);
    }, delayMs);
    this.#timers.add(timer);
  }

  async stopAll(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    await Promise.all([...this.#supervisors.values()].map((supervisor) => supervisor.stop()));
    this.#supervisors.clear();
  }
}
