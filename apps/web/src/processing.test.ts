import { describe, expect, it } from "vitest";
import { processingState } from "./processing.ts";

const base = { bodyPending: false, files: 0, read: 0, pending: 0, noted: 0 };

describe("estado de procesado de un correo", () => {
  it("sin adjuntos y con el contenido traído, está procesado", () => {
    expect(processingState(base)).toEqual({ tone: "ok", text: "Procesado" });
  });
  it("mientras no llega el contenido o hay adjuntos en cola, está en ello", () => {
    expect(processingState({ ...base, bodyPending: true }).tone).toBe("working");
    expect(processingState({ ...base, files: 3, read: 1, pending: 2 })).toEqual({
      tone: "working",
      text: "Leyendo 2 adjuntos",
    });
  });
  it("dice cuántos adjuntos no se han podido leer", () => {
    expect(processingState({ ...base, files: 3, read: 2 }).text).toBe(
      "1 de 3 adjuntos sin procesar",
    );
    expect(processingState({ ...base, files: 1, read: 0 }).text).toBe("1 adjunto sin procesar");
    expect(processingState({ ...base, files: 2, read: 2 })).toEqual({
      tone: "ok",
      text: "2 adjuntos, todo leído",
    });
  });
  it("tiene en cuenta lo que alguien ha anotado de los no leídos", () => {
    expect(processingState({ ...base, files: 1, read: 0, noted: 1 }).text).toBe(
      "1 adjunto sin procesar, pero está anotado",
    );
    expect(processingState({ ...base, files: 4, read: 1, noted: 1 }).text).toBe(
      "3 de 4 adjuntos sin procesar (1 con anotación)",
    );
  });
});
