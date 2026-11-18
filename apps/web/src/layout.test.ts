import { describe, expect, it } from "vitest";
import { layoutFor } from "./layout.ts";

describe("disposición según el ancho", () => {
  it("teléfono por debajo de 768 px", () => {
    expect(layoutFor(390)).toBe("phone");
    expect(layoutFor(767)).toBe("phone");
  });
  it("tableta hasta 1279 px: las carpetas se pliegan", () => {
    expect(layoutFor(768)).toBe("tablet");
    expect(layoutFor(1024)).toBe("tablet");
    expect(layoutFor(1279)).toBe("tablet");
  });
  it("escritorio desde 1280 px, que incluye la pantalla de referencia de 1366", () => {
    expect(layoutFor(1280)).toBe("desktop");
    expect(layoutFor(1366)).toBe("desktop");
  });
});
