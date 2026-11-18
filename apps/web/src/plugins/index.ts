import { demoPlugin } from "./demo.tsx";
import type { WebPlugin } from "./types.ts";

/** Plugins activos en la interfaz. El orden es fijo: decide el de sus entradas y etiquetas. */
export const plugins: WebPlugin[] = [demoPlugin];

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
