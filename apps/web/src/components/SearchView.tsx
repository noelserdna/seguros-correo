import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api, type SearchHit } from "../api.ts";
import { displayName, formatListDate } from "../format.ts";
import { locationName } from "../folders.ts";
import { navigate, useUrlState } from "../url-state.ts";
import { Icon } from "./Icon.tsx";

/** Convierte las marcas del servidor en resaltado, sin interpretar nada más como HTML. */
function Highlighted({ text, start, end }: { text: string; start: string; end: string }) {
  const parts: ReactNode[] = [];
  let rest = text;
  let key = 0;
  for (;;) {
    const open = rest.indexOf(start);
    const close = open === -1 ? -1 : rest.indexOf(end, open + start.length);
    if (open === -1 || close === -1) break;
    parts.push(rest.slice(0, open));
    parts.push(
      <mark key={key++} className="rounded-xs bg-mark px-px text-ink">
        {rest.slice(open + start.length, close)}
      </mark>,
    );
    rest = rest.slice(close + end.length);
  }
  parts.push(rest);
  return <>{parts}</>;
}

function Where({ hit }: { hit: SearchHit }) {
  if (hit.location === null || hit.removedFromServerAt) {
    return (
      <span className="flex items-center gap-[5px] rounded-full border border-line-strong bg-archive px-2 py-0.5 font-semibold text-ink">
        <Icon name="archive" size={12} />
        En el archivo
      </span>
    );
  }
  return <span className="truncate">{locationName(hit.location, hit.locationUse)}</span>;
}

const field = "h-7 rounded-md border border-line-strong bg-panel px-2 text-xs text-ink";

