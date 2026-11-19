import { describe, expect, it } from "vitest";
import { addBusinessDays, businessDaysUntil, isBusinessDay } from "./days.ts";
import {
  assertAcyclic,
  CycleError,
  deriveTasks,
  idleDays,
  phaseStates,
  summarize,
  type EngineCase,
  type EngineEvent,
  type EnginePhase,
  type EngineTask,
} from "./engine.ts";

const TODAY = "2026-11-18";
const kase: EngineCase = { openedAt: "2026-11-04", lossDate: "2026-11-03", status: "abierto" };

let counter = 0;
const task = (overrides: Partial<EngineTask> & { id: string }): EngineTask => ({
  phaseId: "p1",
  position: counter++,
  name: overrides.id,
  status: "pendiente",
  assigneeId: null,
  waitingOn: null,
  waitingSince: null,
  chaseAt: null,
  dueAnchor: "lista",
  dueDays: null,
  dueUnit: "naturales",
  dueOverride: null,
  legalRef: null,
  doneAt: null,
  evidenceIds: [],
  dependsOn: [],
  ...overrides,
});

describe("días hábiles", () => {
  it("se saltan fines de semana y festivos nacionales, también el Viernes Santo", () => {
    expect(isBusinessDay("2026-11-18")).toBe(true);
    expect(isBusinessDay("2026-11-21")).toBe(false); // sábado
    expect(isBusinessDay("2026-12-08")).toBe(false); // Inmaculada
    expect(addBusinessDays("2026-12-04", 2)).toBe("2026-12-09");
    expect(addBusinessDays("2026-04-02", 1)).toBe("2026-04-06"); // Viernes Santo y fin de semana
    expect(addBusinessDays("2026-11-10", 7)).toBe("2026-11-19");
    expect(businessDaysUntil("2026-11-18", "2026-11-19")).toBe(1);
    expect(businessDaysUntil("2026-11-18", "2026-11-17")).toBe(-1);
  });
});

/** El expediente de ejemplo del lienzo, EXP-2026-0142, a 18/11/2026. */
const phases: EnginePhase[] = [
  { id: "apertura", position: 1, name: "Apertura" },
  { id: "comunicacion", position: 2, name: "Comunicación" },
  { id: "valoracion", position: 3, name: "Valoración" },
  { id: "resolucion", position: 4, name: "Resolución" },
  { id: "cobro", position: 5, name: "Cobro y cierre" },
];
const plan: EngineTask[] = [
  task({
    id: "T1",
    phaseId: "apertura",
    name: "Registrar el atestado",
    status: "hecha",
    evidenceIds: ["correo"],
    doneAt: "2026-11-04",
    dueAnchor: "apertura",
    dueDays: 1,
  }),
  task({
    id: "T2",
    phaseId: "apertura",
    name: "Pedir documentación al cliente",
    status: "hecha",
    evidenceIds: ["correo"],
    doneAt: "2026-11-10",
    dependsOn: ["T1"],
    dueDays: 2,
  }),
  task({
    id: "T3",
    phaseId: "comunicacion",
    name: "Comunicar a la aseguradora",
    status: "hecha",
    evidenceIds: ["correo"],
    doneAt: "2026-11-05",
    dependsOn: ["T1"],
    dueAnchor: "siniestro",
    dueDays: 7,
    legalRef: "art. 16 LCS",
  }),
  task({
    id: "T4",
    phaseId: "comunicacion",
    name: "Obtener el número de siniestro",
    status: "hecha",
    evidenceIds: ["correo"],
    doneAt: "2026-11-07",
    dependsOn: ["T3"],
    dueDays: 3,
    dueUnit: "habiles",
  }),
  task({
    id: "T5",
    phaseId: "comunicacion",
    name: "Decidir si aplica convenio",
    status: "hecha",
    evidenceIds: ["correo"],
    doneAt: "2026-11-07",
    dependsOn: ["T3"],
    dueDays: 2,
  }),
  task({
    id: "T6",
    phaseId: "valoracion",
    name: "Designación de perito",
    status: "hecha",
    evidenceIds: ["correo"],
    doneAt: "2026-11-10",
    dependsOn: ["T4"],
    dueDays: 5,
    dueUnit: "habiles",
  }),
  task({
    id: "T7",
    phaseId: "valoracion",
    name: "Peritación del vehículo",
    status: "esperando",
    waitingOn: "Peritaciones Norte",
    waitingSince: "2026-11-10",
    chaseAt: "2026-11-20",
    dependsOn: ["T6"],
    dueDays: 7,
    dueUnit: "habiles",
  }),
  task({
    id: "T8",
    phaseId: "valoracion",
    name: "Revisar el informe pericial",
    dependsOn: ["T7"],
    dueDays: 3,
  }),
  task({
    id: "T9",
    phaseId: "valoracion",
    name: "Seguimiento de lesiones",
    status: "omitida",
    dependsOn: ["T1"],
  }),
  task({
    id: "T10",
    phaseId: "resolucion",
    name: "Reclamar al contrario",
    dependsOn: ["T5"],
    dueDays: 10,
  }),
  task({
    id: "T11",
    phaseId: "resolucion",
    name: "Oferta motivada",
    dependsOn: ["T10"],
    dueDays: 90,
    legalRef: "art. 7 TRLRCSCVM",
  }),
  task({
    id: "T12",
    phaseId: "resolucion",
    name: "Reparación o siniestro total",
    dependsOn: ["T8"],
    dueDays: 15,
  }),
  task({
    id: "T13",
    phaseId: "resolucion",
    name: "Peritaje contradictorio",
    status: "omitida",
    dependsOn: ["T8"],
  }),
  task({ id: "T14", phaseId: "cobro", name: "Cobro", dependsOn: ["T11", "T12"] }),
  task({
    id: "T15",
    phaseId: "cobro",
    name: "Comunicar el resultado",
    dependsOn: ["T14"],
    dueDays: 2,
  }),
  task({ id: "T16", phaseId: "cobro", name: "Cerrar", dependsOn: ["T15"], dueDays: 1 }),
];
const events: EngineEvent[] = [
  { at: "2026-11-04", kind: "creada" },
  { at: "2026-11-10", kind: "espera" },
  { at: "2026-11-17", kind: "estado" },
  { at: "2026-11-18", kind: "nota" },
];

