import { describe, expect, it } from "vitest";
import {
  dateGroup,
  fileKind,
  formatAgo,
  formatFullDate,
  formatListDate,
  formatSize,
  initials,
} from "./format.ts";

// Martes 17 de noviembre de 2026, 12:00.
const NOW = new Date(2026, 10, 17, 12, 0);
const at = (year: number, month: number, day: number, hour = 9, minute = 5) =>
  new Date(year, month - 1, day, hour, minute);

describe("fechas de la lista", () => {
  it("hoy muestra solo la hora", () => {
    expect(formatListDate(at(2026, 11, 17, 10, 42), NOW)).toBe("10:42");
  });
  it("esta semana muestra el día y la hora", () => {
    expect(formatListDate(at(2026, 11, 16, 17, 20), NOW)).toBe("lun 17:20");
    expect(formatListDate(at(2026, 11, 11, 8, 3), NOW)).toBe("mié 8:03");
  });
  it("este año muestra día y mes; antes, la fecha completa", () => {
    expect(formatListDate(at(2026, 3, 4), NOW)).toBe("4 mar");
    expect(formatListDate(at(2025, 11, 14), NOW)).toBe("14/11/2025");
  });
});

describe("fecha del correo abierto", () => {
  it("usa Hoy y Ayer, y la fecha completa para lo demás", () => {
    expect(formatFullDate(at(2026, 11, 17, 10, 42), NOW)).toBe("Hoy, 10:42");
    expect(formatFullDate(at(2026, 11, 16, 23, 59), NOW)).toBe("Ayer, 23:59");
    expect(formatFullDate(at(2024, 12, 18, 12, 10), NOW)).toBe("18 dic 2024, 12:10");
  });
});

describe("grupos de la lista", () => {
  it("agrupa por cercanía", () => {
    expect(dateGroup(at(2026, 11, 17, 0, 1), NOW)).toBe("Hoy");
    expect(dateGroup(at(2026, 11, 16, 23, 59), NOW)).toBe("Ayer");
    expect(dateGroup(at(2026, 11, 12), NOW)).toBe("Esta semana");
    expect(dateGroup(at(2026, 11, 2), NOW)).toBe("Este mes");
    expect(dateGroup(at(2026, 10, 30), NOW)).toBe("Anteriores");
  });
});

describe("otros formatos", () => {
  it("tiempo transcurrido", () => {
    expect(formatAgo(new Date(NOW.getTime() - 20_000), NOW)).toBe("ahora mismo");
    expect(formatAgo(new Date(NOW.getTime() - 3 * 60_000), NOW)).toBe("hace 3 min");
    expect(formatAgo(new Date(NOW.getTime() - 2 * 3600_000), NOW)).toBe("hace 2 h");
  });
  it("tamaños con coma decimal", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(248 * 1024)).toBe("248 KB");
    expect(formatSize(1.2 * 1024 * 1024)).toBe("1,2 MB");
  });
  it("tipo de fichero en palabras", () => {
    expect(fileKind("Parte.PDF", "application/octet-stream")).toBe("PDF");
    expect(fileKind("foto.jpg", "image/jpeg")).toBe("Imagen");
    expect(fileKind("datos.xlsx", "application/x")).toBe("Hoja de cálculo");
    expect(fileKind(null, "application/x")).toBe("Fichero");
  });
  it("iniciales del remitente", () => {
    expect(initials("Laura Pascual", "laura@x.test")).toBe("LP");
    expect(initials("Tramitación · Seguros Albor", "t@x.test")).toBe("TS");
    expect(initials("", "hola@buzon.test")).toBe("HB");
  });
});
