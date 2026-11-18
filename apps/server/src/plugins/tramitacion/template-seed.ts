/**
 * Plantilla de serie: «Siniestro de automóvil con atestado». Sale de la práctica habitual
 * de una correduría en España. Los plazos marcados con `legalRef` son legales, pero
 * orientativos hasta que un criterio jurídico confirme cómo se cuentan.
 */
import type { TemplateTree } from "./schema.ts";

export const SEED_TEMPLATE: TemplateTree = {
  name: "Siniestro de automóvil con atestado",
  caseTypeName: "Siniestro de automóvil con atestado",
  active: true,
  phases: [
    {
      name: "Apertura",
      tasks: [
        {
          key: "T1",
          name: "Registrar el atestado y los datos del siniestro",
          ownerRule: "gestor",
          dueAnchor: "apertura",
          dueDays: 1,
        },
        {
          key: "T2",
          name: "Pedir documentación al cliente",
          description: "Parte amistoso, fotos, póliza y permiso de circulación.",
          ownerRule: "gestor",
          waitsOnRole: "cliente",
          after: ["T1"],
          dueDays: 2,
          chaseDays: 3,
        },
      ],
    },
    {
      name: "Comunicación",
      tasks: [
        {
          key: "T3",
          name: "Comunicar el siniestro a la aseguradora",
          ownerRule: "gestor",
          after: ["T1"],
          dueAnchor: "siniestro",
          dueDays: 7,
          legalRef: "art. 16 LCS: 7 días desde que se conoce el siniestro",
        },
        {
          key: "T4",
          name: "Obtener el número de siniestro",
          ownerRule: "gestor",
          waitsOnRole: "aseguradora",
          after: ["T3"],
          dueDays: 3,
          dueUnit: "habiles",
          chaseDays: 3,
        },
        {
          key: "T5",
          name: "Decidir si aplica convenio (CIDE/ASCIDE/SDM)",
          ownerRule: "gestor",
          after: ["T3"],
          dueDays: 2,
        },
      ],
    },
    {
      name: "Valoración",
      tasks: [
        {
          key: "T6",
          name: "Designación de perito",
          ownerRule: "gestor",
          waitsOnRole: "aseguradora",
          after: ["T4"],
          dueDays: 5,
          dueUnit: "habiles",
          chaseDays: 5,
        },
        {
          key: "T7",
          name: "Peritación del vehículo",
          ownerRule: "gestor",
          waitsOnRole: "perito",
          after: ["T6"],
          dueDays: 7,
          dueUnit: "habiles",
          chaseDays: 7,
        },
        {
          key: "T8",
          name: "Revisar el informe pericial con el cliente",
          ownerRule: "gestor",
          after: ["T7"],
          dueDays: 3,
        },
        {
          key: "T9",
          name: "Seguimiento de lesiones",
          description: "Solo si hay lesionados.",
          ownerRule: "gestor",
          waitsOnRole: "medico",
          after: ["T1"],
          optional: true,
        },
      ],
    },
    {
      name: "Resolución",
      tasks: [
        {
          key: "T10",
          name: "Reclamar al contrario",
          description: "Si no aplica convenio: se reclama a la aseguradora contraria.",
          ownerRule: "gestor",
          after: ["T5"],
          dueDays: 10,
        },
        {
          key: "T11",
          name: "Oferta o respuesta motivada del contrario",
          ownerRule: "gestor",
          waitsOnRole: "aseguradora_contraria",
          after: ["T10"],
          dueDays: 90,
          chaseDays: 30,
          legalRef: "art. 7 TRLRCSCVM: 3 meses desde la reclamación",
        },
        {
          key: "T12",
          name: "Reparación o declaración de siniestro total",
          ownerRule: "gestor",
          waitsOnRole: "taller",
          after: ["T8"],
          dueDays: 15,
          chaseDays: 7,
        },
        {
          key: "T13",
          name: "Peritaje contradictorio o abogado",
          description: "Solo si hay desacuerdo con la valoración.",
          ownerRule: "gestor",
          waitsOnRole: "abogado",
          after: ["T8"],
          dueDays: 30,
          optional: true,
        },
      ],
    },
    {
      name: "Cobro y cierre",
      tasks: [
        {
          key: "T14",
          name: "Cobro de la indemnización o pago al taller",
          ownerRule: "gestor",
          waitsOnRole: "aseguradora",
          after: ["T11", "T12"],
          dueDays: 40,
          chaseDays: 15,
          legalRef: "art. 18 LCS: pago del importe mínimo (a verificar)",
        },
        {
          key: "T15",
          name: "Comunicar el resultado al cliente",
          ownerRule: "gestor",
          after: ["T14"],
          dueDays: 2,
        },
        {
          key: "T16",
          name: "Cerrar el expediente",
          ownerRule: "gestor",
          after: ["T15"],
          dueDays: 1,
        },
      ],
    },
  ],
};
