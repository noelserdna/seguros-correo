import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-ink-2">{label}</dt>
      <dd className="m-0 min-w-0 grow break-words">{children}</dd>
    </div>
  );
}

const people = (list: { name: string; address: string }[]) =>
  list.length === 0
    ? "(nadie)"
    : list.map((entry) => displayName(entry.name, entry.address)).join(", ");

/** Texto largo que se enseña recortado y se despliega entero. */
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  return (
    <div className="flex flex-col items-start gap-1">
      <p
        className={`m-0 w-full rounded-md border border-line bg-ground px-2.5 py-2 text-xs leading-normal break-words whitespace-pre-wrap ${
          long && !open ? "max-h-32 overflow-hidden" : ""
        }`}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="border-0 bg-transparent p-0 text-xs font-semibold text-accent hover:text-accent-strong"
        >
          {open ? "Ver menos" : "Ver todo"}
        </button>
      )}
    </div>
  );
}

const TEXT_STATUS: Record<string, string> = {
  pending: "Leyendo su texto…",
  needs_ocr: "Es una imagen o un escaneado: aún no se ha reconocido su texto.",
  empty: "No contiene texto.",
  unsupported: "No se sabe leer el texto de este tipo de fichero.",
  failed: "No se ha podido leer su texto.",
};

/** Un adjunto y el texto que se ha leído de él, página a página al desplegarlo. */
function AttachmentContext({ file }: { file: MessageDetail["attachments"][number] }) {
  const [open, setOpen] = useState(false);
  const status = file.textStatus ?? "pending";
  const text = useQuery({
    queryKey: ["attachment-text", file.id],
    queryFn: () => api.attachmentText(file.id),
    enabled: open,
  });
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line px-2.5 py-2 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 grow truncate font-semibold">
          {file.filename ?? "Adjunto sin nombre"}
        </span>
        {status === "ok" && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="shrink-0 border-0 bg-transparent p-0 font-semibold text-accent hover:text-accent-strong"
          >
            {open ? "Ocultar" : "Ver texto"}
          </button>
        )}
      </div>
      <span className="text-ink-2">
        {status === "ok"
          ? `${(file.textChars ?? 0).toLocaleString("es-ES")} caracteres leídos`
          : (TEXT_STATUS[status] ?? status)}
      </span>
      {open && text.isLoading && <span className="text-ink-2">Cargando…</span>}
      {open &&
        text.data?.pages.map((page) => (
          <div key={page.page} className="flex flex-col gap-1">
            {text.data.pages.length > 1 && (
              <span className="text-[11px] font-semibold text-ink-2">
                {page.label ?? `Página ${page.page}`}
                {page.method === "sin_texto" && " · escaneada, sin texto todavía"}
              </span>
            )}
            {page.text && <LongText text={page.text} />}
          </div>
        ))}
      {open && text.data && text.data.pagesNeedingOcr > 0 && text.data.pages.length <= 1 && (
        <span className="text-ink-2">Hay páginas escaneadas sin texto todavía.</span>
      )}
    </div>
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

  const files = (message?.attachments ?? []).filter((file) => !file.inline);
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

          <Section title="Lo que aporta este correo">
            {message.bodyClean === null ? (
              <p className="m-0 text-xs text-ink-2">Todavía no se ha procesado su contenido.</p>
            ) : message.bodyClean === "" ? (
              <p className="m-0 text-xs text-ink-2">
                No aporta texto propio: solo trae adjuntos o lo ya dicho en la conversación.
              </p>
            ) : (
              <>
                <LongText text={message.bodyClean} />
                <p className="m-0 text-[11px] text-ink-2">
                  {message.bodyClean.length.toLocaleString("es-ES")} caracteres
                  {message.bodyText && message.bodyText.length > message.bodyClean.length + 20
                    ? `. El correo completo tiene ${message.bodyText.length.toLocaleString("es-ES")}: aquí va sin historial citado, firma, aviso legal ni maquetación.`
                    : "."}
                </p>
              </>
            )}
          </Section>

          {files.length > 0 && (
            <Section title="Texto de los adjuntos">
              {files.map((file) => (
                <AttachmentContext key={file.id} file={file} />
              ))}
            </Section>
          )}

          <Section title="Ficha del correo">
            <dl className="m-0 flex flex-col gap-1.5 text-xs">
              <Row label="Sentido">
                {message.direction === "out"
                  ? "Enviado desde este buzón"
                  : message.direction === "in"
                    ? "Recibido"
                    : "Sin determinar"}
              </Row>
              <Row label="Para">{people(message.to)}</Row>
              {message.cc.length > 0 && <Row label="Copia">{people(message.cc)}</Row>}
              {message.bcc.length > 0 && <Row label="Copia oculta">{people(message.bcc)}</Row>}
              {message.replyTo.length > 0 && (
                <Row label="Responder a">{people(message.replyTo)}</Row>
              )}
              {message.priority && (
                <Row label="Prioridad">{message.priority === "high" ? "Alta" : "Baja"}</Row>
              )}
              {message.autoReply && <Row label="Tipo">Respuesta automática</Row>}
            </dl>
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
                          : fact.method === "system"
                            ? "Anotado automáticamente por el programa"
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
