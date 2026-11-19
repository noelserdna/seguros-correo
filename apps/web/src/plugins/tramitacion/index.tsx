import type { WebPlugin } from "../types.ts";
import { TramitacionCaseSection, useTramitacionLines } from "./CaseSection.tsx";
import { TramitacionContext, TramitarAction } from "./FromMail.tsx";
import { TRAMITACION_SETTINGS } from "./Settings.tsx";
import { TramitacionPage } from "./Work.tsx";

/** Módulo de tramitación en la interfaz: página propia, botón en el correo, contexto y configuración. */
export const tramitacionPlugin: WebPlugin = {
  id: "tramitacion",
  rail: { icon: "tasks", label: "Tramitación" },
  Page: TramitacionPage,
  ToolbarAction: TramitarAction,
  ContextSection: TramitacionContext,
  settings: TRAMITACION_SETTINGS,
  CaseSection: TramitacionCaseSection,
  useCaseLines: useTramitacionLines,
};
