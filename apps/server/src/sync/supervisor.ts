import type { ImapFlow } from "imapflow";
import { resolveAuth } from "../accounts/auth.ts";
import { imapClient, isAuthError, type Account } from "../imap/connection.ts";
import { runSyncCycle, type CycleResult, type SyncDeps } from "./cycle.ts";
import type { SyncOptions } from "./types.ts";

export type SupervisorOptions = Partial<SyncOptions> & {
  /** Cada cuánto se repasa el buzón aunque no haya aviso del servidor. */
  pollIntervalMs?: number;
  /** Espera inicial tras un fallo; se dobla en cada fallo seguido. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  onCycle?: (result: CycleResult) => void;
  onError?: (error: unknown) => void;
};

/**
 * Mantiene al día un buzón con dos conexiones como máximo: una que escucha la
 * Entrada (IDLE) y avisa al instante, y otra de trabajo que solo vive lo que dura
 * cada ciclo. Los ciclos nunca se solapan.
 */
export class AccountSupervisor {
  readonly #deps: SyncDeps;
  readonly #account: Account;
  readonly #options: SupervisorOptions;
  #stopped = true;
  #wake: (() => void) | null = null;
  #nudged = false;
  #listener: ImapFlow | null = null;
  #loops: Promise<void>[] = [];

  constructor(deps: SyncDeps, account: Account, options: SupervisorOptions = {}) {
    this.#deps = deps;
    this.#account = account;
    this.#options = options;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#loops = [this.#workLoop(), this.#listenLoop()];
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    this.#listener?.close();
    await Promise.allSettled(this.#loops);
  }

  /** Pide un ciclo cuanto antes (por ejemplo, tras un aviso del servidor). */
  nudge(): void {
    this.#nudged = true;
    this.#wake?.();
  }

  async #sleep(ms: number): Promise<void> {
    if (this.#stopped || this.#nudged) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.#wake = null;
  }

  async #workLoop(): Promise<void> {
    const { pollIntervalMs = 60_000, retryBaseMs = 2_000, retryMaxMs = 5 * 60_000 } = this.#options;
    let failures = 0;
    while (!this.#stopped) {
      this.#nudged = false;
      try {
        const result = await runSyncCycle(this.#deps, this.#account, this.#options);
        failures = 0;
        this.#options.onCycle?.(result);
        if (result.pending) continue;
        await this.#sleep(pollIntervalMs);
      } catch (error) {
        this.#options.onError?.(error);
        // Con credenciales malas no sirve reintentar: se para hasta que las cambien.
        if (isAuthError(error)) return;
        failures++;
        this.#nudged = false;
        await this.#sleep(Math.min(retryBaseMs * 2 ** (failures - 1), retryMaxMs));
      }
    }
  }

  async #listenLoop(): Promise<void> {
    const { retryBaseMs = 2_000, retryMaxMs = 5 * 60_000 } = this.#options;
    let failures = 0;
    while (!this.#stopped) {
      let client: ReturnType<typeof imapClient> | null = null;
      try {
        client = imapClient(this.#account, await resolveAuth(this.#deps, this.#account));
        this.#listener = client;
        const nudge = () => this.nudge();
        client.on("exists", nudge);
        client.on("expunge", nudge);
        client.on("flags", nudge);
        client.on("error", () => undefined);
        await client.connect();
        await client.mailboxOpen("INBOX", { readOnly: true });
        failures = 0;
        while (!this.#stopped && client.usable) await client.idle();
      } catch (error) {
        if (this.#stopped) break;
        if (isAuthError(error)) return;
        failures++;
      } finally {
        client?.close();
        this.#listener = null;
      }
      if (this.#stopped) break;
      // Reconexión con espera creciente; mientras tanto el sondeo sigue funcionando.
      const wait = Math.min(retryBaseMs * 2 ** Math.max(failures - 1, 0), retryMaxMs);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
