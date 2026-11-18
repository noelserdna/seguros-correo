import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { pickLocation, type MailActions } from "../actions.ts";
import {
  api,
  ApiError,
  attachmentUrl,
  type Attachment,
  type MessageDetail,
  type MessageLocation,
  type OutboundKind,
} from "../api.ts";
import {
  displayName,
  fileKind,
  formatFullDate,
  formatListDate,
  formatLongDay,
  formatSize,
  initials,
} from "../format.ts";
import { folderRows, locationName, uniqueByHeader } from "../folders.ts";
import { EmailBody } from "./EmailBody.tsx";
import { Icon, type IconName } from "./Icon.tsx";

const SOON = "Disponible en una próxima versión";

function ToolButton({ icon, label, text }: { icon?: IconName; label: string; text?: boolean }) {
  return (
    <button
      type="button"
      disabled
      aria-label={text ? undefined : label}
      title={`${label}. ${SOON}`}
      className={`flex h-[30px] items-center justify-center gap-1.5 rounded-md border bg-transparent text-ink opacity-55 ${
        text ? "border-transparent px-2.5" : "w-[30px] border-transparent"
      }`}
    >
      {icon && <Icon name={icon} />}
      {text && label}
    </button>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  filled,
  tone = "",
  expanded,
  compact,
}: {
  icon?: IconName;
  label: string;
  onClick: () => void;
  disabled: boolean;
  /** En un panel estrecho se queda solo con el icono. */
  compact?: boolean;
  pressed?: boolean;
  filled?: boolean;
  tone?: string;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      className={`flex h-[30px] items-center gap-1.5 rounded-md border-0 px-2.5 whitespace-nowrap disabled:opacity-55 ${
        expanded
          ? "bg-accent-soft font-semibold text-accent-strong"
          : `bg-transparent enabled:hover:bg-ground ${tone || "text-ink"}`
      }`}
    >
      {icon && <Icon name={icon} filled={filled} />}
      {compact ? <span className="hidden @3xl:inline">{label}</span> : label}
    </button>
  );
}

