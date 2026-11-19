/**
 * El contexto de todo un expediente, en el panel de la derecha, sin abrir ningún correo: lo que
 * aporta cada correo y todos sus documentos con su texto. Es lo mismo que el panel enseña de un
 * correo, pero de todos los del expediente juntos: lo que leerá quien lo resuma o le pregunte.
 * Lo usan la página de Expedientes y la ficha de Tramitación.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, apiGet, type Attachment } from "../../api.ts";
import { AttachmentContext, LongText, Section } from "../../components/ContextPanel.tsx";
import { displayName, formatListDate } from "../../format.ts";
import { navigate } from "../../url-state.ts";
import { BASE, ContextMeter, KEY, type CaseMessage, type CaseSummary } from "../expedientes.tsx";

type Detail = { case: CaseSummary; messages: CaseMessage[] };

export function CaseContext({
  caseId,
  onOpen,
}: {
  caseId: string;
  onOpen: (messageId: string) => void;
}) {
  const detail = useQuery({
    queryKey: [...KEY, "case", caseId],
    queryFn: () => apiGet<Detail>(`${BASE}/cases/${caseId}`),
  });
  const messages = detail.data?.messages ?? [];
  // Cada correo con lo que aporta y sus adjuntos: lo mismo que el panel enseña de uno solo.
  const bodies = useQueries({
    queries: messages.map((entry) => ({
      queryKey: ["message", entry.id],
      queryFn: () => api.message(entry.id),
    })),
  });
  if (!detail.data) return <p className="m-0 text-xs text-ink-2">Cargando el contexto…</p>;
  const item = detail.data.case;
  const counted = messages.filter((entry) => !entry.excluded);

  // Cada documento una vez, aunque venga en varios correos (mismo nombre y tamaño).
  const seen = new Set<string>();
  const documents: { file: Attachment; from: string; at: string }[] = [];
  bodies.forEach((query, index) => {
    const entry = messages[index]!;
    if (entry.excluded || !query.data) return;
    for (const file of query.data.attachments) {
      if (file.inline) continue;
      const key = `${file.filename ?? ""}·${file.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push({
        file,
        from: displayName(entry.fromName, entry.fromAddress).split(" · ")[0]!,
        at: entry.internalDate,
      });
    }
  });
  const loading = bodies.some((query) => query.isLoading);

  return (
    <>
      <Section title="Expediente">
        <span className="font-semibold">
          {item.number} · {item.title}
        </span>
        <ContextMeter caseId={caseId} />
        <p className="m-0 text-[11px] leading-normal text-ink-2">
          Es lo que se leerá para resumir el expediente o preguntarle: lo que aporta cada correo y
          el texto de sus documentos. Para el detalle de uno, ábrelo.
        </p>
      </Section>

      <Section title={`Lo que aporta cada correo (${counted.length})`}>
        {messages.map((entry, index) => {
          const body = bodies[index]?.data;
          return (
            <div
              key={entry.id}
              className={`flex flex-col gap-1.5 ${entry.excluded ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                onClick={() => onOpen(entry.id)}
                className="flex items-baseline gap-2 border-0 bg-transparent p-0 text-left text-xs text-ink"
              >
                <b className="min-w-0 grow truncate font-semibold">
                  {displayName(entry.fromName, entry.fromAddress)}
                </b>
                <span className="shrink-0 text-ink-2">{formatListDate(entry.internalDate)}</span>
              </button>
              <span className="truncate text-xs text-ink-2">
                {entry.subject || "(sin asunto)"}
                {entry.excluded ? " · fuera del contexto" : ""}
              </span>
              {!body ? (
                <span className="text-xs text-ink-2">Cargando…</span>
              ) : body.bodyClean === null ? (
                <span className="text-xs text-ink-2">Todavía no se ha procesado su contenido.</span>
              ) : body.bodyClean === "" ? (
                <span className="text-xs text-ink-2">
                  No aporta texto propio: solo adjuntos o lo ya dicho antes.
                </span>
              ) : (
                <LongText text={body.bodyClean} />
              )}
            </div>
          );
        })}
      </Section>

      <Section title={`Documentos y su contenido (${documents.length})`}>
        {documents.map(({ file, from, at }) => (
          <div key={file.id} className="flex flex-col gap-1">
            <span className="text-[11px] text-ink-2">
              De {from} · {formatListDate(at)}
            </span>
            <AttachmentContext file={file} />
          </div>
        ))}
        {!loading && documents.length === 0 && (
          <p className="m-0 text-xs text-ink-2">Los correos del expediente no traen documentos.</p>
        )}
      </Section>
    </>
  );
}

/** Para el panel de la página de Expedientes: el expediente elegido (t=c:<id>). */
export function ExpedientesPageContext({ sub }: { sub: string | null }) {
  const caseId = sub?.startsWith("c:") ? sub.slice(2) : null;
  if (!caseId)
    return <p className="m-0 text-xs text-ink-2">Elige un expediente para ver aquí su contexto.</p>;
  return (
    <CaseContext
      caseId={caseId}
      // Al abrir un correo, el panel pasa a enseñar el detalle de ese correo.
      onOpen={(messageId) => navigate({ messageId })}
    />
  );
}