/** Resultados de búsqueda en todos los buzones y en el archivo, con filtros. */
export function SearchView({
  selectedId,
  onSelect,
  compact,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Con un correo abierto al lado, se ocultan las columnas secundarias. */
  compact: boolean;
}) {
  const url = useUrlState();
  const filters = {
    q: url.q,
    from: url.from,
    since: url.since,
    until: url.until,
    attachments: url.attachments,
    archive: url.archive,
  };
  const search = useQuery({
    queryKey: ["search", filters],
    queryFn: () => api.search(filters),
    enabled: url.q.trim().length > 0,
  });

  const items = search.data?.items ?? [];
  const marks = search.data?.marks ?? { start: "\u0000", end: "\u0000" };
  const filtered = Boolean(url.from || url.since || url.until || url.attachments || !url.archive);
  const set = (change: Parameters<typeof navigate>[0]) => navigate(change, { replace: true });

  const count =
    items.length === 1
      ? "1 resultado"
      : `${search.data?.truncated ? "Más de " : ""}${items.length} resultados`;

  return (
    <section
      aria-label="Resultados de búsqueda"
      className={`flex min-w-0 flex-col bg-panel ${compact ? "w-[460px] shrink-0 border-r border-line" : "grow"}`}
    >
      <div className="flex flex-col gap-2.5 border-b border-line px-6 pt-3.5 pb-3">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h1 className="m-0 text-base font-semibold">
            {search.isLoading ? "Buscando" : count} para «{url.q}»
          </h1>
          <span className="text-xs text-ink-2">
            en todos tus buzones{url.archive ? " y en el archivo" : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs">
            De
            <input
              type="text"
              value={url.from}
              onChange={(event) => set({ from: event.target.value })}
              placeholder="nombre o dirección"
              className={`${field} w-40`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            Desde
            <input
              type="date"
              value={url.since}
              onChange={(event) => set({ since: event.target.value })}
              className={field}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            Hasta
            <input
              type="date"
              value={url.until}
              onChange={(event) => set({ until: event.target.value })}
              className={field}
            />
          </label>
          <label className="flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-xs">
            <input
              type="checkbox"
              checked={url.attachments}
              onChange={(event) => set({ attachments: event.target.checked })}
              className="m-0 accent-accent"
            />
            Con adjuntos
          </label>
          <label className="flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-xs">
            <input
              type="checkbox"
              checked={url.archive}
              onChange={(event) => set({ archive: event.target.checked })}
              className="m-0 accent-accent"
            />
            Incluir el archivo
          </label>
          {filtered && (
            <button
              type="button"
              onClick={() =>
                set({ from: "", since: "", until: "", attachments: false, archive: true })
              }
              className="border-0 bg-transparent p-0 text-xs font-semibold text-accent"
            >
              Quitar filtros
            </button>
          )}
        </div>
      </div>

      {!compact && (
        <div className="flex items-center gap-4 border-b border-line bg-ground px-6 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
          <span className="w-[200px] shrink-0">De</span>
          <span className="grow">Asunto</span>
          <span className="w-[190px] shrink-0">Dónde está</span>
          <span className="w-[90px] shrink-0 text-right">Fecha</span>
        </div>
      )}

      <div className="min-h-0 grow overflow-y-auto">
        {search.isError && (
          <div role="alert" className="flex flex-col items-start gap-2 p-6 text-ink-2">
            <p className="m-0">No se ha podido hacer la búsqueda.</p>
            <button
              type="button"
              onClick={() => void search.refetch()}
              className="h-8 rounded-md border border-line-strong bg-panel px-3 font-semibold text-ink"
            >
              Reintentar
            </button>
          </div>
        )}
        {search.isSuccess && items.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <Icon name="search" size={28} className="text-ink-2" />
            <h2 className="m-0 text-sm font-semibold">Nada con «{url.q}»</h2>
            <p className="m-0 max-w-sm text-xs leading-normal text-ink-2">
              Revisa cómo está escrito o busca por remitente. Hemos mirado en todos tus buzones
              {url.archive ? " y en el archivo" : ""}.
              {filtered && " Prueba también a quitar los filtros."}
            </p>
          </div>
        )}
        {items.map((hit) => (
          <button
            key={hit.id}
            type="button"
            onClick={() => onSelect(hit.id)}
            aria-current={hit.id === selectedId ? "true" : undefined}
            className={`flex w-full items-start gap-4 border-0 border-b border-l-[3px] border-b-line-soft px-6 py-2.5 text-left text-ink ${
              hit.id === selectedId
                ? "border-l-accent bg-accent-soft"
                : "border-l-transparent bg-panel hover:bg-ground"
            }`}
          >
            {!compact && (
              <span className="w-[200px] shrink-0 truncate">
                {displayName(hit.fromName, hit.fromAddress)}
              </span>
            )}
            <span className="flex min-w-0 grow flex-col gap-0.5">
              {compact && (
                <span className="flex items-baseline gap-2 text-xs text-ink-2">
                  <span className="min-w-0 grow truncate">
                    {displayName(hit.fromName, hit.fromAddress)}
                  </span>
                  <span className="whitespace-nowrap">{formatListDate(hit.internalDate)}</span>
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 truncate font-semibold">
                  {hit.subject || "(sin asunto)"}
                </span>
                {hit.hasAttachments && (
                  <Icon name="clip" size={14} label="Con adjuntos" className="text-ink-2" />
                )}
              </span>
              <span className="truncate text-xs text-ink-2">
                <Highlighted text={hit.headline} start={marks.start} end={marks.end} />
              </span>
              {compact && (
                <span className="flex text-xs text-ink-2">
                  <Where hit={hit} />
                </span>
              )}
            </span>
            {!compact && (
              <>
                <span className="flex w-[190px] shrink-0 items-center text-xs text-ink-2">
                  <Where hit={hit} />
                </span>
                <span className="w-[90px] shrink-0 text-right text-xs whitespace-nowrap text-ink-2">
                  {formatListDate(hit.internalDate)}
                </span>
              </>
            )}
          </button>
        ))}
        {items.length > 0 && !search.data?.truncated && (
          <p className="m-0 px-6 py-3.5 text-xs text-ink-2">No hay más resultados.</p>
        )}
        {search.data?.truncated && (
          <p className="m-0 px-6 py-3.5 text-xs text-ink-2">
            Hay más resultados. Afina la búsqueda con los filtros para verlos.
          </p>
        )}
      </div>
    </section>
  );
}
