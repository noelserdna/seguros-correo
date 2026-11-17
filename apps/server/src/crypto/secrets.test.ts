import { describe, expect, it } from "vitest";
import { SecretBox } from "./secrets.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("SecretBox", () => {
  it("descifra lo que cifra", () => {
    const box = new SecretBox(KEY);
    const sealed = box.encrypt("contraseña con ñ, # y :");
    expect(box.decrypt(sealed)).toBe("contraseña con ñ, # y :");
  });

  it("no deja el texto en claro ni repite el resultado", () => {
    const box = new SecretBox(KEY);
    const first = box.encrypt("secreto-123");
    const second = box.encrypt("secreto-123");
    expect(first).not.toContain("secreto-123");
    expect(first).not.toBe(second);
  });

  it("rechaza un secreto manipulado o cifrado con otra clave", () => {
    const sealed = new SecretBox(KEY).encrypt("secreto");
    const tampered = sealed.slice(0, -4) + "AAAA";
    expect(() => new SecretBox(KEY).decrypt(tampered)).toThrow();
    expect(() => new SecretBox(KEY.replace("0", "1")).decrypt(sealed)).toThrow();
  });

  it("exige una clave de 32 bytes en hexadecimal", () => {
    expect(() => new SecretBox("corta")).toThrow(/MASTER_KEY/);
  });
});
