import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api.ts";
import type { WebPlugin } from "./types.ts";

type Job = {
  sha: string;
  filename: string | null;
  state: string;
  kind: string | null;
  pages: number;
  attempts: number;
  ms: number;
  cost: number;
  detail: string | null;
  at: string;
};
type Status = {
  running: boolean;
  model: string;
  service: string;
  concurrency: number;
  counts: { state: string; documents: number; cost: number; ms: number }[];
  recent: Job[];
};

const STATES: { id: string; label: string; tone: string }[] = [
  { id: "queued", label: "En cola", tone: "text-ink" },
  { id: "running", label: "Leyendo", tone: "text-accent-strong" },
  { id: "done", label: "Hechos", tone: "text-ok" },
  { id: "skipped", label: "Omitidos", tone: "text-ink-2" },
  { id: "failed", label: "Fallidos", tone: "text-bad-ink" },
];
const label = (state: string) => STATES.find((entry) => entry.id === state)?.label ?? state;
const money = (value: number) =>
  `${value.toLocaleString("es-ES", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} $`;

/** La cola del modelo de visión, viva: se refresca sola cada pocos segundos. */
function VisionQueue({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["plugins", "vision", "status"],
    queryFn: () => apiGet<Status>("/plugins/vision/status"),
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: () => apiPost<{ queued: number }>("/plugins/vision/retry", {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["plugins", "vision"] }),
  });
  const data = status.data;
  const count = (state: string) => data?.counts.find((row) => row.state === state);
  const cost = data?.counts.reduce((sum, row) => sum + row.cost, 0) ?? 0;
  const failed = count("failed")?.documents ?? 0;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-sm font-semibold">Cola del modelo de visión</h2>
        <p className="m-0 text-xs leading-normal text-ink-2">
          Lee fotos, planos y escaneados: copia su texto y anota qué contienen. Cada documento se
          lee una vez aunque venga en varios correos.
          {data && (
            <>
              {" "}
              Modelo <b className="font-semibold text-ink">{data.model}</b> en {data.service},{" "}
              {data.concurrency} a la vez.
            </>
          )}
        </p>
        {data && !data.running && (
          <p role="alert" className="m-0 text-xs font-semibold text-bad-ink">
            Parada: falta la clave del servicio en la configuración del servidor.
          </p>
        )}
      </div>
      {status.isError && (
        <p role="alert" className="m-0 text-xs text-ink-2">
          No se ha podido consultar la cola.
        </p>
      )}
      {data && (
        <>
          <dl className="m-0 grid grid-cols-3 gap-x-6 gap-y-2 text-xs sm:grid-cols-6">
            {STATES.map((state) => (
              <div key={state.id} className="flex flex-col gap-0.5">
                <dt className="text-ink-2">{state.label}</dt>
                <dd className={`m-0 text-lg font-semibold tabular-nums ${state.tone}`}>
                  {count(state.id)?.documents ?? 0}
                </dd>
              </div>
            ))}
            <div className="flex flex-col gap-0.5">
              <dt className="text-ink-2">Coste</dt>
              <dd className="m-0 text-lg font-semibold tabular-nums">{money(cost)}</dd>
            </div>
          </dl>
          {isAdmin && failed > 0 && (
            <button
              type="button"
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className="h-7 self-start rounded-md border border-line-strong bg-panel px-2.5 text-xs font-semibold text-ink hover:bg-ground disabled:opacity-60"
            >
              Reintentar los {failed} fallidos
            </button>
          )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <caption className="pb-1.5 text-left font-semibold">Últimos movimientos</caption>
              <thead>
                <tr className="border-b border-line text-left text-ink-2">
                  <th className="py-1.5 pr-2 font-normal">Fichero</th>
                  <th className="py-1.5 pr-2 font-normal">Estado</th>
                  <th className="py-1.5 pr-2 font-normal">Qué es</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Págs.</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Tiempo</th>
                  <th className="py-1.5 text-right font-normal">Coste</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((job) => (
                  <tr key={job.sha} className="border-b border-line-soft align-top">
                    <td className="max-w-56 py-1.5 pr-2">
                      <span className="block truncate">{job.filename ?? "(sin nombre)"}</span>
                      {job.detail && (
                        <span className="block text-[11px] leading-snug text-ink-2">
                          {job.detail}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      {label(job.state)}
                      {job.attempts > 1 && ` (intento ${job.attempts})`}
                    </td>
                    <td className="py-1.5 pr-2">{job.kind ?? ""}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{job.pages || ""}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">
                      {job.ms ? `${(job.ms / 1000).toFixed(1)} s` : ""}
                    </td>
                    <td className="py-1.5 text-right tabular-nums whitespace-nowrap">
                      {job.cost ? money(job.cost) : ""}
                    </td>
                  </tr>
                ))}
                {data.recent.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-1.5 text-ink-2">
                      Todavía no ha entrado nada en la cola.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export const visionPlugin: WebPlugin = {
  id: "vision",
  SettingsSection: VisionQueue,
};
