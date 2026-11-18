import { describe, expect, it } from "vitest";
import { parseAnswer } from "./answer.ts";

describe("respuesta del modelo de visión", () => {
  it("separa tipo, descripción y texto", () => {
    expect(
      parseAnswer(
        "TIPO: documento\nDESCRIPCIÓN: Parte amistoso firmado.\nTEXTO:\nDECLARACIÓN AMISTOSA\nVehículo A: 4471-KLM",
      ),
    ).toEqual({
      kind: "documento",
      description: "Parte amistoso firmado.",
      text: "DECLARACIÓN AMISTOSA\nVehículo A: 4471-KLM",
    });
  });

  it("una foto sin texto deja el texto vacío, con o sin corchetes", () => {
    for (const mark of ["[SIN TEXTO]", "SIN TEXTO", "Sin texto."]) {
      const answer = parseAnswer(
        `**TIPO:** foto\n**DESCRIPCION:** Camión blanco con golpes en la caja.\n**TEXTO:**\n${mark}`,
      );
      expect(answer).toEqual({
        kind: "foto",
        description: "Camión blanco con golpes en la caja.",
        text: "",
      });
    }
  });

  it("si el modelo se salta el formato, lo que dice se toma como texto", () => {
    expect(parseAnswer("Presupuesto n.º 2026-0311\nTotal 2.031,23")).toEqual({
      kind: "otro",
      description: "",
      text: "Presupuesto n.º 2026-0311\nTotal 2.031,23",
    });
  });
});
