import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import { plugins } from "../plugins/index.ts";

const STATUS: Record<string, string> = {
  ok: "Con su texto leído",
  empty: "Sin texto dentro",
  pending: "En cola, leyéndose",
  needs_ocr: "Sin procesar: imágenes y escaneados",
  unsupported: "Sin procesar: tipo de fichero que no se sabe leer",
  failed: "Sin procesar: han dado error al leerlos",
};
const ORDER = ["ok", "empty", "pending", "needs_ocr", "unsupported", "failed"];
const number = (value: number) => value.toLocaleString("es-ES");

/** Cuánto de lo que hay en los buzones está ya leído y disponible para buscar. */
function ProcessingSummary() {
  const summary = useQuery({
    queryKey: ["processing"],
    queryFn: api.processing,
    refetchInterval: 10_000,
  });
  const data = summary.data;
  const documents = [...(data?.documents ?? [])].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );
  const total = documents.reduce((sum, row) => sum + row.documents, 0);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-sm font-semibold">Procesado de correos y adjuntos</h2>
        <p className="m-0 text-xs text-ink-2">
          Lo que ya se ha leído se puede buscar y sirve de contexto. En cada carpeta, el filtro «Sin
          procesar» enseña los correos a los que les falta algo.
        </p>
      </div>
      {summary.isError && (
        <p role="alert" className="m-0 text-xs text-ink-2">
          No se ha podido consultar el estado.
        </p>
      )}
      {data && (
        <>
          <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
            {[
              ["Correos", data.messages],
              ["Sin contenido todavía", data.bodyPending],
              ["Con adjuntos", data.withFiles],
              ["Con adjuntos sin procesar", data.incomplete],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="text-ink-2">{label}</dt>
                <dd className="m-0 text-lg font-semibold tabular-nums">
                  {number(value as number)}
                </dd>
              </div>
            ))}
          </dl>
          <table className="w-full border-collapse text-xs">
            <caption className="pb-1.5 text-left font-semibold">
              Adjuntos distintos: {number(total)}
            </caption>
            <thead>
              <tr className="border-b border-line text-left text-ink-2">
                <th className="py-1.5 font-normal">Estado</th>
                <th className="py-1.5 text-right font-normal">Ficheros</th>
                <th className="py-1.5 text-right font-normal">Con anotación</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((row) => (
                <tr key={row.status} className="border-b border-line-soft">
                  <td className="py-1.5">{STATUS[row.status] ?? row.status}</td>
                  <td className="py-1.5 text-right tabular-nums">{number(row.documents)}</td>
                  <td className="py-1.5 text-right tabular-nums">{number(row.noted)}</td>
                </tr>
              ))}
              {documents.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-1.5 text-ink-2">
                    Todavía no ha llegado ningún adjunto.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** Pantalla de Configuración. Cada plugin aporta su apartado. */
export function SettingsView({ isAdmin }: { isAdmin: boolean }) {
  const sections = plugins.filter((plugin) => plugin.SettingsSection);
  return (
    <main className="min-w-0 grow overflow-y-auto bg-panel">
      <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6 md:px-6">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">Configuración</h1>
          {!isAdmin && (
            <p className="m-0 text-xs text-ink-2">
              Puedes consultar estos ajustes. Para cambiarlos hace falta un administrador.
            </p>
          )}
        </div>
        <ProcessingSummary />
        {sections.map(
          (plugin) =>
            plugin.SettingsSection && <plugin.SettingsSection key={plugin.id} isAdmin={isAdmin} />,
        )}
      </div>
    </main>
  );
}
