import { asc, eq, gt } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../db/client.ts";
import { eventCursors, events } from "../db/schema.ts";
import type { RouteOptions } from "../http/app.ts";
import type { RawStore } from "../storage/raw-store.ts";
import type { Config } from "../config.ts";

export type MailEvent = typeof events.$inferSelect;

/**
 * Lo que un plugin puede aportar en el servidor. Todo es opcional salvo el nombre:
 * tablas propias, rutas bajo `/api/plugins/<id>` y reacción a lo que pasa en el correo.
 */
export type ServerPlugin = {
  id: string;
  /** Otros módulos que tienen que estar activos para que este funcione. */
  requires?: string[];
  /** Cómo se llama y para qué sirve, en palabras: se enseña en Configuración. */
  name?: string;
  description?: string;
  /** Crea sus tablas si no existen. Se llama en cada arranque. */
  setup?: (db: Db) => Promise<void>;
  routes?: FastifyPluginAsync<RouteOptions>;
  /** Recibe cada evento una vez, en orden. Puede recibirlo de nuevo si falló a medias. */
  onEvent?: (event: MailEvent, db: Db) => Promise<void>;
  /** Trabajo propio en segundo plano (una cola, un temporizador). Se para al cerrar. */
  start?: (services: PluginServices) => void;
  stop?: () => Promise<void> | void;
};

/** Lo que el núcleo pone a disposición de un plugin que trabaja por su cuenta. */
export type PluginServices = { db: Db; rawStore: RawStore; config: Config };

const BATCH = 200;

/** Falta un módulo que otro necesita: el servidor no arranca y dice cuál. */
export class PluginDependencyError extends Error {}

/**
 * Ordena los módulos para que cada uno vaya detrás de los que necesita: así sus tablas
 * existen antes y recibe los eventos después. Comprueba que estén todos.
 */
export function orderPlugins(plugins: ServerPlugin[]): ServerPlugin[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  for (const plugin of plugins) {
    for (const needed of plugin.requires ?? []) {
      if (!byId.has(needed)) {
        throw new PluginDependencyError(`«${plugin.id}» necesita «${needed}»: añádelo a PLUGINS.`);
      }
    }
  }
  const ordered: ServerPlugin[] = [];
  const visiting = new Set<string>();
  const visit = (plugin: ServerPlugin) => {
    if (ordered.includes(plugin)) return;
    if (visiting.has(plugin.id)) {
      throw new PluginDependencyError(
        `Los módulos se necesitan entre sí en círculo: ${plugin.id}.`,
      );
    }
    visiting.add(plugin.id);
    for (const needed of plugin.requires ?? []) visit(byId.get(needed)!);
    visiting.delete(plugin.id);
    ordered.push(plugin);
  };
  for (const plugin of plugins) visit(plugin);
  return ordered;
}

/**
 * Reparte los eventos del correo entre los plugins. Cada plugin tiene su propio
 * marcador de por dónde va, guardado en la base: si el servidor se para, al volver
 * sigue donde lo dejó y no se pierde ningún evento.
 */
export class PluginHost {
  readonly #db: Db;
  readonly #plugins: ServerPlugin[];
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  readonly #rawStore: RawStore | undefined;
  readonly #config: Config | undefined;

  constructor(db: Db, plugins: ServerPlugin[], rawStore?: RawStore, config?: Config) {
    this.#db = db;
    this.#plugins = plugins;
    this.#rawStore = rawStore;
    this.#config = config;
  }

  async setup(): Promise<void> {
    for (const plugin of this.#plugins) {
      await plugin.setup?.(this.#db);
      await this.#db
        .insert(eventCursors)
        .values({ consumer: `plugin:${plugin.id}` })
        .onConflictDoNothing();
    }
  }

  /** Entrega a cada plugin los eventos que le faltan. Devuelve cuántos ha entregado. */
  async drain(): Promise<number> {
    let delivered = 0;
    for (const plugin of this.#plugins) {
      if (!plugin.onEvent) continue;
      const consumer = `plugin:${plugin.id}`;
      for (;;) {
        const [cursor] = await this.#db
          .select()
          .from(eventCursors)
          .where(eq(eventCursors.consumer, consumer));
        const pending = await this.#db
          .select()
          .from(events)
          .where(gt(events.id, cursor?.lastEventId ?? 0))
          .orderBy(asc(events.id))
          .limit(BATCH);
        if (pending.length === 0) break;
        for (const event of pending) {
          try {
            await plugin.onEvent(event, this.#db);
          } catch (error) {
            // Un evento que un plugin no sabe tratar no debe atascar los siguientes.
            console.error(`Plugin ${plugin.id}: fallo con el evento ${event.id}`, error);
          }
          await this.#db
            .update(eventCursors)
            .set({ lastEventId: event.id })
            .where(eq(eventCursors.consumer, consumer));
          delivered++;
        }
      }
    }
    return delivered;
  }

  start(intervalMs = 1500): void {
    if (this.#timer) return;
    if (this.#rawStore && this.#config) {
      for (const plugin of this.#plugins) {
        plugin.start?.({ db: this.#db, rawStore: this.#rawStore, config: this.#config });
      }
    }
    this.#timer = setInterval(() => {
      if (this.#busy) return;
      this.#busy = true;
      void this.drain()
        .catch((error: unknown) => console.error("Plugins: fallo al repartir eventos", error))
        .finally(() => {
          this.#busy = false;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const plugin of this.#plugins) void plugin.stop?.();
  }
}
