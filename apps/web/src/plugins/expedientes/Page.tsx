/**
 * La página de Expedientes: «encontrar y entender». A la izquierda, la lista con su buscador
 * (número, matrícula, cliente, teléfono, nº de siniestro) y filtros; a la derecha, el caso con
 * sus datos y su historia de correos. Al pulsar un correo se lee al lado, sin salir del caso.
 * La dirección guarda el expediente elegido (t=c:<id>) y el correo abierto (m).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiGet, apiPost, apiPut, ApiError } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { ReadingPane } from "../../components/ReadingPane.tsx";
import { Field, settingsButton, settingsField } from "../../components/settings.tsx";
import { composeFromPage } from "../../compose.ts";
import { displayName, formatListDate } from "../../format.ts";
import { navigate, useUrlState } from "../../url-state.ts";
// Se usa al pintar, no al cargar: la referencia circular con el índice no molesta.
import {
  BASE,
  HOW,
  KEY,
  useCaseChanges,
  useInsurers,
  ContextMeter,
  type CaseMessage,
  type CaseSummary,
} from "../expedientes.tsx";
import { plugins } from "../index.ts";

type Filter = "abiertos" | "mios" | "sin-plan" | "cerrados";
type Detail = { case: CaseSummary; messages: CaseMessage[] };

const ROLE_LABEL: Record<string, string> = {
  cliente: "Cliente",
  aseguradora: "Aseguradora",
  perito: "Perito",
  taller: "Taller",
  abogado: "Abogado",
  policia: "Policía",
  medico: "Médico",
  grua: "Grúa",
  otro: "Otro",
};
const CLOSE_LABEL: Record<string, string> = {
  pagado: "pagado",
  rehusado: "rehusado",
  desistido: "desistido",
  judicializado: "judicializado",
  duplicado: "duplicado",
};

export const openExpediente = (caseId: string, messageId: string | null = null) =>
  navigate({
    view: "plugin",
    pluginId: "expedientes",
    sub: `c:${caseId}`,
    messageId,
    composeId: null,
  });

const tramitacionActive = () => plugins.some((plugin) => plugin.id === "tramitacion");

function filterParams(filter: Filter, q: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (filter === "cerrados") params.set("status", "cerrado");
  else if (q) params.set("status", "todos");
  else params.set("status", "abierto");
  if (filter === "mios") params.set("mine", "1");
  if (filter === "sin-plan") params.set("noPlan", "1");
  return params.toString();
}

/** Pantalla de teléfono: la historia va en dos líneas por correo. */
function useNarrow(): boolean {
  const query = "(max-width: 767px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return narrow;
}

