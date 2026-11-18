import { describe, expect, it } from "vitest";
import { orderPlugins, PluginDependencyError, type ServerPlugin } from "./host.ts";

const plugin = (id: string, requires?: string[]): ServerPlugin => ({ id, requires });

describe("orden de los módulos", () => {
  it("pone cada módulo detrás de los que necesita", () => {
    const ordered = orderPlugins([
      plugin("tramitacion", ["expedientes"]),
      plugin("ocr"),
      plugin("expedientes"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["expedientes", "tramitacion", "ocr"]);
  });

  it("si falta uno que se necesita, lo dice claro", () => {
    expect(() => orderPlugins([plugin("tramitacion", ["expedientes"])])).toThrow(
      new PluginDependencyError("«tramitacion» necesita «expedientes»: añádelo a PLUGINS."),
    );
  });

  it("rechaza dependencias en círculo", () => {
    expect(() => orderPlugins([plugin("a", ["b"]), plugin("b", ["a"])])).toThrow(
      PluginDependencyError,
    );
  });
});
