import { describe, expect, it } from "vitest";
import { fingerprint, parseMessageIds } from "./fingerprint.ts";

const base = {
  messageIdHeader: "<abc@ejemplo.com>",
  internalDate: new Date("2026-11-17T12:00:00Z"),
  size: 2048,
  subject: "Siniestro 142",
  fromAddress: "Ana@Ejemplo.com",
};

describe("fingerprint", () => {
  it("es estable y no distingue mayúsculas en el remitente", () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base, fromAddress: "ana@ejemplo.com" }));
  });

  it("distingue dos correos con el mismo Message-ID pero distinta llegada o tamaño", () => {
    const later = { ...base, internalDate: new Date("2026-11-17T12:00:05Z") };
    expect(fingerprint(base)).not.toBe(fingerprint(later));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, size: 2049 }));
  });

  it("funciona sin Message-ID", () => {
    const without = { ...base, messageIdHeader: null };
    expect(fingerprint(without)).toBe(fingerprint({ ...without }));
    expect(fingerprint(without)).not.toBe(fingerprint(base));
  });
});

describe("parseMessageIds", () => {
  it("extrae los identificadores, sin duplicados y aunque haya saltos de línea", () => {
    expect(parseMessageIds("<a@x> <b@y>\r\n <a@x>")).toEqual(["<a@x>", "<b@y>"]);
  });

  it("devuelve una lista vacía si no hay nada", () => {
    expect(parseMessageIds(null)).toEqual([]);
    expect(parseMessageIds("sin identificadores")).toEqual([]);
  });
});