/** Espera a que se deje de escribir para buscar. */
function useDebounced(value: string, ms = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Quién escribe y con qué papel: el cliente, una aseguradora, nosotros… */
function WhoTag({ entry }: { entry: CaseMessage }) {
  const ours = entry.direction === "out";
  const label = ours ? "Nosotros" : entry.role ? (ROLE_LABEL[entry.role] ?? entry.role) : null;
  if (!label) return null;
  const look = ours
    ? "border border-dashed border-line-strong bg-panel text-ink-2"
    : entry.role === "cliente"
      ? "bg-accent-soft text-accent-strong"
      : "border border-line bg-ground text-ink";
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[10.5px] font-semibold whitespace-nowrap ${look}`}
    >
      {label}
    </span>
  );
}

// ------------------------------------------------------------------ lista

function CaseList({ selectedId }: { selectedId: string | null }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("abiertos");
  const search = useDebounced(q.trim());
  const cases = useQuery({
    queryKey: [...KEY, "list", filter, search],
    queryFn: () =>
      apiGet<{ cases: CaseSummary[] }>(`${BASE}/cases?${filterParams(filter, search)}`),
    placeholderData: (previous) => previous,
  });
  // Lo que aportan otros módulos a cada fila (la tramitación: salud y fase).
  const lines = plugins.map((plugin) => plugin.useCaseLines?.() ?? null);
  const lineOf = (id: string) => lines.map((map) => map?.get(id)).find(Boolean);
  const filters: { id: Filter; label: string }[] = [
    { id: "abiertos", label: "Abiertos" },
    { id: "mios", label: "Míos" },
    ...(tramitacionActive() ? [{ id: "sin-plan" as const, label: "Sin plan" }] : []),
    { id: "cerrados", label: "Cerrados" },
  ];
  const list = cases.data?.cases ?? [];
  return (
    <section
      aria-label="Expedientes"
      className={`${selectedId ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-line bg-panel md:w-[340px] md:border-r lg:w-[380px]`}
    >
      <div className="flex flex-col gap-2.5 border-b border-line px-3.5 pt-3.5 pb-2.5">
        <h1 className="m-0 text-[15px] font-semibold">Expedientes</h1>
        <label className="flex h-[34px] items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-ink-2 focus-within:border-accent">
          <Icon name="search" size={14} />
          <span className="sr-only">Buscar expedientes</span>
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Número, matrícula, cliente, nº de siniestro…"
            className="min-w-0 grow border-0 bg-transparent text-[13px] text-ink outline-none"
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {filters.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
              className={`h-[26px] rounded-full border px-2.5 text-xs whitespace-nowrap ${filter === entry.id ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line-strong bg-panel text-ink hover:bg-ground"}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      {search && cases.isSuccess && (
        <p className="m-0 border-b border-line-soft bg-ground px-3.5 py-2 text-xs text-ink-2">
          {list.length === 1 ? "1 expediente" : `${list.length} expedientes`} para «{search}»,
          abiertos y cerrados. Busca también por teléfono y correo del cliente y por quien ha
          escrito.
        </p>
      )}
      <div className="min-h-0 grow overflow-y-auto">
        {cases.isError && (
          <p role="alert" className="m-0 p-4 text-xs text-bad-ink">
            No se han podido cargar los expedientes.
          </p>
        )}
        {cases.isSuccess && list.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Icon name="case" size={28} className="text-ink-2" />
            <b className="text-sm font-semibold">
              {search ? "Ningún expediente coincide" : "No hay expedientes aquí"}
            </b>
            <span className="text-xs leading-normal text-ink-2">
              Los expedientes se crean desde un correo: «Tramitar», o «Expediente» en su barra.
            </span>
          </div>
        )}
        {list.map((item) => {
          const on = item.id === selectedId;
          const extra = lineOf(item.id);
          return (
            <button
              key={item.id}
              type="button"
              aria-current={on ? "true" : undefined}
              onClick={() => openExpediente(item.id)}
              className={`flex w-full flex-col gap-0.5 border-0 border-b border-l-[3px] border-b-line-soft px-3.5 py-2.5 text-left text-ink ${on ? "border-l-accent bg-accent-soft" : "border-l-transparent bg-panel hover:bg-ground"}`}
            >
              <span className="flex items-center gap-2">
                <b className="font-semibold">{item.number}</b>
                {(item.newCount ?? 0) > 0 && (
                  <span className="inline-flex h-[18px] items-center rounded-full bg-accent px-1.5 text-[11px] font-bold text-white">
                    {item.newCount === 1 ? "1 nuevo" : `${item.newCount} nuevos`}
                  </span>
                )}
                <span className="grow" />
                <span className="text-xs text-ink-2">
                  {item.lastMessageAt ? formatListDate(item.lastMessageAt) : ""}
                </span>
              </span>
              <span className="truncate">{item.title}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-ink-2">
                {item.status === "cerrado" ? (
                  <span>
                    Cerrado
                    {item.closeReason
                      ? ` · ${CLOSE_LABEL[item.closeReason] ?? item.closeReason}`
                      : ""}
                  </span>
                ) : extra ? (
                  <span className="min-w-0 truncate text-ink">{extra}</span>
                ) : item.hasPlan === false ? (
                  <span>Sin plan</span>
                ) : null}
                {(item.clientName || item.insurerName) && (
                  <span className="min-w-0 truncate">
                    · {[item.clientName, item.insurerName].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ historia del caso

function RowMenu({
  entry,
  item,
  onAsk,
}: {
  entry: CaseMessage;
  item: CaseSummary;
  onAsk: ReturnType<typeof useCaseChanges>["ask"];
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const toggle = () =>
    void apiPut(`${BASE}/cases/${item.id}/messages/${entry.id}`, {
      excluded: !entry.excluded,
    }).then(() => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: KEY });
    });
  const subject = entry.subject || "(sin asunto)";
  const itemClass =
    "flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[13px] text-ink hover:bg-ground";
  return (
    <span ref={box} className="relative flex shrink-0">
      <button
        type="button"
        aria-label={`Más acciones: ${subject}`}
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        className="flex size-7 items-center justify-center rounded-md border-0 bg-transparent text-ink-2 hover:bg-ground hover:text-ink"
      >
        <Icon name="more" size={14} />
      </button>
      {open && (
        <span
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 flex w-[300px] flex-col rounded-lg border border-line-strong bg-panel p-1.5 shadow-[0_8px_24px_rgba(27,35,48,0.16)]"
        >
          <span className="border-b border-line-soft px-2.5 pt-1 pb-2 text-xs text-ink-2">
            Cómo entró: {HOW[entry.how] ?? entry.how} · buzón {entry.mailbox}
          </span>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() =>
              navigate({
                view: "mail",
                pluginId: null,
                sub: null,
                accountId: entry.accountId ?? null,
                folderId: null,
                messageId: entry.id,
              })
            }
          >
            <Icon name="mail" size={14} />
            Abrir en el buzón
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={toggle}>
            <Icon name={entry.excluded ? "eye" : "eyeOff"} size={14} />
            {entry.excluded
              ? "Volver a usarlo para el resumen y la IA"
              : "No usarlo para el resumen ni la IA"}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${itemClass} text-bad-ink`}
            onClick={() => {
              setOpen(false);
              onAsk({ kind: "remove", target: item, messageId: entry.id, subject });
            }}
          >
            <Icon name="close" size={14} />
            Quitar del expediente, con su conversación
          </button>
        </span>
      )}
    </span>
  );
}

type HistoryFilter = "todo" | "cliente" | "terceros" | "nosotros" | "whatsapp";

function History({
  item,
  messages,
  selectedId,
  compact,
}: {
  item: CaseSummary;
  messages: CaseMessage[];
  selectedId: string | null;
  compact: boolean;
}) {
  const [filter, setFilter] = useState<HistoryFilter>("todo");
  const changes = useCaseChanges();
  const narrow = useNarrow();
  compact = compact || narrow;
  // Lo más reciente arriba: es lo que se busca cuando llaman.
  const ordered = useMemo(() => [...messages].reverse(), [messages]);
  const visible = ordered.filter((entry) =>
    filter === "cliente"
      ? entry.direction !== "out" && entry.role === "cliente"
      : filter === "terceros"
        ? entry.direction !== "out" && Boolean(entry.role) && entry.role !== "cliente"
        : filter === "nosotros"
          ? entry.direction === "out"
          : filter === "whatsapp"
            ? entry.whatsapp
            : true,
  );
  const files = messages.reduce((sum, entry) => sum + (entry.files ?? 0), 0);
  const fresh = messages.filter((entry) => entry.isNew).length;
  const withRoles = messages.some((entry) => entry.role);
  const options: { id: HistoryFilter; label: string }[] = [
    { id: "todo", label: "Todo" },
    ...(withRoles
      ? [
          { id: "cliente" as const, label: "Cliente" },
          { id: "terceros" as const, label: "Aseguradora y peritos" },
        ]
      : []),
    { id: "nosotros", label: "Nosotros" },
    ...(messages.some((entry) => entry.whatsapp)
      ? [{ id: "whatsapp" as const, label: "WhatsApp" }]
      : []),
  ];
  return (
    <section aria-label="Historia del expediente" className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pt-4 pb-2">
        <h2 className="m-0 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
          Historia
        </h2>
        <span className="text-xs text-ink-2">
          {messages.length === 1 ? "1 correo" : `${messages.length} correos`}
          {files > 0 && ` · ${files === 1 ? "1 adjunto" : `${files} adjuntos`}`}
          {fresh > 0 && ` · ${fresh === 1 ? "1 nuevo" : `${fresh} nuevos`}`}
        </span>
        <span className="grow" />
        {!compact && options.length > 1 && (
          <span className="flex flex-wrap gap-1.5">
            {options.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={filter === entry.id}
                onClick={() => setFilter(entry.id)}
                className={`h-[26px] rounded-full border px-2.5 text-xs whitespace-nowrap ${filter === entry.id ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line-strong bg-panel text-ink hover:bg-ground"}`}
              >
                {entry.label}
              </button>
            ))}
          </span>
        )}
      </div>
      <ul
        className={`m-0 mb-6 list-none overflow-hidden rounded-lg border border-line p-0 ${compact ? "mx-3" : "mx-6"}`}
      >
        {visible.map((entry) => {
          const on = entry.id === selectedId;
          // Sin la empresa: el papel ya va en su etiqueta y así cabe el nombre.
          const who = displayName(entry.fromName, entry.fromAddress).split(" · ")[0]!;
          const text =
            entry.whatsapp && entry.snippet ? entry.snippet : entry.subject || "(sin asunto)";
          return (
            <li
              key={entry.id}
              className={`flex items-center gap-2 border-b border-line-soft last:border-b-0 ${on ? "bg-accent-soft" : "bg-panel hover:bg-ground"} ${entry.excluded ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                aria-current={on ? "true" : undefined}
                onClick={() => openExpediente(item.id, entry.id)}
                className={`flex min-w-0 grow border-0 bg-transparent py-2 pl-3 text-left text-ink ${compact ? "flex-col gap-0.5" : "items-center gap-2.5"}`}
              >
                <span
                  className={`flex min-w-0 items-center gap-2 ${compact ? "" : "w-[320px] shrink-0"}`}
                >
                  <span
                    aria-label={entry.isNew ? "Nuevo" : undefined}
                    className={`size-2 shrink-0 rounded-full ${entry.isNew ? "bg-accent" : ""}`}
                  />
                  {!compact && (
                    <span className="w-[74px] shrink-0 text-xs whitespace-nowrap text-ink-2">
                      {formatListDate(entry.internalDate)}
                    </span>
                  )}
                  <Icon
                    name={entry.whatsapp ? "chat" : "mail"}
                    size={13}
                    className="shrink-0 text-ink-2"
                  />
                  <b className={`min-w-0 truncate ${entry.isNew ? "font-bold" : "font-semibold"}`}>
                    {who}
                  </b>
                  <WhoTag entry={entry} />
                  {compact && (
                    <span className="ml-auto shrink-0 pl-2 text-xs whitespace-nowrap text-ink-2">
                      {formatListDate(entry.internalDate)}
                    </span>
                  )}
                </span>
                <span
                  className={`min-w-0 truncate ${compact ? "pl-4 text-xs" : "grow"} ${entry.isNew ? "font-semibold" : ""} ${entry.excluded ? "line-through" : ""}`}
                >
                  {text}
                </span>
                {!compact && (entry.files ?? 0) > 0 && (
                  <span className="flex shrink-0 items-center gap-0.5 text-xs text-ink-2">
                    <Icon name="clip" size={12} />
                    {entry.files}
                  </span>
                )}
              </button>
              <span className="pr-1.5">
                <RowMenu entry={entry} item={item} onAsk={changes.ask} />
              </span>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="px-3 py-4 text-xs text-ink-2">
            {messages.length === 0
              ? "Este expediente no tiene correos. Añádelos desde la barra de cualquier correo."
              : "Ningún correo con este filtro."}
          </li>
        )}
      </ul>
      {changes.dialog}
    </section>
  );
}

// ------------------------------------------------------------------ datos

function DataDrawer({ item, onClose }: { item: CaseSummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const insurers = useInsurers();
  const types = useQuery({
    queryKey: [...KEY, "case-types"],
    queryFn: () => apiGet<{ caseTypes: { id: string; name: string }[] }>(`${BASE}/case-types`),
  });
  const people = useQuery({
    queryKey: ["plugins", "tramitacion", "people-of", item.accountId],
    queryFn: () =>
      apiGet<{ people: { id: string; name: string }[] }>(
        `/plugins/tramitacion/people?accountId=${item.accountId}`,
      ),
    enabled: tramitacionActive() && Boolean(item.accountId),
  });
  const [form, setForm] = useState({
    title: item.title,
    insurerId: item.insurerId ?? "",
    claimRef: item.claimRef ?? "",
    lossDate: item.lossDate ?? "",
    caseTypeId: item.caseTypeId ?? "",
    ownerId: item.ownerId ?? "",
  });
  const save = useMutation({
    mutationFn: () =>
      apiPut(`${BASE}/cases/${item.id}`, {
        title: form.title.trim(),
        insurerId: form.insurerId || null,
        claimRef: form.claimRef.trim() || null,
        lossDate: form.lossDate || null,
        caseTypeId: form.caseTypeId || null,
        ...(tramitacionActive() ? { ownerId: form.ownerId || null } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (form.title.trim()) save.mutate();
  };
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="grow border-0 bg-transparent"
      />
      <form
        aria-label="Datos del expediente"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        className="flex h-full w-full max-w-[420px] flex-col bg-panel shadow-[-8px_0_24px_rgba(27,35,48,0.12)]"
      >
        <div className="flex items-center px-5 pt-5 pb-3">
          <h2 className="m-0 grow text-base font-semibold">Datos del expediente</h2>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-md border-0 bg-transparent text-ink hover:bg-ground"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="flex grow flex-col gap-3.5 overflow-y-auto px-5 py-1">
          <Field label="Título">
            <input
              autoFocus
              required
              value={form.title}
              onChange={(event) => set({ title: event.target.value })}
              className={settingsField}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Aseguradora">
              <select
                value={form.insurerId}
                onChange={(event) => set({ insurerId: event.target.value })}
                className={settingsField}
              >
                <option value="">Sin indicar</option>
                {insurers.data?.insurers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nº de siniestro">
              <input
                value={form.claimRef}
                onChange={(event) => set({ claimRef: event.target.value })}
                className={settingsField}
              />
            </Field>
            <Field label="Fecha del siniestro">
              <input
                type="date"
                value={form.lossDate}
                onChange={(event) => set({ lossDate: event.target.value })}
                className={settingsField}
              />
            </Field>
            <Field label="Tipo">
              <select
                value={form.caseTypeId}
                onChange={(event) => set({ caseTypeId: event.target.value })}
                className={settingsField}
              >
                <option value="">Sin tipo</option>
                {types.data?.caseTypes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {tramitacionActive() && (
            <Field
              label="Gestor"
              hint="Quien lo lleva. Lo ven todos los que tienen acceso al buzón."
            >
              <select
                value={form.ownerId}
                onChange={(event) => set({ ownerId: event.target.value })}
                className={settingsField}
              >
                <option value="">Sin asignar</option>
                {people.data?.people.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <p className="m-0 text-xs leading-normal text-ink-2">
            El cliente se elige en su bloque, debajo de los datos: viene de la agenda de contactos.
          </p>
          {save.isError && (
            <p role="alert" className="m-0 text-xs text-bad-ink">
              {save.error instanceof ApiError ? save.error.message : "No se ha podido guardar."}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button type="button" onClick={onClose} className={settingsButton.secondary}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!form.title.trim() || save.isPending}
            className={settingsButton.primary}
          >
            Guardar
          </button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ el caso

function CaseView({ caseId, messageId }: { caseId: string; messageId: string | null }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: [...KEY, "case", caseId],
    queryFn: () => apiGet<Detail>(`${BASE}/cases/${caseId}`),
  });
  // Lo que había al abrirlo deja de ser nuevo (los puntos se ven en esta visita).
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!detail.data || marked.current === caseId) return;
    marked.current = caseId;
    void apiPost(`${BASE}/cases/${caseId}/seen`, {}).then(() =>
      queryClient.invalidateQueries({ queryKey: [...KEY, "list"] }),
    );
  }, [detail.data, caseId, queryClient]);

  if (detail.isError) {
    return (
      <main className="flex grow flex-col items-center justify-center gap-2 bg-panel p-8 text-center">
        <b className="font-semibold">No se ha encontrado el expediente</b>
        <button
          type="button"
          className={settingsButton.secondary}
          onClick={() => navigate({ sub: null, messageId: null })}
        >
          Volver a la lista
        </button>
      </main>
    );
  }
  if (!detail.data)
    return <main className="grow bg-panel p-6 text-ink-2">Cargando el expediente…</main>;
  const { case: item, messages } = detail.data;
  const meta = (label: string, value: string | null | undefined) =>
    value ? (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[11px] text-ink-2">{label}</span>
        <span className="truncate font-semibold">{value}</span>
      </span>
    ) : null;
  const sections = plugins.filter((plugin) => plugin.CaseSection);
  return (
    <main className="flex min-h-0 min-w-0 grow flex-col overflow-y-auto bg-panel">
      <header className="flex flex-col gap-3 border-b border-line px-6 pt-4 pb-3.5">
        <div className="flex items-start gap-3">
          <button
            type="button"
            aria-label="Volver a la lista"
            onClick={() => navigate({ sub: null, messageId: null })}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-ink hover:bg-ground md:hidden"
          >
            <Icon name="back" />
          </button>
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <span className="text-xs text-ink-2">
              {item.number}
              {item.createdAt &&
                ` · abierto el ${new Date(item.createdAt).toLocaleDateString("es-ES")}`}
              {item.typeName && ` · ${item.typeName}`}
              {item.status === "cerrado" &&
                ` · cerrado${item.closeReason ? `, ${CLOSE_LABEL[item.closeReason] ?? item.closeReason}` : ""}`}
            </span>
            <h2 className="m-0 text-[19px] font-semibold tracking-[-0.01em]">{item.title}</h2>
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={settingsButton.secondary}
          >
            Editar datos
          </button>
        </div>
        <div className="flex flex-wrap gap-x-7 gap-y-2 text-[13px]">
          {meta("Aseguradora", item.insurerName)}
          {meta("Nº de siniestro", item.claimRef)}
          {meta(
            "Fecha del siniestro",
            item.lossDate
              ? new Date(`${item.lossDate}T12:00:00`).toLocaleDateString("es-ES")
              : null,
          )}
          {meta("Gestor", item.ownerName)}
          {!item.insurerName && !item.claimRef && !item.lossDate && !item.ownerName && (
            <span className="text-xs text-ink-2">
              Sin datos todavía: «Editar datos» para completarlos.
            </span>
          )}
        </div>
        {/* Lo que reúne el expediente para resumirlo o preguntarle: correos, adjuntos y su texto. */}
        <ContextMeter caseId={item.id} />
      </header>
      {sections.length > 0 && (
        <div className="grid grid-cols-1 gap-2.5 px-6 pt-3.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
          {sections.map(
            (plugin) =>
              plugin.CaseSection && <plugin.CaseSection key={plugin.id} caseId={item.id} wide />,
          )}
        </div>
      )}
      {messageId ? (
        <div className="flex min-h-[560px] grow border-t border-line mt-4">
          <div className="hidden w-[400px] shrink-0 overflow-y-auto border-r border-line lg:block">
            <History item={item} messages={messages} selectedId={messageId} compact />
          </div>
          <div className="flex min-w-0 grow flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
              <button
                type="button"
                onClick={() => navigate({ messageId: null })}
                className="flex items-center gap-1 border-0 bg-transparent text-[13px] font-semibold text-accent"
              >
                <Icon name="back" size={14} />
                Historia
              </button>
            </div>
            <div className="flex min-h-0 grow">
              <ReadingPane
                messageId={messageId}
                folderId={null}
                onSelect={(id) => openExpediente(item.id, id)}
                onCompose={(kind, source) => void composeFromPage(kind, source)}
              />
            </div>
          </div>
        </div>
      ) : (
        <History item={item} messages={messages} selectedId={null} compact={false} />
      )}
      {editing && <DataDrawer item={item} onClose={() => setEditing(false)} />}
    </main>
  );
}

// ------------------------------------------------------------------ página

export function ExpedientesPage() {
  const { sub, messageId } = useUrlState();
  const caseId = sub?.startsWith("c:") ? sub.slice(2) : null;
  return (
    <div className="flex min-h-0 min-w-0 grow">
      <CaseList selectedId={caseId} />
      {caseId ? (
        <CaseView key={caseId} caseId={caseId} messageId={messageId} />
      ) : (
        <main className="hidden grow flex-col items-center justify-center gap-2.5 bg-panel p-8 text-center text-ink-2 md:flex">
          <Icon name="case" size={30} />
          <b className="text-sm font-semibold text-ink">Elige un expediente</b>
          <span className="max-w-[380px] text-[13px] leading-normal">
            Para encontrar uno cuando llaman: escribe la matrícula, el nombre o el teléfono del
            cliente, o el nº de siniestro de la aseguradora.
          </span>
        </main>
      )}
    </div>
  );
}
