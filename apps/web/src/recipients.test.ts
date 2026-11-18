import { describe, expect, it } from "vitest";
import { formatRecipients, parseRecipients } from "./recipients.ts";

describe("destinatarios", () => {
  it("lee direcciones sueltas y con nombre, con cualquier separador", () => {
    const { list, invalid } = parseRecipients(
      `ana@correo.test; Luis Gil <luis@correo.test>,\n"Albor, S.A." <t@albor.test>`,
    );
    expect(invalid).toEqual([]);
    expect(list).toEqual([
      { name: "", address: "ana@correo.test" },
      { name: "Luis Gil", address: "luis@correo.test" },
      { name: "Albor, S.A.", address: "t@albor.test" },
    ]);
  });

  it("aparta lo que no es una dirección y no repite destinatarios", () => {
    const { list, invalid } = parseRecipients("ana@correo.test, pepe, ANA@correo.test, a@b");
    expect(list).toEqual([{ name: "", address: "ana@correo.test" }]);
    expect(invalid).toEqual(["pepe", "a@b"]);
  });

  it("escribe los destinatarios como se leen", () => {
    const list = [
      { name: "Luis Gil", address: "luis@correo.test" },
      { name: "", address: "ana@correo.test" },
      { name: "Albor, S.A.", address: "t@albor.test" },
    ];
    expect(formatRecipients(list)).toBe(
      'Luis Gil <luis@correo.test>, ana@correo.test, "Albor, S.A." <t@albor.test>',
    );
    expect(parseRecipients(formatRecipients(list)).list).toEqual(list);
  });
});
