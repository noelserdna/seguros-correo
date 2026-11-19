import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, apiDelete, apiGet, apiPost, apiPut, type MessageDetail } from "../api.ts";
import { Confirm } from "../components/Confirm.tsx";
import { Icon } from "../components/Icon.tsx";
import { CatalogList } from "../components/settings.tsx";
import { displayName, formatListDate } from "../format.ts";
import type { WebPlugin } from "./types.ts";
import { ExpedientesPage, openExpediente } from "./expedientes/Page.tsx";

/**
 * Plugin de expedientes. Un expediente agrupa correos de cualquier buzón; un correo
 * puede estar en varios. Usa solo sus propias rutas y los huecos de la interfaz.
 */

export type Case = {
  id: string;
  accountId?: string;
  number: string;
  title: string;
  insurerId?: string | null;
  insurerName?: string | null;
};
type Insurer = { id: string; name: string; caseCount: number };
export type CaseSummary = Case & {
  messageCount: number;
  lastMessageAt: string | null;
  status?: "abierto" | "cerrado";
  closeReason?: string | null;
  caseTypeId?: string | null;
  typeName?: string | null;
  ownerId?: string | null;
  ownerName?: string | null;
  lossDate?: string | null;
  claimRef?: string | null;
  createdAt?: string;
  clientName?: string | null;
  hasPlan?: boolean | null;
  newCount?: number;
};
export type CaseMessage = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: string;
  how: "manual" | "thread" | "reference" | "claim" | "prueba";
  /** Sigue en el expediente, pero no cuenta como contexto. */
  excluded: boolean;
  mailbox: string;
  accountId?: string;
  direction?: "in" | "out" | null;
  snippet?: string | null;
  files?: number;
  whatsapp?: boolean;
  role?: string | null;
  isNew?: boolean;
};
type CaseWithMessages = { case: Case; messages: CaseMessage[] };

export const BASE = "/plugins/expedientes";
export const KEY = ["plugins", "expedientes"] as const;
export const HOW: Record<string, string> = {
  manual: "añadido a mano",
  thread: "por conversación",
  reference: "por el número en el asunto",
  claim: "por el número de siniestro",
  prueba: "como prueba de una tarea",
};

const useCasesOf = (messageId: string) =>
  useQuery({
    queryKey: [...KEY, "by-message", messageId],
    queryFn: () => apiGet<{ cases: CaseWithMessages[] }>(`${BASE}/by-message/${messageId}`),
  });

const useAllCases = (enabled = true) =>
  useQuery({
    queryKey: [...KEY, "cases"],
    queryFn: () => apiGet<{ cases: CaseSummary[] }>(`${BASE}/cases`),
    enabled,
  });

export const useInsurers = () =>
  useQuery({
    queryKey: [...KEY, "insurers"],
    queryFn: () => apiGet<{ insurers: Insurer[] }>(`${BASE}/insurers`),
  });

/** Lo que se va a hacer con un correo y un expediente, pendiente de confirmar. */
export type Pending =
  | { kind: "add"; target: Case; messageId: string; subject: string }
  | { kind: "remove"; target: Case; messageId: string; subject: string }
  | { kind: "create"; messageId: string; subject: string };

