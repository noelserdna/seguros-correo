import { expedientesPlugin } from "./expedientes.tsx";
import { visionPlugin } from "./vision.tsx";
import { tramitacionPlugin } from "./tramitacion/index.tsx";
import type { WebPlugin } from "./types.ts";

/** Todos los módulos que esta interfaz sabe mostrar. El orden decide el de sus entradas. */
const known: WebPlugin[] = [expedientesPlugin, tramitacionPlugin, visionPlugin];

/**
 * Módulos activos. El servidor dice cuáles tiene cargados al abrir la sesión; hasta
 * entonces no hay ninguno. La lista no cambia mientras la aplicación está abierta.
 */
export const plugins: WebPlugin[] = [];

export function setActivePlugins(ids: string[]): void {
  plugins.splice(0, plugins.length, ...known.filter((plugin) => ids.includes(plugin.id)));
}

/** Etiquetas de todos los plugins para los correos visibles. */
export function usePluginLabels(messageIds: string[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  // La lista de plugins no cambia mientras la aplicación está abierta, así que el orden
  // de estas llamadas es siempre el mismo.
  for (const plugin of plugins) {
    const labels = plugin.useLabels?.(messageIds);
    labels?.forEach((texts, id) => merged.set(id, [...(merged.get(id) ?? []), ...texts]));
  }
  return merged;
}
