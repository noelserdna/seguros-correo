import { describe, expect, it } from "vitest";
import { detectSpecialUse } from "./special-use.ts";

describe("detectSpecialUse", () => {
  it("reconoce la bandeja de entrada sin importar mayúsculas", () => {
    expect(detectSpecialUse({ path: "INBOX" })).toBe("inbox");
    expect(detectSpecialUse({ path: "Inbox" })).toBe("inbox");
  });

  it("da prioridad a lo que anuncia el servidor sobre el nombre", () => {
    expect(detectSpecialUse({ path: "Papelera", specialUse: "\\Sent" })).toBe("sent");
    expect(
      detectSpecialUse({ path: "Cosas", flags: new Set(["\\HasNoChildren", "\\Drafts"]) }),
    ).toBe("drafts");
  });

  it("usa el nombre como respaldo, en español e inglés", () => {
    expect(detectSpecialUse({ path: "Elementos enviados" })).toBe("sent");
    expect(detectSpecialUse({ path: "Sent Items" })).toBe("sent");
    expect(detectSpecialUse({ path: "Borradores" })).toBe("drafts");
    expect(detectSpecialUse({ path: "Deleted Items" })).toBe("trash");
    expect(detectSpecialUse({ path: "Correo no deseado" })).toBe("junk");
  });

  it("acepta carpetas colgadas de INBOX como primer nivel", () => {
    expect(detectSpecialUse({ path: "INBOX.Sent", delimiter: "." })).toBe("sent");
    expect(detectSpecialUse({ path: "INBOX/Drafts", delimiter: "/" })).toBe("drafts");
  });

  it("no confunde subcarpetas con las carpetas especiales del buzón", () => {
    expect(detectSpecialUse({ path: "Clientes/Enviados", delimiter: "/" })).toBeNull();
    expect(detectSpecialUse({ path: "Siniestros.2026.Sent", delimiter: "." })).toBeNull();
  });

  it("devuelve null para carpetas corrientes", () => {
    expect(detectSpecialUse({ path: "Siniestros" })).toBeNull();
  });
});