/** Pide confirmación y ejecuta: añadir a un expediente, quitar de él o crear uno nuevo. */
export function useCaseChanges() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");

  const run = () => {
    if (!pending) return;
    setBusy(true);
    setFailed("");
    const call =
      pending.kind === "add"
        ? apiPost(`${BASE}/cases/${pending.target.id}/messages`, { messageId: pending.messageId })
        : pending.kind === "remove"
          ? apiDelete(`${BASE}/cases/${pending.target.id}/messages/${pending.messageId}`)
          : apiPost(`${BASE}/cases`, { messageId: pending.messageId });
    call
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: KEY });
        setPending(null);
      })
      .catch((error: unknown) =>
        setFailed(error instanceof ApiError ? error.message : "No se ha podido hacer el cambio."),
      )
      .finally(() => setBusy(false));
  };

  let dialog: ReactNode = null;
  if (pending) {
    const subject = pending.subject || "(sin asunto)";
    const close = () => {
      setPending(null);
      setFailed("");
    };
    const problem = failed && (
      <p role="alert" className="m-0 mt-2 text-xs text-bad-ink">
        {failed}
      </p>
    );
    dialog =
      pending.kind === "remove" ? (
        <Confirm
          title={`¿Quitar esta conversación de ${pending.target.number}?`}
          confirmLabel="Quitar del expediente"
          danger
          busy={busy}
          onConfirm={run}
          onCancel={close}
        >
          <p className="m-0">
            «{subject}» y el resto de su conversación dejarán de estar en el expediente «
            {pending.target.title}». Los correos no se borran ni se mueven, y podrás volver a
            añadirlos. Si solo quieres que un correo no se tenga en cuenta, déjalo en el expediente
            y exclúyelo del contexto.
          </p>
          {problem}
        </Confirm>
      ) : pending.kind === "add" ? (
        <Confirm
          title={`¿Añadir este correo a ${pending.target.number}?`}
          confirmLabel="Añadir al expediente"
          busy={busy}
          onConfirm={run}
          onCancel={close}
        >
          <p className="m-0">
            «{subject}» y el resto de su conversación pasarán a formar parte del expediente «
            {pending.target.title}». Los correos no cambian de carpeta ni de buzón, y los que
            lleguen después a esa conversación se añadirán solos.
          </p>
          {problem}
        </Confirm>
      ) : (
        <Confirm
          title="¿Crear un expediente nuevo con este correo?"
          confirmLabel="Crear expediente"
          busy={busy}
          onConfirm={run}
          onCancel={close}
        >
          <p className="m-0">
            Se llamará «{subject}» y entrará con toda la conversación de este correo. Los correos
            que lleguen después a esa conversación se añadirán solos.
          </p>
          {problem}
        </Confirm>
      );
  }
  return { ask: setPending, dialog };
}

