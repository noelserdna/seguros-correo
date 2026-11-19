/**
 * La tramitación dentro del propio expediente, en el módulo Expedientes: su plan en corto y
 * el camino a la ficha completa. Si aún no tiene plan, se le puede aplicar desde aquí.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { apiGet, ApiError } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import {
  BASE,
  KEY,
  tramitacion,
  useApplyView,
  useCase,
  type Portfolio,
  type TemplateSummary,
} from "./api.ts";
import { openCase } from "./actions.ts";
import { nextStepText } from "./logic.ts";
import { buttonClass, HealthBadge, PhaseBar } from "./pieces.tsx";

export function TramitacionCaseSection({
  caseId,
  wide = false,
}: {
  caseId: string;
  wide?: boolean;
}) {
  const view = useCase(caseId);
  const apply = useApplyView();
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const templates = useQuery({
    queryKey: [...KEY, "templates"],
    queryFn: () => apiGet<{ templates: TemplateSummary[] }>(`${BASE}/templates`),
    enabled: choosing,
  });
  if (!view.data) return null;
  const data = view.data;

  if (!data.plan) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2.5 py-2">
        <span className="text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
          Tramitación
        </span>
        {!choosing ? (
          <span className="flex items-center gap-2 text-xs text-ink-2">
            <span className="grow">Sin plan de tareas.</span>
            <button type="button" className={buttonClass.small} onClick={() => setChoosing(true)}>
              <Icon name="tasks" size={13} />
              Tramitar
            </button>
          </span>
        ) : (
          <span className="flex flex-col gap-1">
            <span className="text-xs text-ink-2">¿Con qué plantilla?</span>
            {templates.data?.templates
              .filter((entry) => entry.active)
              .map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={`${buttonClass.small} justify-start`}
                  onClick={() =>
                    void tramitacion.applyPlan(caseId, template.id).then(
                      (result) => {
                        apply(result);
                        openCase(caseId);
                      },
                      (failure: unknown) =>
                        setError(
                          failure instanceof ApiError
                            ? failure.message
                            : "No se ha podido aplicar.",
                        ),
                    )
                  }
                >
                  {template.name}
                </button>
              ))}
          </span>
        )}
        {error && (
          <span role="alert" className="text-xs text-bad-ink">
            {error}
          </span>
        )}
      </div>
    );
  }

  const unvalidated = data.phases.filter((phase) => phase.state === "por_validar").length;
  if (wide) {
    // En la página de Expedientes: una sola línea con lo esencial y el camino al plan.
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-panel px-3.5 py-2.5">
        <HealthBadge health={data.health} size={14} />
        <span className="w-[330px] max-w-full shrink-0">
          <PhaseBar phases={data.phases} compact />
        </span>
        <span className="min-w-0 grow truncate text-xs">
          {data.case.status === "abierto" ? (
            <>
              <span className="text-ink-2">Siguiente: </span>
              {nextStepText(data.nextStep, data.today)}
            </>
          ) : (
            <span className="text-ink-2">Expediente cerrado.</span>
          )}
          {unvalidated > 0 && (
            <span className="text-ink-2">
              {" "}
              ·{" "}
              {unvalidated === 1
                ? "1 fase sin correo que la valide"
                : `${unvalidated} fases sin correo`}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => openCase(caseId)}
          className="border-0 bg-transparent p-0 text-[13px] font-semibold text-accent hover:text-accent-strong"
        >
          Abrir el plan
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2.5 py-2">
      <span className="flex items-center gap-2">
        <span className="grow text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
          Tramitación
        </span>
        <HealthBadge health={data.health} size={12} />
      </span>
      <PhaseBar phases={data.phases} compact />
      {data.case.status === "abierto" && (
        <span className="text-xs">
          <span className="text-ink-2">Siguiente: </span>
          <b className="font-semibold">{nextStepText(data.nextStep, data.today)}</b>
        </span>
      )}
      {unvalidated > 0 && (
        <span className="flex items-center gap-1.5 text-xs">
          <Icon name="mail" size={13} />
          {unvalidated === 1
            ? "1 fase sin correo que la valide"
            : `${unvalidated} fases sin correo que las valide`}
        </span>
      )}
      <button
        type="button"
        onClick={() => openCase(caseId)}
        className="self-start border-0 bg-transparent p-0 text-xs font-semibold text-accent hover:text-accent-strong"
      >
        Abrir el plan
      </button>
    </div>
  );
}

/** Para la lista de Expedientes: salud y fase de cada expediente en tramitación. */
export function useTramitacionLines(): Map<string, ReactNode> {
  const portfolio = useQuery({
    queryKey: [...KEY, "portfolio", "lineas"],
    queryFn: () => apiGet<Portfolio>(`${BASE}/portfolio`),
  });
  return useMemo(
    () =>
      new Map(
        (portfolio.data?.cases ?? []).map((row) => [
          row.case.id,
          <span key={row.case.id} className="inline-flex min-w-0 items-center gap-1.5">
            <HealthBadge health={row.health} size={12} />
            {row.currentPhase && <span className="truncate text-ink-2">· {row.currentPhase}</span>}
          </span>,
        ]),
      ),
    [portfolio.data],
  );
}
