import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.ts";

describe("contraseñas", () => {
  it("verifica la contraseña correcta y rechaza la incorrecta", async () => {
    const stored = await hashPassword("una contraseña larga");
    expect(await verifyPassword("una contraseña larga", stored)).toBe(true);
    expect(await verifyPassword("otra contraseña", stored)).toBe(false);
  });

  it("no guarda la contraseña y usa una sal distinta cada vez", async () => {
    const first = await hashPassword("secreta-1234");
    const second = await hashPassword("secreta-1234");
    expect(first).not.toContain("secreta-1234");
    expect(first).not.toBe(second);
  });

  it("rechaza un valor guardado con formato desconocido", async () => {
    expect(await verifyPassword("x", "texto-plano")).toBe(false);
  });
});
