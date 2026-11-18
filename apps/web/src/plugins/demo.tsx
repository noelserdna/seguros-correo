import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, apiDelete, apiGet, apiPost, apiPut, type MessageDetail } from "../api.ts";
import { Confirm } from "../components/Confirm.tsx";
import { Icon } from "../components/Icon.tsx";
import { displayName, formatListDate } from "../format.ts";
import type { WebPlugin } from "./types.ts";

/**
 * Plugin de expedientes. Un expediente agrupa correos de cualquier buzón; un correo
 * puede estar en varios. Usa solo sus propias rutas y los huecos de la interfaz.
 */

type Case = {
  id: string;
  number: string;
  title: string;
  insurerId?: string | null;
  insurerName?: string | null;
};
type Insurer = { id: string; name: string; caseCount: number };
type CaseSummary = Case & { messageCount: number; lastMessageAt: string | null };
type CaseMessage = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: string;
  how: "manual" | "thread" | "reference";
  /** Sigue en el expediente, pero no cuenta como contexto. */
  excluded: boolean;
  mailbox: string;
};
type CaseWithMessages = { case: Case; messages: CaseMessage[] };

const BASE = "/plugins/demo";
const KEY = ["plugins", "demo"] as const;
const HOW: Record<string, string> = {
  manual: "añadido a mano",
  thread: "por conversación",
  reference: "por el número en el asunto",
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

const useInsurers = () =>
  useQuery({
    queryKey: [...KEY, "insurers"],
    queryFn: () => apiGet<{ insurers: Insurer[] }>(`${BASE}/insurers`),
  });

/** Lo que se va a hacer con un correo y un expediente, pendiente de confirmar. */
type Pending =
  | { kind: "add"; target: Case; messageId: string; subject: string }
  | { kind: "remove"; target: Case; messageId: string; subject: string }
  | { kind: "create"; messageId: string; subject: string };

/** Pide confirmación y ejecuta: añadir a un expediente, quitar de él o crear uno nuevo. */
function useCaseChanges() {
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
function ContextMeter({ caseId }: { caseId: string }) {
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

/** Apartado de Configuración: el catálogo de aseguradoras. */
function InsurerSettings({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const insurers = useInsurers();
  const [name, setName] = useState("");
  const [failed, setFailed] = useState("");
  const [removing, setRemoving] = useState<Insurer | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const fail = (error: unknown) =>
    setFailed(error instanceof ApiError ? error.message : "No se ha podido guardar el cambio.");

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setFailed("");
    apiPost(`${BASE}/insurers`, { name })
      .then(() => {
        setName("");
        return refresh();
      })
      .catch(fail);
  };
  const remove = () => {
    if (!removing) return;
    apiDelete(`${BASE}/insurers/${removing.id}`)
      .then(() => {
        setRemoving(null);
        return refresh();
      })
      .catch((error: unknown) => {
        setRemoving(null);
        fail(error);
      });
  };
  const list = insurers.data?.insurers ?? [];

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold">Aseguradoras</h2>
        <p className="m-0 text-xs leading-normal text-ink-2">
          Las que aparecen en el desplegable «Aseguradora» de cada expediente.
        </p>
      </div>
      {isAdmin && (
        <form onSubmit={add} className="flex gap-2">
          <label htmlFor="nueva-aseguradora" className="sr-only">
            Nombre de la aseguradora
          </label>
          <input
            id="nueva-aseguradora"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nombre de la aseguradora"
            className="h-9 min-w-0 grow rounded-md border border-line-strong bg-panel px-2.5 text-[13px] text-ink"
          />
          <button
            type="submit"
            className="h-9 rounded-md border-0 bg-accent px-3.5 font-semibold text-white"
          >
            Añadir
          </button>
        </form>
      )}
      {failed && (
        <p role="alert" className="m-0 text-xs text-bad-ink">
          {failed}
        </p>
      )}
      {insurers.isSuccess && list.length === 0 && (
        <p className="m-0 text-xs text-ink-2">Todavía no hay ninguna.</p>
      )}
      <ul className="m-0 flex list-none flex-col p-0">
        {list.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-3 border-t border-line-soft py-2 first:border-t-0"
          >
            <span className="min-w-0 grow truncate">{entry.name}</span>
            <span className="text-xs whitespace-nowrap text-ink-2">
              {entry.caseCount === 1 ? "1 expediente" : `${entry.caseCount} expedientes`}
            </span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setRemoving(entry)}
                className="h-7 rounded-md border border-line-strong bg-panel px-2 text-xs font-semibold text-ink hover:bg-ground"
              >
                Quitar
              </button>
            )}
          </li>
        ))}
      </ul>
      {removing && (
        <Confirm
          title={`¿Quitar «${removing.name}» de las aseguradoras?`}
          confirmLabel="Quitar aseguradora"
          danger
          onConfirm={remove}
          onCancel={() => setRemoving(null)}
        >
          <p className="m-0">
            {removing.caseCount === 0
              ? "Ningún expediente la tiene asignada."
              : removing.caseCount === 1
                ? "Hay 1 expediente que la tiene asignada: se quedará sin aseguradora. El expediente y sus correos no se tocan."
                : `Hay ${removing.caseCount} expedientes que la tienen asignada: se quedarán sin aseguradora. Los expedientes y sus correos no se tocan.`}
          </p>
        </Confirm>
      )}
    </section>
  );
}