describe("motor de la tramitación", () => {
  it("calcula lo mismo que se dibujó para EXP-2026-0142", () => {
    const summary = summarize({ kase, phases, tasks: plan, events, today: TODAY });
    const byId = new Map(summary.tasks.map((entry) => [entry.id, entry]));

    expect(summary.phases.map((phase) => `${phase.name}: ${phase.state}`)).toEqual([
      "Apertura: hecha",
      "Comunicación: hecha",
      "Valoración: actual",
      "Resolución: retraso",
      "Cobro y cierre: proxima",
    ]);
    expect(summary.currentPhase).toBe("Valoración");
    // La peritación vence a los 7 días hábiles de la designación: mañana.
    expect(byId.get("T7")).toMatchObject({
      state: "esperando",
      due: "2026-11-19",
      dueSoon: true,
      lateDays: 0,
      chaseDue: false,
    });
    // Reclamar al contrario venció ayer: 10 días desde que se decidió que no hay convenio.
    expect(byId.get("T10")).toMatchObject({ state: "lista", due: "2026-11-17", lateDays: 1 });
    expect(byId.get("T8")).toMatchObject({
      state: "bloqueada",
      blockers: ["Peritación del vehículo"],
      due: null,
    });
    expect(byId.get("T14")!.blockers).toEqual(["Oferta motivada", "Reparación o siniestro total"]);

    expect(summary.nextStep).toEqual({
      kind: "tarea",
      taskId: "T10",
      name: "Reclamar al contrario",
      due: "2026-11-17",
      late: true,
      legal: false,
    });
    expect(summary.health).toEqual({
      level: "riesgo",
      lateCount: 1,
      idleDays: 1,
      reasons: ["1 tarea vencida", "Vence pronto: Peritación del vehículo"],
    });
  });

  it("una dependencia hecha u omitida desbloquea, y las independientes quedan listas a la vez", () => {
    const tasks = deriveTasks(
      [
        task({ id: "a", status: "hecha", doneAt: "2026-11-05" }),
        task({ id: "b", status: "omitida" }),
        task({ id: "c", dependsOn: ["a", "b"] }),
        task({ id: "d" }),
        task({ id: "e", dependsOn: ["c"] }),
      ],
      kase,
      TODAY,
    );
    expect(tasks.map((entry) => `${entry.id}: ${entry.state}`)).toEqual([
      "a: hecha",
      "b: omitida",
      "c: lista",
      "d: lista",
      "e: bloqueada",
    ]);
  });

  it("rechaza dependencias en círculo y dice cuáles", () => {
    expect(() =>
      assertAcyclic([
        { id: "a", name: "Peritar", dependsOn: ["c"] },
        { id: "b", name: "Reparar", dependsOn: ["a"] },
        { id: "c", name: "Cobrar", dependsOn: ["b"] },
      ]),
    ).toThrow(CycleError);
    expect(
      assertAcyclic([
        { id: "b", dependsOn: ["a"] },
        { id: "a", dependsOn: [] },
      ]),
    ).toEqual(["a", "b"]);
  });

  it("cada ancla de plazo, y el plazo puesto a mano manda", () => {
    const sinFecha: EngineCase = { ...kase, lossDate: null };
    const [desdeSiniestro, desdeApertura, sinSiniestro, aMano] = [
      deriveTasks([task({ id: "s", dueAnchor: "siniestro", dueDays: 7 })], kase, TODAY)[0]!,
      deriveTasks([task({ id: "a", dueAnchor: "apertura", dueDays: 1 })], kase, TODAY)[0]!,
      deriveTasks([task({ id: "s", dueAnchor: "siniestro", dueDays: 7 })], sinFecha, TODAY)[0]!,
      deriveTasks(
        [task({ id: "m", dueAnchor: "apertura", dueDays: 1, dueOverride: "2026-12-01" })],
        kase,
        TODAY,
      )[0]!,
    ];
    expect(desdeSiniestro.due).toBe("2026-11-10");
    expect(desdeApertura.due).toBe("2026-11-05");
    expect(sinSiniestro.due).toBe("2026-11-11"); // sin fecha del siniestro, desde la apertura
    expect(aMano.due).toBe("2026-12-01");
  });

  it("el siguiente paso: primero lo vencido, luego lo legal, luego por fecha; si no, la espera", () => {
    const step = (tasks: EngineTask[]) =>
      summarize({
        kase,
        phases: [{ id: "p1", position: 1, name: "Fase" }],
        tasks,
        events,
        today: TODAY,
      }).nextStep;
    expect(
      step([
        task({ id: "pronto", dueOverride: "2026-11-19" }),
        task({ id: "legal", dueOverride: "2026-11-25", legalRef: "art. 16 LCS" }),
      ]),
    ).toMatchObject({ kind: "tarea", taskId: "legal" });
    expect(
      step([
        task({ id: "legal", dueOverride: "2026-11-25", legalRef: "x" }),
        task({ id: "vencida", dueOverride: "2026-11-10" }),
      ]),
    ).toMatchObject({ kind: "tarea", taskId: "vencida", late: true });
    expect(
      step([
        task({ id: "p1", status: "esperando", waitingOn: "Perito", chaseAt: "2026-11-25" }),
        task({ id: "p2", status: "esperando", waitingOn: "Taller", chaseAt: "2026-11-20" }),
      ]),
    ).toEqual({
      kind: "esperar",
      taskId: "p2",
      name: "p2",
      waitingOn: "Taller",
      chaseAt: "2026-11-20",
    });
    expect(step([task({ id: "x", status: "hecha", evidenceIds: ["m"] })])).toEqual({
      kind: "cerrar",
    });
    expect(step([])).toEqual({ kind: "sin_plan" });
  });

  it("solo el avance real cuenta para los días sin movimiento", () => {
    expect(
      idleDays(
        [
          { at: "2026-11-08", kind: "estado" },
          { at: "2026-11-17", kind: "nota" },
        ],
        kase,
        TODAY,
      ),
    ).toBe(10);
    expect(
      idleDays(
        [
          { at: "2026-11-08", kind: "estado" },
          { at: "2026-11-17", kind: "prueba" },
        ],
        kase,
        TODAY,
      ),
    ).toBe(1);
    expect(idleDays([], kase, TODAY)).toBe(14); // desde la apertura
  });

  it("la salud: vencidas, parado, en riesgo, al día y cerrado", () => {
    const health = (
      tasks: EngineTask[],
      evts: EngineEvent[] = [{ at: TODAY, kind: "estado" }],
      k = kase,
    ) =>
      summarize({
        kase: k,
        phases: [{ id: "p1", position: 1, name: "Fase" }],
        tasks,
        events: evts,
        today: TODAY,
      }).health;
    expect(
      health([
        task({ id: "x", dueOverride: "2026-11-17", legalRef: "art. 16 LCS", name: "Comunicar" }),
      ]),
    ).toMatchObject({
      level: "vencidas",
      reasons: ["Plazo legal vencido: Comunicar", "1 tarea vencida"],
    });
    expect(health([task({ id: "x", dueOverride: "2026-11-10" })]).level).toBe("vencidas"); // más de 3 días
    expect(
      health(
        [task({ id: "x", dueOverride: "2026-11-30" })],
        [{ at: "2026-11-06", kind: "estado" }],
      ),
    ).toMatchObject({
      level: "parado",
      reasons: ["Sin avance real desde hace 12 días"],
    });
    expect(
      health([
        task({
          id: "x",
          status: "esperando",
          waitingOn: "Taller Ebro",
          chaseAt: "2026-11-18",
          name: "Reparación",
        }),
      ]),
    ).toMatchObject({
      level: "riesgo",
      reasons: ["Toca reclamar a Taller Ebro: Reparación"],
    });
    expect(
      health([task({ id: "x", dueOverride: "2026-11-30" })], [{ at: "2026-11-12", kind: "estado" }])
        .reasons,
    ).toEqual(["Sin avance real desde hace 6 días"]);
    expect(health([task({ id: "x", dueOverride: "2026-11-30" })])).toMatchObject({
      level: "al_dia",
      reasons: [],
    });
    expect(
      health([task({ id: "x", dueOverride: "2026-11-10" })], [], { ...kase, status: "cerrado" })
        .level,
    ).toBe("cerrado");
    expect(health([]).level).toBe("sin_plan");
  });

  it("una fase hecha sin correo que la demuestre queda por validar", () => {
    const two: EnginePhase[] = [
      { id: "p1", position: 1, name: "Apertura" },
      { id: "p2", position: 2, name: "Comunicación" },
    ];
    const tasks = [
      task({ id: "a", phaseId: "p1", status: "hecha", doneAt: "2026-11-05" }),
      task({ id: "b", phaseId: "p1", status: "omitida" }),
      task({ id: "c", phaseId: "p2", dependsOn: ["a"] }),
    ];
    const summary = summarize({ kase, phases: two, tasks, events: [], today: TODAY });
    expect(summary.phases.map((phase) => phase.state)).toEqual(["por_validar", "actual"]);
    expect(summary.currentPhase).toBe("Comunicación");
    expect(summary.nextStep).toEqual({ kind: "validar", phaseId: "p1", name: "Apertura" });

    // Con el correo, la fase vale; una fase que no aplica entera no necesita correo.
    const proven = tasks.map((entry) =>
      entry.id === "a" ? { ...entry, evidenceIds: ["m1"] } : entry,
    );
    const after = summarize({ kase, phases: two, tasks: proven, events: [], today: TODAY });
    expect(after.phases[0]!.state).toBe("hecha");
    expect(after.nextStep.kind).toBe("tarea");
    const skipped = [task({ id: "z", phaseId: "p1", status: "omitida" })];
    expect(phaseStates(two.slice(0, 1), deriveTasks(skipped, kase, TODAY)).get("p1")).toBe("hecha");
  });
});

describe("quién escribe", () => {
  it("reconoce al tercero esperado por cualquiera de sus correos o su WhatsApp", async () => {
    const { isFrom } = await import("./store.ts");
    const task = {
      waitingContactEmails: ["informes@norte.test", "peritos@norte.test"],
      waitingContactPhones: ["34600111222"],
    };
    expect(isFrom(task, "Informes@Norte.test")).toBe(true);
    expect(isFrom(task, "peritos@norte.test")).toBe(true);
    expect(isFrom(task, "34600111222@whatsapp.invalid")).toBe(true);
    expect(isFrom(task, "34600999999@whatsapp.invalid")).toBe(false);
    expect(isFrom(task, "otro@norte.test")).toBe(false);
  });
});
