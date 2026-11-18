import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api, type MessageDetail } from "../api.ts";
import { displayName, formatListDate } from "../format.ts";
import { locationName, uniqueByHeader } from "../folders.ts";
import { plugins } from "../plugins/index.ts";
import { navigate } from "../url-state.ts";
import { Icon } from "./Icon.tsx";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Panel de contexto del correo abierto. En esta fase muestra remitente, conversación
 * y ubicación; es el sitio reservado para el expediente cuando exista el plugin.
 */
export function ContextPanel({
  message,
  onClose,
  onSelect,
  overlay,
}: {
  message: MessageDetail | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  overlay: boolean;
}) {
  const thread = useQuery({
    queryKey: ["thread", message?.threadId],
    queryFn: () => api.thread(message!.threadId),
    enabled: Boolean(message),
  });

  const facts = useQuery({
    queryKey: ["message", message?.id, "facts"],
    queryFn: () => api.facts(message!.id),
    enabled: Boolean(message),
  });

  return (
    <aside
      aria-label="Contexto del correo"
      className={`flex w-80 shrink-0 flex-col border-l border-line bg-panel ${
        overlay
          ? "absolute top-0 right-10 bottom-0 z-10 shadow-[-8px_0_24px_rgba(27,35,48,0.10)]"
          : ""
      }`}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="m-0 grow text-[13px] font-semibold">Contexto</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar el panel de contexto"
          className="flex size-[30px] items-center justify-center rounded-md border-0 bg-transparent text-ink hover:bg-ground"
        >
          <Icon name="close" />
        </button>
      </div>

      {!message ? (
        <p className="m-0 p-4 text-xs leading-normal text-ink-2">
          Abre un correo para ver aquí quién lo envía y el resto de la conversación.
        </p>
      ) : (
        <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto p-4">
          <Section title="Remitente">
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold">
                {displayName(message.from.name, message.from.address)}
              </span>
              <span className="text-xs break-all text-ink-2">{message.from.address}</span>
            </div>
            <button
              type="button"
              onClick={() =>
                navigate({
                  view: "search",
                  q: message.from.address.split("@")[0] ?? message.from.address,
                  from: message.from.address,
                  since: "",
                  until: "",
                  attachments: false,
                  archive: true,
                  messageId: null,
                })
              }
              className="self-start border-0 bg-transparent p-0 text-xs font-semibold text-accent hover:text-accent-strong"
            >
              Ver todos sus correos
            </button>
          </Section>

          <Section title="En esta conversación">
            {uniqueByHeader(thread.data ?? [], message.id).map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSelect(entry.id)}
                aria-current={entry.id === message.id ? "true" : undefined}
                className={`flex flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left text-ink ${
                  entry.id === message.id
                    ? "border-accent bg-accent-soft"
                    : "border-line bg-panel hover:bg-ground"
                }`}
              >
                <span className="flex gap-2 text-xs">
                  <span className="min-w-0 grow truncate font-semibold">
                    {displayName(entry.fromName, entry.fromAddress)}
                  </span>
                  <span className="whitespace-nowrap text-ink-2">
                    {formatListDate(entry.internalDate)}
                  </span>
                </span>
                <span className="truncate text-xs text-ink-2">{entry.snippet ?? " "}</span>
              </button>
            ))}
          </Section>

          {facts.data && facts.data.length > 0 && (
            <Section title="Datos del correo">
              <dl className="m-0 flex flex-col gap-1.5 text-xs">
                {facts.data.map((fact) => (
                  <div key={fact.id} className="flex gap-2">
                    <dt className="w-24 shrink-0 text-ink-2">{fact.kind.replace(/_/g, " ")}</dt>
                    <dd
                      className="m-0 min-w-0 grow font-semibold break-words"
                      title={
                        fact.method === "user"
                          ? "Escrito por una persona"
                          : `Extraído automáticamente (${fact.extractor})${fact.evidence ? `: «${fact.evidence}»` : ""}`
                      }
                    >
                      {fact.value}
                      {!fact.confirmed && (
                        <span className="font-normal text-ink-2"> · sin revisar</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          {/* Hueco para plugins: cada módulo añade aquí su sección. */}
          {plugins.map(
            (plugin) =>
              plugin.ContextSection && (
                <plugin.ContextSection key={plugin.id} message={message} onSelect={onSelect} />
              ),
          )}

          <Section title="Dónde está">
            {message.locations.length === 0 ? (
              <div className="flex items-center gap-2 text-xs">
                <Icon name="archive" size={14} className="text-ink-2" />
                <span>Solo en el archivo. Ya no está en el buzón del servidor.</span>
              </div>
            ) : (
              message.locations.map((location) => (
                <div key={location.folderId} className="flex items-center gap-2 text-xs">
                  <Icon name="folder" size={14} className="text-ink-2" />
                  <span>{locationName(location.path, location.specialUse)}</span>
                </div>
              ))
            )}
          </Section>
        </div>
      )}
    </aside>
  );
}
