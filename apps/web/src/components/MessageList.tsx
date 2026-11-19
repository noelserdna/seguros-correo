import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MessageItem } from "../api.ts";
import { dateGroup, displayName, formatListDate, isFlagged, isUnread } from "../format.ts";
import { plugins } from "../plugins/index.ts";
import { processingState } from "../processing.ts";
import { Icon } from "./Icon.tsx";

/** Los de serie, o el de un módulo («<módulo>:<filtro>», p. ej. «Sin expediente»). */
type Filter = "all" | "unread" | "attachments" | "unprocessed" | `${string}:${string}`;
type Row = { kind: "group"; title: string } | { kind: "message"; item: MessageItem };

const GROUP_HEIGHT = 29;
const MESSAGE_HEIGHT = 74;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todos" },
  { id: "unread", label: "Sin leer" },
  { id: "attachments", label: "Con adjuntos" },
  { id: "unprocessed", label: "Sin procesar" },
];

function MessageRow({
  item,
  selected,
  archived,
  onSelect,
  labels,
}: {
  item: MessageItem;
  labels: string[] | undefined;
  selected: boolean;
  archived: boolean;
  onSelect: () => void;
}) {
  const unread = !archived && isUnread(item.flags);
  const state = processingState(item.processing);
  const weight = unread ? "font-semibold" : "font-normal";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-message={item.id}
      tabIndex={-1}
      className={`flex h-full w-full gap-2 border-0 border-b border-l-[3px] border-b-line-soft py-[9px] pr-3 pl-2 text-left text-ink ${
        selected
          ? "border-l-accent bg-accent-soft"
          : "border-l-transparent bg-panel hover:bg-ground"
      }`}
    >
      <span className="w-2 shrink-0 pt-[5px]">
        {unread && (
          <span role="img" aria-label="Sin leer" className="block size-2 rounded-full bg-accent" />
        )}
      </span>
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 grow truncate ${weight}`}>
            {displayName(item.fromName, item.fromAddress)}
          </span>
          <span className="text-xs whitespace-nowrap text-ink-2">
            {formatListDate(item.internalDate)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`min-w-0 grow truncate ${weight}`}>
            {item.subject || "(sin asunto)"}
          </span>
          {/* Hueco para plugins: etiquetas, por ejemplo el número de expediente. */}
          {labels?.map((label) => (
            <span
              key={label}
              className="rounded bg-accent-soft px-1.5 py-px text-[11px] font-semibold whitespace-nowrap text-accent-strong"
            >
              {label}
            </span>
          ))}
          {state.tone === "working" ? (
            <span title={state.text} className="flex shrink-0">
              <Icon name="refresh" size={14} label={state.text} className="text-accent" />
            </span>
          ) : state.tone === "partial" ? (
            <span title={state.text} className="flex shrink-0 items-center gap-0.5 text-flag">
              <Icon name="clip" size={14} label={state.text} />
              <span aria-hidden className="size-1.5 rounded-full bg-flag" />
            </span>
          ) : (
            item.hasAttachments && (
              <span title={state.text || "Con adjuntos"} className="flex shrink-0">
                <Icon name="clip" size={14} label="Con adjuntos" className="text-ink-2" />
              </span>
            )
          )}
          {isFlagged(item.flags) && (
            <Icon name="flag" size={14} label="Con bandera" className="text-flag" filled />
          )}
        </span>
        <span className="truncate text-xs text-ink-2">{item.snippet ?? " "}</span>
      </span>
    </button>
  );
}

/** Lista de correos por mensajes sueltos, agrupados por fecha, que carga más al bajar. */
export function MessageList({
  title,
  subtitle,
  items,
  isLoading,
  isError,
  hasMore,
  loadMore,
  onRetry,
  selectedId,
  onSelect,
  archived = false,
  empty,
  labels,
}: {
  /** Etiquetas que aportan los plugins, por correo. */
  labels?: Map<string, string[]>;
  title: string;
  subtitle?: string;
  items: MessageItem[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  loadMore: () => void;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  archived?: boolean;
  empty: ReactNode;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const scroller = useRef<HTMLDivElement>(null);
  // Filtros de los módulos: cada uno dice qué correos de los cargados lo cumplen. La lista de
  // módulos no cambia mientras la aplicación está abierta, así que las llamadas van siempre igual.
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const extra = plugins.flatMap((plugin) =>
    (plugin.listFilters ?? []).map((entry) => ({
      id: `${plugin.id}:${entry.id}` as Filter,
      label: entry.label,
      matches: entry.useMatches(ids),
    })),
  );
  const pluginFilter = extra.find((entry) => entry.id === filter);

  const visible = useMemo(
    () =>
      items.filter((item) =>
        pluginFilter
          ? pluginFilter.matches.has(item.id)
          : filter === "unread"
            ? isUnread(item.flags)
            : filter === "attachments"
              ? item.hasAttachments
              : filter === "unprocessed"
                ? processingState(item.processing).tone !== "ok"
                : true,
      ),
    [items, filter, pluginFilter],
  );

  const rows = useMemo(() => {
    const result: Row[] = [];
    let group = "";
    for (const item of visible) {
      const next = dateGroup(item.internalDate);
      if (next !== group) {
        group = next;
        result.push({ kind: "group", title: next });
      }
      result.push({ kind: "message", item });
    }
    return result;
  }, [visible]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (rows[index]?.kind === "group" ? GROUP_HEIGHT : MESSAGE_HEIGHT),
    overscan: 12,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastIndex = virtualRows.at(-1)?.index ?? 0;

  useEffect(() => {
    if (hasMore && rows.length > 0 && lastIndex >= rows.length - 15) loadMore();
  }, [hasMore, lastIndex, rows.length, loadMore]);

  // Flechas arriba y abajo para pasar de un correo a otro, como en Outlook.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const position = visible.findIndex((item) => item.id === selectedId);
    const next = visible[position + (event.key === "ArrowDown" ? 1 : -1)] ?? visible[0];
    if (!next || next.id === selectedId) return;
    onSelect(next.id);
    const rowIndex = rows.findIndex((row) => row.kind === "message" && row.item.id === next.id);
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: "auto" });
  };

  return (
    <section
      aria-label={title}
      className="flex w-full flex-col bg-panel md:w-[300px] md:shrink-0 md:border-r md:border-line lg:w-[360px]"
    >
      <div className="flex flex-col gap-2 border-b border-line px-3 pt-3 pb-2">
        <div className="flex items-baseline gap-2">
          <h2 className="m-0 truncate text-[15px] font-semibold">{title}</h2>
          {subtitle && <span className="text-xs whitespace-nowrap text-ink-2">{subtitle}</span>}
        </div>
        {!archived && (
          <div className="flex flex-wrap gap-1.5">
            {[...FILTERS, ...extra].map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
                className={`h-6 rounded-full border px-2.5 text-xs ${
                  filter === option.id
                    ? "border-accent bg-accent-soft font-semibold text-accent-strong"
                    : "border-line-strong bg-panel text-ink hover:bg-ground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label="Lista de correos. Usa las flechas para moverte."
        className="min-h-0 grow overflow-y-auto"
      >
        {isLoading && (
          <div role="status" className="flex flex-col gap-3 p-4" aria-label="Cargando correos">
            {[92, 78, 85, 64].map((width) => (
              <div key={width} className="flex flex-col gap-1.5">
                <div className="h-2.5 w-2/5 rounded bg-line-soft" />
                <div className="h-2.5 rounded bg-line-soft" style={{ width: `${width}%` }} />
              </div>
            ))}
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-start gap-2 p-4 text-ink-2">
            <p className="m-0">No se han podido cargar los correos.</p>
            <button
              type="button"
              onClick={onRetry}
              className="h-8 rounded-md border border-line-strong bg-panel px-3 font-semibold text-ink"
            >
              Reintentar
            </button>
          </div>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            {filter === "all" ? (
              empty
            ) : (
              <p className="m-0 text-ink-2">No hay correos que cumplan ese filtro.</p>
            )}
          </div>
        )}
        {rows.length > 0 && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              return (
                <div
                  key={virtualRow.key}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {row.kind === "group" ? (
                    <div className="h-full border-b border-line bg-ground px-3 pt-2 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
                      {row.title}
                    </div>
                  ) : (
                    <MessageRow
                      item={row.item}
                      labels={labels?.get(row.item.id)}
                      selected={row.item.id === selectedId}
                      archived={archived}
                      onSelect={() => onSelect(row.item.id)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