function MessageLine({
  entry,
  caseId,
  current,
  onSelect,
}: {
  entry: CaseMessage;
  caseId: string;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    setBusy(true);
    apiPut(`${BASE}/cases/${caseId}/messages/${entry.id}`, { excluded: !entry.excluded })
      .then(() => queryClient.invalidateQueries({ queryKey: KEY }))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const subject = entry.subject || "(sin asunto)";
  return (
    <div
      className={`flex items-stretch rounded-md border ${
        current ? "border-accent bg-accent-soft" : "border-line bg-panel"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(entry.id)}
        aria-current={current ? "true" : undefined}
        className={`flex min-w-0 grow flex-col gap-0.5 rounded-l-md border-0 bg-transparent px-2.5 py-2 text-left text-xs text-ink hover:bg-ground ${
          entry.excluded ? "opacity-60" : ""
        }`}
      >
        <span className="flex gap-2">
          <span className="min-w-0 grow truncate font-semibold">
            {displayName(entry.fromName, entry.fromAddress)}
          </span>
          <span className="whitespace-nowrap text-ink-2">{formatListDate(entry.internalDate)}</span>
        </span>
        <span className={`truncate ${entry.excluded ? "line-through" : ""}`}>{subject}</span>
        <span className="truncate text-ink-2">
          {entry.excluded ? "Fuera del contexto" : (HOW[entry.how] ?? entry.how)} · {entry.mailbox}
        </span>
      </button>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={entry.excluded}
        aria-label={
          entry.excluded
            ? `Volver a incluir en el contexto: ${subject}`
            : `Excluir del contexto: ${subject}`
        }
        title={
          entry.excluded
            ? "Fuera del contexto. Pulsa para volver a tenerlo en cuenta."
            : "Excluir del contexto: sigue en el expediente, pero no se tendrá en cuenta."
        }
        className="flex w-8 shrink-0 items-center justify-center rounded-r-md border-0 border-l border-line bg-transparent text-ink-2 hover:bg-ground hover:text-ink"
      >
        <Icon name={entry.excluded ? "eyeOff" : "eye"} size={14} />
      </button>
    </div>
  );
}

type CaseContext = {
  messages: number;
  excluded: number;
  documents: number;
  approxTokens: number;
  withoutText: { needsOcr: number; unsupported: number; failed: number; pending: number };
};

/** Cuánto contexto reúne el expediente: lo que leería quien lo resuma o responda sobre él. */
export function ContextMeter({ caseId }: { caseId: string }) {
  const context = useQuery({
    queryKey: [...KEY, "context", caseId],
    queryFn: () => apiGet<CaseContext>(`${BASE}/cases/${caseId}/context`),
  });
  if (!context.data) return null;
  const { messages, excluded, documents, approxTokens, withoutText } = context.data;
  const missing = withoutText.needsOcr + withoutText.unsupported + withoutText.failed;
  const parts = [
    messages === 1 ? "1 correo" : `${messages} correos`,
    documents === 1 ? "1 adjunto" : `${documents} adjuntos`,
    `unas ${approxTokens.toLocaleString("es-ES")} unidades de texto`,
  ];
  return (
    <p className="m-0 text-xs leading-normal text-ink-2">
      Contexto: {parts.join(" · ")}.
      {excluded > 0 &&
        ` ${excluded === 1 ? "1 correo excluido" : `${excluded} correos excluidos`}.`}
      {missing > 0 &&
        ` ${missing === 1 ? "1 adjunto sin texto" : `${missing} adjuntos sin texto`}${
          withoutText.needsOcr > 0 ? " (imágenes o escaneados)" : ""
        }.`}
      {withoutText.pending > 0 && " Leyendo adjuntos…"}
    </p>
  );
}

/** Desplegable con la aseguradora del expediente, tomada del catálogo de Configuración. */
function InsurerSelect({ item }: { item: Case }) {
  const queryClient = useQueryClient();
  const insurers = useInsurers();
  const change = (value: string) => {
    apiPut(`${BASE}/cases/${item.id}`, { insurerId: value || null })
      .then(() => queryClient.invalidateQueries({ queryKey: KEY }))
      .catch(() => undefined);
  };
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="shrink-0 text-ink-2">Aseguradora</span>
      <select
        value={item.insurerId ?? ""}
        onChange={(event) => change(event.target.value)}
        className="h-7 min-w-0 grow rounded-md border border-line-strong bg-panel px-1.5 text-xs text-ink"
      >
        <option value="">Sin aseguradora</option>
        {(insurers.data?.insurers ?? []).map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Apartado de Configuración: las listas que se eligen en cada expediente. */
function Catalogs({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const insurers = useInsurers();
  const types = useQuery({
    queryKey: [...KEY, "case-types"],
    queryFn: () =>
      apiGet<{ caseTypes: { id: string; name: string; caseCount: number }[] }>(
        `${BASE}/case-types`,
      ),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
      <CatalogList
        title="Aseguradoras"
        description="Las del desplegable «Aseguradora» de cada expediente."
        items={insurers.data?.insurers ?? []}
        loaded={insurers.isSuccess}
        isAdmin={isAdmin}
        placeholder="Nombre de la aseguradora"
        noun="aseguradora"
        removeEffect={(n) =>
          n === 1 ? "se quedará sin aseguradora." : "se quedarán sin aseguradora."
        }
        onAdd={(name) => apiPost(`${BASE}/insurers`, { name }).then(refresh)}
        onRemove={(id) => apiDelete(`${BASE}/insurers/${id}`).then(refresh)}
      />
      <CatalogList
        title="Tipos de expediente"
        description="Con qué tipo se abre cada expediente."
        items={types.data?.caseTypes ?? []}
        loaded={types.isSuccess}
        isAdmin={isAdmin}
        placeholder="Nombre del tipo"
        noun="tipo"
        removeEffect={(n) => (n === 1 ? "se quedará sin tipo." : "se quedarán sin tipo.")}
        onAdd={(name) => apiPost(`${BASE}/case-types`, { name }).then(refresh)}
        onRemove={(id) => apiDelete(`${BASE}/case-types/${id}`).then(refresh)}
      />
    </div>
  );
}

/** Menú de la barra: en qué expedientes está el correo, y añadirlo a otro o a uno nuevo. */
/**
 * Expedientes abiertos de quien escribe este correo (por su dirección o, con la agenda, por su
 * ficha). Sirve para no abrir otro expediente si el caso ya existe.
 */
export function useOpenOfSender(messageId: string) {
  return useQuery({
    queryKey: [...KEY, "open-of-sender", messageId],
    queryFn: () => apiGet<{ cases: Case[] }>(`${BASE}/open-of-sender/${messageId}`),
  });
}

function CaseMenu({
  message,
  current,
  onAsk,
  onClose,
}: {
  message: MessageDetail;
  current: Case[];
  onAsk: (pending: Pending) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const all = useAllCases();
  const ofSender = useOpenOfSender(message.id);
  const inside = new Set(current.map((entry) => entry.id));
  const suggested = (ofSender.data?.cases ?? []).filter((entry) => !inside.has(entry.id));
  const text = filter.trim().toLowerCase();
  const others = (all.data?.cases ?? []).filter(
    (entry) =>
      !inside.has(entry.id) &&
      (!text ||
        entry.number.toLowerCase().includes(text) ||
        entry.title.toLowerCase().includes(text)),
  );

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!box.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const subject = message.subject;
  const heading =
    "px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase";
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Expedientes de este correo"
      className="absolute top-[34px] right-0 z-20 flex max-h-[460px] w-80 max-w-[calc(100vw-24px)] flex-col overflow-y-auto rounded-lg border border-line-strong bg-panel p-1.5 text-[13px] shadow-[0_8px_24px_rgba(27,35,48,0.14)]"
    >
      {current.length > 0 && (
        <>
          <div className={heading}>Este correo está en</div>
          {current.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <span className="min-w-0 grow">
                <span className="block font-semibold">{entry.number}</span>
                <span className="block truncate text-xs text-ink-2">{entry.title}</span>
              </span>
              <button
                type="button"
                onClick={() =>
                  onAsk({ kind: "remove", target: entry, messageId: message.id, subject })
                }
                className="h-7 shrink-0 rounded-md border border-line-strong bg-panel px-2 text-xs font-semibold text-ink hover:bg-ground"
              >
                Quitar
              </button>
            </div>
          ))}
          <div className="my-1 h-px bg-line-soft" />
        </>
      )}

      {suggested.length > 0 && !filter && (
        <>
          <div className={heading}>Abiertos de quien escribe</div>
          {suggested.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onAsk({ kind: "add", target: entry, messageId: message.id, subject })}
              className="flex flex-col rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-accent-soft"
            >
              <span className="font-semibold">{entry.number}</span>
              <span className="truncate text-xs text-ink-2">{entry.title}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-line-soft" />
        </>
      )}
      <div className={heading}>Añadir a un expediente</div>
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        aria-label="Buscar expediente por número o título"
        placeholder="Buscar por número o título"
        className="mx-2 mb-1 h-8 rounded-md border border-line-strong bg-panel px-2 text-[13px] text-ink"
      />
      {others.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onAsk({ kind: "add", target: entry, messageId: message.id, subject })}
          className="flex flex-col rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-accent-soft"
        >
          <span className="font-semibold">{entry.number}</span>
          <span className="truncate text-xs text-ink-2">{entry.title}</span>
        </button>
      ))}
      {all.isSuccess && others.length === 0 && (
        <p className="m-0 px-2 py-1.5 text-xs text-ink-2">
          {text ? "Ningún expediente coincide." : "No hay otros expedientes."}
        </p>
      )}

      <div className="my-1 h-px bg-line-soft" />
      <button
        type="button"
        onClick={() => onAsk({ kind: "create", messageId: message.id, subject })}
        className="flex items-center gap-2 rounded-md border-0 bg-transparent px-2 py-2 text-left font-semibold text-accent hover:bg-accent-soft"
      >
        <Icon name="case" />
        Crear un expediente nuevo con este correo
      </button>
    </div>
  );
}

/** Qué correos de los pedidos están en algún expediente, y en cuáles. */
function useCaseLabels(messageIds: string[]): Map<string, string[]> {
  const ids = useMemo(() => [...messageIds].sort(), [messageIds]);
  const labels = useQuery({
    queryKey: [...KEY, "labels", ids],
    queryFn: () =>
      apiPost<{ labels: Record<string, string[]> }>(`${BASE}/labels`, {
        messageIds: ids.slice(0, 500),
      }),
    enabled: ids.length > 0,
    placeholderData: (previous) => previous,
  });
  return useMemo(() => new Map(Object.entries(labels.data?.labels ?? {})), [labels.data]);
}

export const expedientesPlugin: WebPlugin = {
  id: "expedientes",
  rail: { icon: "case", label: "Expedientes" },
  settings: [
    {
      id: "catalogos",
      group: "Expedientes",
      label: "Aseguradoras y tipos",
      description: "Las listas que se eligen al abrir o completar un expediente.",
      adminOnly: true,
      Component: Catalogs,
    },
  ],

  Page: ExpedientesPage,
  listFilters: [
    {
      id: "sin-expediente",
      label: "Sin expediente",
      useMatches(messageIds) {
        const labels = useCaseLabels(messageIds);
        return useMemo(
          () => new Set(messageIds.filter((id) => !labels.has(id))),
          [messageIds, labels],
        );
      },
    },
  ],
  useLabels: useCaseLabels,

  ToolbarAction({ message }) {
    const [open, setOpen] = useState(false);
    const current = useCasesOf(message.id);
    const changes = useCaseChanges();
    useEffect(() => setOpen(false), [message.id]);
    const mine = (current.data?.cases ?? []).map((entry) => entry.case);
    const label =
      mine.length === 0
        ? "Expediente"
        : mine.length === 1
          ? mine[0]!.number
          : `${mine.length} expedientes`;

    return (
      <span className="relative">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="Añadir este correo a un expediente, o quitarlo"
          className={`flex h-[30px] items-center gap-1.5 rounded-md px-2.5 font-semibold whitespace-nowrap ${
            mine.length > 0
              ? "border-0 bg-accent-soft text-accent-strong"
              : "border border-line-strong bg-panel text-ink hover:bg-ground"
          }`}
        >
          <Icon name="case" />
          {label}
          <Icon name="down" size={12} />
        </button>
        {open && (
          <CaseMenu
            message={message}
            current={mine}
            onClose={() => setOpen(false)}
            onAsk={(pending) => {
              setOpen(false);
              changes.ask(pending);
            }}
          />
        )}
        {changes.dialog}
      </span>
    );
  },

  ContextSection({ message, onSelect }) {
    const current = useCasesOf(message.id);
    const changes = useCaseChanges();
    const list = current.data?.cases ?? [];
    if (list.length === 0) return null;
    return (
      <>
        {list.map(({ case: item, messages }) => (
          <section key={item.id} className="flex flex-col gap-2">
            <h3 className="m-0 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
              Expediente
            </h3>
            <button
              type="button"
              onClick={() => openExpediente(item.id, message.id)}
              className="border-0 bg-transparent p-0 text-left font-semibold text-accent hover:text-accent-strong"
            >
              {item.number} · {item.title}
            </button>
            <InsurerSelect item={item} />
            <ContextMeter caseId={item.id} />
            {messages.map((entry) => (
              <MessageLine
                key={entry.id}
                entry={entry}
                caseId={item.id}
                current={entry.id === message.id}
                onSelect={onSelect}
              />
            ))}
          </section>
        ))}
        {changes.dialog}
      </>
    );
  },
};
