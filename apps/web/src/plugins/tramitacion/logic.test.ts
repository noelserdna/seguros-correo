import { describe, expect, it } from "vitest";
import type { Task } from "./api.ts";
import {
  dueText,
  healthText,
  looksLikeClaim,
  nextStepText,
  taskStatusText,
  textToHtml,
  toWho,
} from "./logic.ts";

const TODAY = "2026-11-18";
const task = (overrides: Partial<Task>): Task =>
  ({
    state: "lista",
    blockers: [],
    waitingOn: null,
    waitingSince: null,
    chaseAt: null,
    chaseDue: false,
    doneAt: null,
    ...overrides,
  }) as Task;

describe("textos de la tramitación", () => {
  it("el plazo se dice como en la oficina", () => {
    expect(dueText("2026-11-17", TODAY)).toEqual({ text: "Vencida ayer", tone: "late" });
    expect(dueText("2026-11-14", TODAY)).toEqual({ text: "Vencida hace 4 d", tone: "late" });
    expect(dueText("2026-11-18", TODAY)).toEqual({ text: "Vence hoy", tone: "soon" });
    expect(dueText("2026-11-19", TODAY)).toEqual({ text: "Vence mañana", tone: "soon" });
    expect(dueText("2026-11-30", TODAY)).toEqual({ text: "30/11", tone: "normal" });
    expect(dueText("2027-01-10", TODAY).text).toBe("10/01/2027");
    expect(dueText(null, TODAY).tone).toBe("none");
  });

  it("la situación de una tarea en una línea", () => {
    expect(
      taskStatusText(
        task({
          state: "esperando",
          waitingOn: "Peritaciones Norte",
          waitingSince: "2026-11-10",
          chaseAt: "2026-11-20",
        }),
        TODAY,
      ),
    ).toBe("Esperando a Peritaciones Norte · 8 d · reclamar 20/11");
    expect(
      taskStatusText(
        task({
          state: "esperando",
          waitingOn: "el cliente",
          chaseAt: "2026-11-17",
          chaseDue: true,
        }),
        TODAY,
      ),
    ).toBe("Esperando al cliente · toca reclamar");
    expect(
      taskStatusText(task({ state: "bloqueada", blockers: ["Peritación", "Cobro"] }), TODAY),
    ).toBe("Bloqueada por: Peritación, Cobro");
    expect(taskStatusText(task({ state: "hecha", doneAt: "2026-11-10" }), TODAY)).toBe(
      "Hecha 10/11",
    );
  });

  it("la salud y el siguiente paso", () => {
    expect(healthText({ level: "vencidas", lateCount: 1, idleDays: 0, reasons: [] })).toBe(
      "1 vencida",
    );
    expect(healthText({ level: "parado", lateCount: 0, idleDays: 12, reasons: [] })).toBe(
      "Parado 12 d",
    );
    expect(
      nextStepText(
        {
          kind: "esperar",
          taskId: "x",
          name: "Peritación",
          waitingOn: "Gabinete Ebro",
          chaseAt: "2026-11-15",
        },
        TODAY,
      ),
    ).toBe("Reclamar a Gabinete Ebro");
    expect(
      nextStepText(
        {
          kind: "esperar",
          taskId: "x",
          name: "Peritación",
          waitingOn: "Talleres Ebro",
          chaseAt: "2026-11-24",
        },
        TODAY,
      ),
    ).toBe("Esperar a Talleres Ebro · reclamar el 24/11");
  });

  it("reconoce un correo de atestado y prepara el texto del borrador", () => {
    expect(looksLikeClaim("Atestado 2026/8812", [])).toBe(true);
    expect(looksLikeClaim("Documentación", ["parte_amistoso.pdf"])).toBe(true);
    expect(looksLikeClaim("Documentación", ["Declaración amistosa.pdf"])).toBe(true);
    expect(looksLikeClaim("Presupuesto del taller", [])).toBe(false);
    expect(textToHtml("Hola <b>:\n\nVa la reclamación.\nGracias.")).toBe(
      "<p>Hola &lt;b&gt;:</p><p>Va la reclamación.<br>Gracias.</p>",
    );
  });
});

describe("toWho", () => {
  it("contrae el artículo con el cliente", () => {
    expect(toWho("el cliente")).toBe("al cliente");
    expect(toWho("Peritaciones Norte")).toBe("a Peritaciones Norte");
    expect(toWho(null)).toBe("a un tercero");
  });
});