/** Menú de la barra: en qué expedientes está el correo, y añadirlo a otro o a uno nuevo. */
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
  const inside = new Set(current.map((entry) => entry.id));
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

export const demoPlugin: WebPlugin = {
  id: "demo",
  rail: { icon: "case", label: "Expedientes" },
  SettingsSection: InsurerSettings,

  View({ selectedId, onSelect }) {
    const [openId, setOpenId] = useState<string | null>(null);
    const cases = useAllCases();
    const detail = useQuery({
      queryKey: [...KEY, "case", openId],
      queryFn: () => apiGet<CaseWithMessages>(`${BASE}/cases/${openId}`),
      enabled: Boolean(openId),
    });
    const changes = useCaseChanges();
    const list = cases.data?.cases ?? [];

    return (
      <section
        aria-label="Expedientes"
        className="flex w-full flex-col bg-panel md:w-[300px] md:shrink-0 md:border-r md:border-line lg:w-[360px]"
      >
        <div className="border-b border-line px-3 pt-3 pb-2.5">
          <h2 className="m-0 text-[15px] font-semibold">Expedientes</h2>
        </div>
        <div className="min-h-0 grow overflow-y-auto">
          {cases.isSuccess && list.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Icon name="case" size={28} className="text-ink-2" />
              <h3 className="m-0 text-sm font-semibold">Todavía no hay expedientes</h3>
              <p className="m-0 text-xs leading-normal text-ink-2">
                Abre un correo y pulsa «Expediente» en su barra para crear uno o añadirlo a uno que
                ya exista.
              </p>
            </div>
          )}
          {list.map((item) => {
            const open = item.id === openId;
            return (
              <div key={item.id} className="border-b border-line-soft">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : item.id)}
                  className={`flex w-full flex-col gap-0.5 border-0 border-l-[3px] px-3 py-2.5 text-left text-ink ${
                    open
                      ? "border-l-accent bg-accent-soft"
                      : "border-l-transparent bg-panel hover:bg-ground"
                  }`}
                >
                  <span className="flex gap-2">
                    <span className="font-semibold">{item.number}</span>
                    <span className="grow" />
                    <span className="text-xs text-ink-2">
                      {item.lastMessageAt ? formatListDate(item.lastMessageAt) : ""}
                    </span>
                  </span>
                  <span className="truncate">{item.title}</span>
                  <span className="text-xs text-ink-2">
                    {item.messageCount === 1 ? "1 correo" : `${item.messageCount} correos`}
                  </span>
                </button>
                {open && (
                  <div className="flex flex-col gap-1.5 bg-ground px-3 py-2.5">
                    <InsurerSelect item={item} />
                    <ContextMeter caseId={item.id} />
                    {(detail.data?.messages ?? []).map((entry) => (
                      <MessageLine
                        key={entry.id}
                        entry={entry}
                        caseId={item.id}
                        current={entry.id === selectedId}
                        onSelect={onSelect}
                      />
                    ))}
                    {detail.isSuccess && detail.data.messages.length === 0 && (
                      <p className="m-0 text-xs text-ink-2">
                        Este expediente no tiene correos. Añádelos desde la barra de cualquier
                        correo.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {changes.dialog}
      </section>
    );
  },

  useLabels(messageIds) {
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
  },

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
            <span className="font-semibold">
              {item.number} · {item.title}
            </span>
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
