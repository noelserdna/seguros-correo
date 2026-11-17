import { describe, expect, it } from "vitest";
import type { Folder } from "./api.ts";
import { folderName, folderRows, folderTrail } from "./folders.ts";

const folder = (path: string, specialUse: string | null = null, delimiter = "/"): Folder => ({
  id: path,
  path,
  delimiter,
  specialUse,
  historyPending: false,
  total: 0,
  unread: 0,
});

describe("carpetas", () => {
  it("traduce las carpetas especiales y deja el resto con su nombre", () => {
    expect(folderName(folder("INBOX", "inbox"))).toBe("Entrada");
    expect(folderName(folder("Sent Items", "sent"))).toBe("Enviados");
    expect(folderName(folder("Siniestros/2026"))).toBe("2026");
  });

  it("muestra la ruta de forma legible", () => {
    expect(folderTrail("Siniestros/2024")).toBe("Siniestros / 2024");
    expect(folderTrail("INBOX.Clientes", ".")).toBe("Entrada / Clientes");
  });

  it("ordena como un árbol: especiales primero y subcarpetas bajo su madre", () => {
    const rows = folderRows([
      folder("Trash", "trash"),
      folder("Siniestros/2026"),
      folder("Zeta"),
      folder("Siniestros"),
      folder("INBOX", "inbox"),
      folder("Siniestros/2025"),
      folder("Sent", "sent"),
      folder("Árbol"),
    ]);
    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.name}`)).toEqual([
      "Entrada",
      "Enviados",
      "Papelera",
      "Árbol",
      "Siniestros",
      "  2025",
      "  2026",
      "Zeta",
    ]);
  });

  it("no pierde una subcarpeta cuya madre no se puede abrir", () => {
    const rows = folderRows([folder("Clientes/Activos"), folder("INBOX", "inbox")]);
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ["Entrada", 0],
      ["Activos", 0],
    ]);
  });

  it("trata las carpetas colgadas de INBOX como de primer nivel", () => {
    const rows = folderRows([folder("INBOX", "inbox", "."), folder("INBOX.Sent", "sent", ".")]);
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ["Entrada", 0],
      ["Enviados", 0],
    ]);
  });
});

describe("ubicación y conversación", () => {
  it("nombra la carpeta por su papel antes que por su ruta", async () => {
    const { locationName } = await import("./folders.ts");
    expect(locationName("Sent", "sent")).toBe("Enviados");
    expect(locationName("Siniestros/2024", null)).toBe("Siniestros / 2024");
  });

  it("deja un mensaje por Message-ID y conserva el que está abierto", async () => {
    const { uniqueByHeader } = await import("./folders.ts");
    const list = [
      { id: "enviado", messageIdHeader: "<a@x>" },
      { id: "recibido", messageIdHeader: "<a@x>" },
      { id: "otro", messageIdHeader: "<b@x>" },
      { id: "sin-cabecera-1", messageIdHeader: null },
      { id: "sin-cabecera-2", messageIdHeader: null },
    ];
    expect(uniqueByHeader(list, null).map((m) => m.id)).toEqual([
      "enviado",
      "otro",
      "sin-cabecera-1",
      "sin-cabecera-2",
    ]);
    expect(uniqueByHeader(list, "recibido").map((m) => m.id)[0]).toBe("recibido");
  });
});
