import { CaseContext } from "../expedientes/Context.tsx";
import type { WebPlugin } from "../types.ts";
import { openCase } from "./actions.ts";
import { TramitacionCaseSection, useTramitacionLines } from "./CaseSection.tsx";
import { TramitacionContext, TramitarAction } from "./FromMail.tsx";
import { TRAMITACION_SETTINGS } from "./Settings.tsx";
import { TramitacionPage } from "./Work.tsx";

/** Módulo de tramitación en la interfaz: página propia, botón en el correo, contexto y configuración. */
export const tramitacionPlugin: WebPlugin = {
  id: "tramitacion",
  rail: { icon: "tasks", label: "Tramitación" },
  Page: TramitacionPage,
  // En la ficha de un expediente, sin correo abierto: el contexto de todo el expediente.
  PageContext: ({ sub }) =>
    sub?.startsWith("exp:") ? (
      <CaseContext
        caseId={sub.slice(4)}
        onOpen={(messageId) => openCase(sub.slice(4), messageId)}
      />
    ) : (
      <p className="m-0 text-xs text-ink-2">Abre un expediente para ver aquí su contexto.</p>
    ),
  ToolbarAction: TramitarAction,
  ContextSection: TramitacionContext,
  settings: TRAMITACION_SETTINGS,
  CaseSection: TramitacionCaseSection,
  useCaseLines: useTramitacionLines,
};