/** Menú con las carpetas del buzón a las que se puede mover el correo. */
function MoveMenu({
  accountId,
  currentFolderId,
  onPick,
  onClose,
}: {
  accountId: string;
  currentFolderId: string;
  onPick: (target: { id: string; name: string }) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const folders = useQuery({
    queryKey: ["folders", accountId],
    queryFn: () => api.folders(accountId),
  });
  const rows = folderRows(folders.data ?? []);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onDown = (event: MouseEvent) => {
      if (!menu.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, rows.length]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(index + step + options.length) % options.length]?.focus();
  };

  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Mover a"
      onKeyDown={onKeyDown}
      className="absolute top-[34px] left-0 z-20 flex max-h-[420px] w-60 flex-col gap-px overflow-y-auto rounded-lg border border-line-strong bg-panel p-1.5 shadow-[0_8px_24px_rgba(27,35,48,0.14)]"
    >
      <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
        Mover a
      </div>
      {folders.isLoading && <div className="px-2 py-1.5 text-ink-2">Cargando carpetas…</div>}
      {rows.map(({ folder, name, depth }) => {
        const here = folder.id === currentFolderId;
        return (
          <button
            key={folder.id}
            type="button"
            role="menuitem"
            disabled={here}
            onClick={() => onPick({ id: folder.id, name })}
            style={{ paddingLeft: 8 + depth * 20 }}
            className="flex h-[30px] shrink-0 items-center rounded-md border-0 bg-transparent pr-2 text-left text-ink hover:bg-accent-soft focus-visible:bg-accent-soft disabled:text-ink-2 disabled:hover:bg-transparent"
          >
            <span className="min-w-0 grow truncate">{name}</span>
            {here && <span className="text-[11px]">aquí está</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Barra de acciones del correo abierto. El extremo derecho queda para plugins. */
function Toolbar({
  message,
  location,
  actions,
  onCompose,
  extra,
}: {
  message: MessageDetail | undefined;
  location: MessageLocation | null;
  actions: MailActions | undefined;
  extra: ((message: MessageDetail) => ReactNode) | undefined;
  onCompose: ((kind: OutboundKind) => void) | undefined;
}) {
  const [moving, setMoving] = useState(false);
  const closeMenu = useCallback(() => setMoving(false), []);
  useEffect(() => setMoving(false), [message?.id]);

  const off = !message || !location || !actions;
  const flagged = Boolean(location?.flags.includes("\\Flagged"));
  const unread = Boolean(location && !location.flags.includes("\\Seen"));
  const act = (run: (m: MessageDetail, l: MessageLocation, a: MailActions) => void) => () => {
    if (message && location && actions) run(message, location, actions);
  };

  return (
    <div className="@container flex h-11 shrink-0 items-center gap-1 border-b border-line px-3">
      <ActionButton
        icon="reply"
        label="Responder"
        disabled={!message || !onCompose}
        onClick={() => onCompose?.("reply")}
      />
      <ActionButton
        label="Responder a todos"
        disabled={!message || !onCompose}
        onClick={() => onCompose?.("replyAll")}
      />
      <ActionButton
        label="Reenviar"
        disabled={!message || !onCompose}
        onClick={() => onCompose?.("forward")}
      />
      <span className="mx-1 h-5 w-px bg-line" />
      <span className="relative">
        <ActionButton
          icon="move"
          label="Mover"
          disabled={off}
          expanded={moving}
          onClick={() => setMoving((open) => !open)}
        />
        {moving && message && location && (
          <MoveMenu
            accountId={message.accountId}
            currentFolderId={location.folderId}
            onClose={closeMenu}
            onPick={(target) => {
              setMoving(false);
              actions?.move(message, location, target);
            }}
          />
        )}
      </span>
      <ActionButton
        icon="flag"
        label={flagged ? "Con bandera" : "Bandera"}
        compact
        disabled={off}
        pressed={flagged}
        filled={flagged}
        tone={flagged ? "font-semibold text-flag" : ""}
        onClick={act((m, l, a) =>
          a.setFlags(m, l.folderId, flagged ? [] : ["\\Flagged"], flagged ? ["\\Flagged"] : []),
        )}
      />
      <ActionButton
        icon="mail"
        label="No leído"
        compact
        disabled={off}
        pressed={unread}
        tone={unread ? "font-semibold text-accent-strong" : ""}
        onClick={act((m, l, a) =>
          a.setFlags(m, l.folderId, unread ? ["\\Seen"] : [], unread ? [] : ["\\Seen"]),
        )}
      />
      <ActionButton
        icon="trash"
        label="Borrar"
        disabled={off}
        onClick={act((m, l, a) => a.remove(m, l))}
      />
      <div className="grow" />
      {/* Hueco para plugins: acciones del módulo sobre el correo abierto. */}
      {message && extra?.(message)}
      <ToolButton icon="print" label="Imprimir" />
    </div>
  );
}

function AttachmentChip({ file }: { file: Attachment }) {
  const kind = fileKind(file.filename, file.contentType);
  return (
    <a
      href={attachmentUrl(file.id)}
      download={file.filename ?? "adjunto"}
      className="flex h-11 max-w-[232px] min-w-0 items-center gap-2 rounded-md border border-line-strong px-2.5 text-ink no-underline hover:bg-ground"
    >
      <Icon
        name={kind === "Imagen" ? "image" : "file"}
        size={18}
        className={kind === "Imagen" ? "text-accent" : "text-flag"}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-semibold">
          {file.filename ?? "Adjunto sin nombre"}
        </span>
        <span className="text-[11px] text-ink-2">
          {kind} · {formatSize(file.size)}
        </span>
      </span>
    </a>
  );
}

const names = (list: { name: string; address: string }[]) =>
  list.map((entry) => displayName(entry.name, entry.address)).join(", ");

function MessageView({
  message,
  onSelect,
  onEditDraft,
}: {
  message: MessageDetail;
  onSelect: (id: string) => void;
  onEditDraft?: (draftId: string) => void;
}) {
  const [images, setImages] = useState(false);
  useEffect(() => setImages(false), [message.id]);

  const body = useQuery({
    queryKey: ["body", message.id, images],
    queryFn: () => api.body(message.id, images),
    // Mientras el contenido no haya llegado del servidor de correo, se vuelve a pedir.
    refetchInterval: (query) => (query.state.data?.pending ? 3000 : false),
  });
  const thread = useQuery({
    queryKey: ["thread", message.threadId],
    queryFn: () => api.thread(message.threadId),
  });

  const conversation = uniqueByHeader(thread.data ?? [], message.id);
  const others = conversation.filter((entry) => entry.id !== message.id);
  const files = message.attachments.filter((file) => !file.inline);
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const place = message.locations[0];
  const location = place ? locationName(place.path, place.specialUse) : null;

  return (
    <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-6 pt-4 pb-6">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-lg leading-[1.3] font-semibold tracking-[-0.01em]">
          {message.subject || "(sin asunto)"}
        </h1>
        {conversation.length > 1 && (
          <div className="text-xs text-ink-2">
            {conversation.length} mensajes en esta conversación
          </div>
        )}
      </div>

      {others.length > 0 && (
        <div className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-line">
          {others.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSelect(entry.id)}
              className="flex h-9 items-center gap-2.5 border-0 border-b border-line-soft bg-[#F8F9FB] px-3 text-left text-xs text-ink last:border-b-0 hover:bg-ground"
            >
              <span className="w-28 shrink-0 truncate font-semibold">
                {displayName(entry.fromName, entry.fromAddress)}
              </span>
              <span className="min-w-0 grow truncate text-ink-2">{entry.snippet}</span>
              <span className="whitespace-nowrap text-ink-2">
                {formatListDate(entry.internalDate)}
              </span>
            </button>
          ))}
        </div>
      )}

      {message.draftId && onEditDraft && (
        <div className="flex shrink-0 items-center gap-2.5 rounded-md border border-line-strong bg-accent-soft px-3 py-2.5 text-xs">
          <Icon name="drafts" />
          <span className="grow">Es un borrador tuyo, todavía sin enviar.</span>
          <button
            type="button"
            onClick={() => onEditDraft(message.draftId!)}
            className="h-7 rounded-md border-0 bg-accent px-3 font-semibold text-white"
          >
            Seguir escribiendo
          </button>
        </div>
      )}

      {message.removedFromServerAt && (
        <div className="flex shrink-0 gap-2.5 rounded-md border border-line-strong bg-archive px-3 py-2.5">
          <Icon name="archive" className="mt-px" />
          <div className="flex flex-col gap-0.5 text-xs leading-[1.45]">
            <span className="font-semibold">En el archivo</span>
            <span>
              Este correo ya no está en el buzón del servidor desde el{" "}
              {formatLongDay(message.removedFromServerAt)}. Aquí se conserva completo, con sus
              adjuntos.
            </span>
          </div>
        </div>
      )}

      <div className="flex shrink-0 items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#FCEBD9] text-[13px] font-semibold text-[#8A3F06]"
        >
          {initials(message.from.name, message.from.address)}
        </span>
        <div className="flex min-w-0 grow flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold whitespace-nowrap">
              {displayName(message.from.name, message.from.address)}
            </span>
            {message.from.name && (
              <span className="truncate text-xs text-ink-2">{message.from.address}</span>
            )}
          </div>
          <div className="truncate text-xs text-ink-2">
            Para: {names(message.to) || "(sin destinatarios)"}
            {message.cc.length > 0 && ` · CC: ${names(message.cc)}`}
            {location && !message.removedFromServerAt && ` · ${location}`}
          </div>
        </div>
        <div className="text-xs whitespace-nowrap text-ink-2">
          {formatFullDate(message.internalDate)}
        </div>
      </div>

      {body.data && body.data.blockedImages > 0 && (
        <div className="flex shrink-0 items-center gap-2 rounded-md border border-line bg-ground px-2.5 py-1.5 text-xs">
          <Icon name="imageOff" size={14} className="text-ink-2" />
          <span className="grow">
            Este correo contiene imágenes externas. No se han cargado para proteger tu privacidad.
          </span>
          <button
            type="button"
            onClick={() => setImages(true)}
            className="border-0 bg-transparent p-0 font-semibold text-accent hover:text-accent-strong"
          >
            Mostrar imágenes
          </button>
        </div>
      )}

      {body.isError && (
        <div role="alert" className="text-ink-2">
          No se ha podido cargar el contenido.{" "}
          <button
            type="button"
            onClick={() => void body.refetch()}
            className="border-0 bg-transparent p-0 font-semibold text-accent"
          >
            Reintentar
          </button>
        </div>
      )}
      {(body.isLoading || body.data?.pending) && (
        <div role="status" className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Icon name="refresh" className="text-accent" />
            <span>Trayendo el contenido de este correo. Tarda unos segundos.</span>
          </div>
          <div aria-hidden className="flex flex-col gap-2">
            <div className="h-2.5 w-11/12 rounded bg-line-soft" />
            <div className="h-2.5 w-10/12 rounded bg-line-soft" />
            <div className="h-2.5 w-7/12 rounded bg-line-soft" />
          </div>
        </div>
      )}
      {body.data && !body.data.pending && (
        <EmailBody html={body.data.html} title={`Contenido del correo: ${message.subject}`} />
      )}

      {files.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2 pt-1">
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <span className="font-semibold text-ink">
              {files.length === 1 ? "1 adjunto" : `${files.length} adjuntos`}
            </span>
            <span>{formatSize(totalSize)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {files.map((file) => (
              <AttachmentChip key={file.id} file={file} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Panel de lectura: el correo elegido, su conversación plegada y sus adjuntos. */
export function ReadingPane({
  messageId,
  onSelect,
  onLoaded,
  actions,
  folderId,
  onCompose,
  onEditDraft,
  toolbarExtra,
}: {
  messageId: string | null;
  /** Acciones sobre el correo. Sin ellas (en el archivo) la barra queda desactivada. */
  actions?: MailActions;
  /** Carpeta que se está viendo: las acciones se aplican al correo en ella. */
  folderId: string | null;
  /** Empezar una respuesta o un reenvío del correo abierto. */
  onCompose?: (kind: OutboundKind, sourceMessageId: string) => void;
  /** Seguir escribiendo un borrador propio. */
  onEditDraft?: (draftId: string) => void;
  /** Acciones que añaden los plugins a la barra. */
  toolbarExtra?: (message: MessageDetail) => ReactNode;
  onSelect: (id: string) => void;
  onLoaded?: (message: MessageDetail) => void;
}) {
  const message = useQuery({
    queryKey: ["message", messageId],
    queryFn: () => api.message(messageId!),
    enabled: Boolean(messageId),
  });
  useEffect(() => {
    if (message.data) onLoaded?.(message.data);
  }, [message.data, onLoaded]);

  if (!messageId) {
    return (
      <main className="flex min-w-0 grow flex-col items-center justify-center gap-2 bg-panel text-center">
        <Icon name="mail" size={28} className="text-ink-2" />
        <h2 className="m-0 text-sm font-semibold">Elige un correo para leerlo</h2>
        <p className="m-0 text-xs text-ink-2">
          Con las flechas arriba y abajo pasas de uno a otro.
        </p>
      </main>
    );
  }

  const missing = message.error instanceof ApiError && message.error.status === 404;
  return (
    <main className="flex min-w-0 grow flex-col bg-panel">
      <Toolbar
        message={message.data}
        location={message.data ? pickLocation(message.data, folderId) : null}
        actions={actions}
        onCompose={
          message.data && onCompose ? (kind) => onCompose(kind, message.data.id) : undefined
        }
        extra={toolbarExtra}
      />
      {message.isLoading && (
        <div role="status" className="p-6 text-ink-2">
          Abriendo el correo…
        </div>
      )}
      {message.isError && (
        <div role="alert" className="flex flex-col items-start gap-2 p-6">
          <p className="m-0 text-ink-2">
            {missing
              ? "Este correo no existe o no tienes acceso a su buzón."
              : "No se ha podido abrir el correo."}
          </p>
          {!missing && (
            <button
              type="button"
              onClick={() => void message.refetch()}
              className="h-8 rounded-md border border-line-strong bg-panel px-3 font-semibold"
            >
              Reintentar
            </button>
          )}
        </div>
      )}
      {message.data && (
        <MessageView message={message.data} onSelect={onSelect} onEditDraft={onEditDraft} />
      )}
    </main>
  );
}
