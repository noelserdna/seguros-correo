/** Ficha de un expediente en tramitación: fases, siguiente paso, tareas, esperas y correos. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet, ApiError } from "../../api.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { Icon } from "../../components/Icon.tsx";
import { ReadingPane } from "../../components/ReadingPane.tsx";
import { navigate } from "../../url-state.ts";
import {
  BASE,
  KEY,
  roleLabel,
  tramitacion,
  useApplyView,
  useCase,
  type CaseView,
  type Contact,
  type Task,
} from "./api.ts";
import { startChase } from "./actions.ts";
import { daysBetween, nextStepText, shortDay, taskStatusText } from "./logic.ts";
import {
  Avatar,
  buttonClass,
  Chip,
  DueCell,
  fieldClass,
  HealthBadge,
  PhaseBar,
  StateIcon,
} from "./pieces.tsx";

type CaseMessage = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: string;
  excluded: boolean;
};
type Filter = "todas" | "pendientes" | "mias";
const CLOSE_REASONS = [
  { id: "pagado", label: "Pagado" },
  { id: "rehusado", label: "Rehusado" },
  { id: "desistido", label: "Desistido" },
  { id: "judicializado", label: "Judicializado" },
  { id: "duplicado", label: "Duplicado" },
];
const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : "No se ha podido guardar.";

/** Hace un cambio y pinta el expediente que devuelve el servidor. */
function useCaseChange() {
  const apply = useApplyView();
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (run: () => Promise<CaseView>) => run(),
    onSuccess: (view) => {
      setError("");
      apply(view);
    },
    onError: (failure) => setError(errorText(failure)),
  });
  return {
    run: (fn: () => Promise<CaseView>) => mutation.mutate(fn),
    busy: mutation.isPending,
    error,
    clear: () => setError(""),
  };
}

// ------------------------------------------------------------------ esperas

function WaitPopover({
  task,
  onSave,
  onClose,
}: {
  task: Task;
  onSave: (body: object) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<{
    contactId?: string;
    client?: boolean;
    label: string;
  } | null>(task.waitsOnRole === "cliente" ? { client: true, label: "El cliente" } : null);
  const [chaseAt, setChaseAt] = useState("");
  const [adding, setAdding] = useState(false);
  const [newContact, setNewContact] = useState({ name: "", email: "" });
  const role =
    task.waitsOnRole && task.waitsOnRole !== "cliente"
      ? task.waitsOnRole.replace("_contraria", "")
      : undefined;
  const contacts = useQuery({
    queryKey: [...KEY, "contacts", q, role ?? ""],
    queryFn: () =>
      apiGet<{ contacts: Contact[] }>(
        `${BASE}/contacts?${new URLSearchParams({ ...(q ? { q } : {}), ...(role && !q ? { role } : {}) })}`,
      ),
  });
  const add = useMutation({
    mutationFn: () =>
      tramitacion.addContact({
        role: role ?? "otro",
        name: newContact.name,
        email: newContact.email || null,
      }),
    onSuccess: ({ contact }) => {
      setChosen({ contactId: contact.id, label: contact.name });
      setAdding(false);
    },
  });

  return (
    <div
      role="dialog"
      aria-label="Esperando a…"
      className="absolute top-full right-0 z-30 mt-1 flex w-[340px] flex-col gap-2.5 rounded-lg border border-line-strong bg-panel p-3.5 text-left shadow-[0_8px_24px_rgba(27,35,48,0.16)]"
    >
      <b className="font-semibold">Esperando a…</b>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-semibold">A quién</span>
        <input
          autoFocus
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Buscar en el directorio"
          className={fieldClass}
        />
      </label>
      <div className="flex max-h-48 flex-col overflow-y-auto rounded-md border border-line text-[13px]">
        <span className="bg-ground px-2.5 py-1 text-[11px] font-semibold text-ink-2">CLIENTE</span>
        <button
          type="button"
          onClick={() => setChosen({ client: true, label: "El cliente" })}
          className={`border-0 px-2.5 py-1.5 text-left ${chosen?.client ? "bg-accent-soft font-semibold text-accent-strong" : "bg-panel hover:bg-ground"}`}
        >
          El cliente
        </button>
        <span className="bg-ground px-2.5 py-1 text-[11px] font-semibold text-ink-2">
          DIRECTORIO{role && !q ? ` · ${roleLabel(role).toUpperCase()}` : ""}
        </span>
        {contacts.data?.contacts.map((contact) => (
          <button
            key={contact.id}
            type="button"
            onClick={() => setChosen({ contactId: contact.id, label: contact.name })}
            className={`border-0 px-2.5 py-1.5 text-left ${chosen?.contactId === contact.id ? "bg-accent-soft font-semibold text-accent-strong" : "bg-panel hover:bg-ground"}`}
          >
            {contact.name}{" "}
            <span className="text-xs font-normal text-ink-2">· {roleLabel(contact.role)}</span>
          </button>
        ))}
        {contacts.data?.contacts.length === 0 && (
          <span className="px-2.5 py-1.5 text-xs text-ink-2">Nadie con ese nombre.</span>
        )}
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setNewContact({ name: q, email: "" });
            }}
            className="border-0 bg-panel px-2.5 py-1.5 text-left font-semibold text-accent hover:bg-ground"
          >
            + Añadir al directorio
          </button>
        ) : (
          <div className="flex flex-col gap-1.5 border-t border-line p-2">
            <input
              value={newContact.name}
              onChange={(event) => setNewContact({ ...newContact, name: event.target.value })}
              placeholder="Nombre"
              className={fieldClass}
            />
            <input
              value={newContact.email}
              onChange={(event) => setNewContact({ ...newContact, email: event.target.value })}
              placeholder="Correo (sirve para reconocerle)"
              className={fieldClass}
            />
            {add.isError && (
              <span role="alert" className="text-xs text-bad-ink">
                {errorText(add.error)}
              </span>
            )}
            <button
              type="button"
              disabled={!newContact.name.trim() || add.isPending}
              onClick={() => add.mutate()}
              className={buttonClass.small}
            >
              Añadir {role ? `como ${roleLabel(role).toLowerCase()}` : ""}
            </button>
          </div>
        )}
      </div>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-semibold">Reclamar el</span>
        <input
          type="date"
          value={chaseAt}
          onChange={(event) => setChaseAt(event.target.value)}
          className={fieldClass}
        />
        <span className="text-ink-2">
          {chaseAt
            ? ""
            : task.chaseDays
              ? `Si lo dejas vacío: ${task.chaseDays} días hábiles, como dice la plantilla.`
              : "Si lo dejas vacío: dentro de 7 días."}
        </span>
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={buttonClass.secondary}>
          Cancelar
        </button>
        <button
          type="button"
          disabled={!chosen}
          onClick={() =>
            onSave({
              waiting: {
                ...(chosen?.client ? { client: true } : { contactId: chosen?.contactId }),
                ...(chaseAt ? { chaseAt } : {}),
              },
            })
          }
          className={buttonClass.primary}
        >
          Guardar espera
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fila de tarea

function TaskMenu({
  task,
  view,
  change,
  onClose,
}: {
  task: Task;
  view: CaseView;
  change: ReturnType<typeof useCaseChange>;
  onClose: () => void;
}) {
  const people = useQuery({
    queryKey: [...KEY, "people", view.case.id],
    queryFn: () =>
      apiGet<{ people: { id: string; name: string }[] }>(`${BASE}/people?caseId=${view.case.id}`),
  });
  const [note, setNote] = useState("");
  const [skip, setSkip] = useState(false);
  const patch = (body: object) => {
    change.run(() => tramitacion.patchTask(task.id, body));
    onClose();
  };
  const item =
    "flex h-8 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[13px] text-ink hover:bg-ground";
  return (
    <div
      role="menu"
      className="absolute top-full right-0 z-30 mt-1 flex w-72 flex-col gap-1 rounded-lg border border-line-strong bg-panel p-1.5 text-left shadow-[0_8px_24px_rgba(27,35,48,0.16)]"
    >
      {task.state !== "en_curso" && task.state !== "hecha" && (
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => patch({ status: "en_curso" })}
        >
          <Icon name="circleHalf" /> Marcar en curso
        </button>
      )}
      {(task.state === "hecha" || task.state === "omitida") && (
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => patch({ status: "pendiente" })}
        >
          <Icon name="circle" /> Volver a abrir
        </button>
      )}
      {task.state === "esperando" && (
        <>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              onClose();
              void startChase(task.id);
            }}
          >
            <Icon name="sent" /> Redactar reclamación
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              change.run(() => tramitacion.chased(task.id));
              onClose();
            }}
          >
            <Icon name="check" /> Apuntar que he reclamado por teléfono
          </button>
        </>
      )}
      <label className="flex flex-col gap-1 px-2 py-1 text-xs">
        <span className="text-ink-2">Responsable</span>
        <select
          value={task.assigneeId ?? ""}
          onChange={(event) => patch({ assigneeId: event.target.value || null })}
          className={fieldClass}
        >
          <option value="">Sin responsable</option>
          {people.data?.people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 px-2 py-1 text-xs">
        <span className="text-ink-2">Plazo a mano</span>
        <input
          type="date"
          defaultValue={task.dueOverride ?? ""}
          onChange={(event) => patch({ dueOverride: event.target.value || null })}
          className={fieldClass}
        />
      </label>
      <div className="flex gap-1.5 px-2 py-1">
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Anotar (una llamada, por ejemplo)"
          className={`${fieldClass} min-w-0 grow`}
        />
        <button
          type="button"
          disabled={!note.trim()}
          onClick={() => patch({ note })}
          className={buttonClass.small}
        >
          Anotar
        </button>
      </div>
      {task.state !== "omitida" && task.state !== "hecha" && (
        <button type="button" role="menuitem" className={item} onClick={() => setSkip(true)}>
          <Icon name="circleSlash" /> No aplica a este expediente
        </button>
      )}
      {skip && (
        <Confirm
          title={`¿«${task.name}» no aplica?`}
          confirmLabel="No aplica"
          danger
          onConfirm={() => patch({ status: "omitida" })}
          onCancel={() => setSkip(false)}
        >
          La tarea queda tachada y deja de bloquear a las que dependen de ella. Se puede volver a
          abrir.
        </Confirm>
      )}
    </div>
  );
}

function TaskRow({
  task,
  view,
  change,
  focus,
  onFocus,
}: {
  task: Task;
  view: CaseView;
  change: ReturnType<typeof useCaseChange>;
  focus: boolean;
  onFocus: () => void;
}) {
  const [open, setOpen] = useState<"wait" | "menu" | null>(null);
  const [forceDone, setForceDone] = useState(false);
  const done = task.state === "hecha" || task.state === "omitida";
  const markDone = () => {
    if (task.state === "bloqueada") setForceDone(true);
    else change.run(() => tramitacion.patchTask(task.id, { status: "hecha" }));
  };
  return (
    <div
      role="row"
      tabIndex={0}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key.toLowerCase() === "h" && !done) markDone();
        if (event.key.toLowerCase() === "e" && !done) {
          event.preventDefault();
          setOpen("wait");
        }
        if (event.key.toLowerCase() === "r" && task.state === "esperando") void startChase(task.id);
      }}
      className={`group relative flex h-8 items-center gap-2.5 border-0 border-b border-l-[3px] border-b-line-soft pr-3 pl-2 outline-none ${focus ? "border-l-accent bg-accent-soft" : "border-l-transparent bg-panel hover:bg-[#F7F9FB]"}`}
    >
      <StateIcon task={task} />
      <span
        className={`min-w-0 grow truncate ${done ? "text-ink-2" : ""}`}
        title={task.description ?? undefined}
      >
        {task.name}
      </span>
      <span
        className={`hidden w-[300px] shrink-0 truncate text-xs md:block ${done || task.state === "bloqueada" ? "text-ink-2" : "text-ink"}`}
      >
        {taskStatusText(task, view.today)}
      </span>
      <span className="flex w-7 shrink-0 justify-center">
        <Avatar name={task.assigneeName} size={20} />
      </span>
      <span className="w-[112px] shrink-0 text-xs">
        <DueCell due={task.due} today={view.today} legalRef={task.legalRef} done={done} />
      </span>
      {!done && (
        <span
          className={`absolute top-1 right-2 flex gap-1 pl-4 ${focus || open ? "flex" : "hidden group-hover:flex group-focus-within:flex"}`}
          style={{
            background: "linear-gradient(to right, transparent, var(--color-accent-soft) 16px)",
          }}
        >
          <button type="button" onClick={markDone} className={buttonClass.small}>
            <Icon name="check" size={13} />
            Hecha
          </button>
          <span className="relative">
            <button
              type="button"
              aria-expanded={open === "wait"}
              onClick={() => setOpen(open === "wait" ? null : "wait")}
              className={buttonClass.small}
            >
              Esperando…
            </button>
            {open === "wait" && (
              <WaitPopover
                task={task}
                onClose={() => setOpen(null)}
                onSave={(body) => {
                  change.run(() => tramitacion.patchTask(task.id, body));
                  setOpen(null);
                }}
              />
            )}
          </span>
          <span className="relative">
            <button
              type="button"
              aria-label="Más acciones"
              aria-expanded={open === "menu"}
              onClick={() => setOpen(open === "menu" ? null : "menu")}
              className="flex size-6 items-center justify-center rounded-md border-0 bg-transparent text-ink hover:bg-ground"
            >
              <Icon name="more" />
            </button>
            {open === "menu" && (
              <TaskMenu task={task} view={view} change={change} onClose={() => setOpen(null)} />
            )}
          </span>
        </span>
      )}
      {done && (
        <span className="absolute top-1 right-2 hidden gap-1 pl-4 group-hover:flex">
          <span className="relative">
            <button
              type="button"
              aria-label="Más acciones"
              onClick={() => setOpen(open === "menu" ? null : "menu")}
              className="flex size-6 items-center justify-center rounded-md border-0 bg-panel text-ink hover:bg-ground"
            >
              <Icon name="more" />
            </button>
            {open === "menu" && (
              <TaskMenu task={task} view={view} change={change} onClose={() => setOpen(null)} />
            )}
          </span>
        </span>
      )}
      {forceDone && (
        <Confirm
          title={`¿Marcar como hecha «${task.name}»?`}
          confirmLabel="Marcar igualmente"
          onConfirm={() => {
            setForceDone(false);
            change.run(() => tramitacion.patchTask(task.id, { status: "hecha", force: true }));
          }}
          onCancel={() => setForceDone(false)}
        >
          Todavía falta {task.blockers.map((name) => `«${name}»`).join(", ")}, de la que depende. Si
          ya está hecha, márcala primero.
        </Confirm>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ correos

function MailColumn({
  caseId,
  selected,
  onOpen,
}: {
  caseId: string;
  selected: string | null;
  onOpen: (id: string) => void;
}) {
  const mails = useQuery({
    queryKey: ["plugins", "expedientes", "case", caseId],
    queryFn: () => apiGet<{ messages: CaseMessage[] }>(`/plugins/expedientes/cases/${caseId}`),
  });
  const list = [...(mails.data?.messages ?? [])].reverse();
  return (
    <aside
      aria-label="Correos del expediente"
      className="hidden w-[340px] shrink-0 flex-col border-l border-line bg-panel xl:flex"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="grow font-semibold">Correos del expediente</span>
        <span className="text-xs text-ink-2">{list.length}</span>
      </div>
      <div className="min-h-0 grow overflow-y-auto">
        {list.map((mail) => (
          <button
            key={mail.id}
            type="button"
            onClick={() => onOpen(mail.id)}
            aria-current={mail.id === selected ? "true" : undefined}
            className={`flex w-full flex-col gap-0.5 border-0 border-b border-l-[3px] border-b-line-soft px-3 py-2 text-left text-xs text-ink ${mail.id === selected ? "border-l-accent bg-accent-soft" : "border-l-transparent bg-panel hover:bg-ground"}`}
          >
            <span className="flex gap-2">
              <b className="min-w-0 grow truncate font-semibold">
                {mail.fromName || mail.fromAddress}
              </b>
              <span className="text-ink-2">{shortDay(mail.internalDate.slice(0, 10))}</span>
            </span>
            <span className={`truncate ${mail.excluded ? "text-ink-2 line-through" : ""}`}>
              {mail.subject || "(sin asunto)"}
            </span>
          </button>
        ))}
        {mails.isSuccess && list.length === 0 && (
          <p className="m-0 p-3 text-xs text-ink-2">Todavía no hay correos en este expediente.</p>
        )}
      </div>
      <p className="m-0 shrink-0 border-t border-line-soft p-3 text-[11px] leading-normal text-ink-2">
        Los correos con el número del expediente o del siniestro entran solos.
      </p>
    </aside>
  );
}

function MailReader({
  messageId,
  view,
  change,
  onClose,
}: {
  messageId: string;
  view: CaseView;
  change: ReturnType<typeof useCaseChange>;
  onClose: () => void;
}) {
  const candidates = view.tasks.filter(
    (task) => task.state === "esperando" || task.state === "lista" || task.state === "en_curso",
  );
  return (
    <div className="absolute top-0 right-0 bottom-0 z-20 flex w-[min(680px,100%)] flex-col border-l border-line bg-panel shadow-[-8px_0_24px_rgba(27,35,48,0.12)]">
      <div className="flex shrink-0 items-start gap-2 border-b border-line bg-ground p-3 text-xs">
        <div className="flex min-w-0 grow flex-col gap-1.5">
          <b className="font-semibold">¿Qué tarea cumple este correo?</b>
          {candidates.length === 0 && <span className="text-ink-2">No hay tareas abiertas.</span>}
          {candidates.slice(0, 4).map((task) => (
            <span key={task.id} className="flex flex-wrap items-center gap-2">
              <StateIcon task={task} size={14} />
              <span className="min-w-0 truncate">{task.name}</span>
              <span className="grow" />
              {task.state === "esperando" && (
                <button
                  type="button"
                  className={buttonClass.small}
                  onClick={() => change.run(() => tramitacion.evidence(task.id, messageId, false))}
                >
                  Anotar y seguir esperando
                </button>
              )}
              <button
                type="button"
                className={buttonClass.small}
                onClick={() => change.run(() => tramitacion.evidence(task.id, messageId, true))}
              >
                {task.state === "esperando" ? "Es la respuesta esperada" : "La cumple"}
              </button>
            </span>
          ))}
        </div>
        <button
          type="button"
          aria-label="Cerrar el correo"
          onClick={onClose}
          className="flex size-[30px] shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-ink hover:bg-panel"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="flex min-h-0 grow">
        <ReadingPane messageId={messageId} folderId={null} onSelect={() => undefined} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ cabecera y cierre

function CloseDialog({
  view,
  change,
  onClose,
}: {
  view: CaseView;
  change: ReturnType<typeof useCaseChange>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("pagado");
  const open = view.tasks.filter((task) => task.state !== "hecha" && task.state !== "omitida");
  const apply = useApplyView();
  return (
    <Confirm
      title={`¿Cerrar ${view.case.number}?`}
      confirmLabel="Cerrar expediente"
      busy={change.busy}
      onConfirm={() => {
        void tramitacion.close(view.case.id, reason, true).then((result) => {
          if (result.closed) apply(result);
          onClose();
        });
      }}
      onCancel={onClose}
    >
      <span className="flex flex-col gap-2">
        {open.length > 0
          ? `Quedan ${open.length} tareas abiertas: se marcarán como «no aplica».`
          : "Todas las tareas están hechas."}
        <label className="flex items-center gap-2">
          Motivo
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={fieldClass}
          >
            {CLOSE_REASONS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </span>
    </Confirm>
  );
}

function NextStepBand({
  view,
  change,
}: {
  view: CaseView;
  change: ReturnType<typeof useCaseChange>;
}) {
  const step = view.nextStep;
  const task = "taskId" in step ? view.tasks.find((entry) => entry.id === step.taskId) : undefined;
  let detail: ReactNode = null;
  let actions: ReactNode = null;
  if (step.kind === "tarea" && task) {
    detail = (
      <>
        {task.assigneeName ?? "Sin responsable"} ·{" "}
        <DueCell due={task.due} today={view.today} legalRef={task.legalRef} />
        {task.description ? ` · ${task.description}` : ""}
      </>
    );
    actions = (
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => change.run(() => tramitacion.patchTask(task.id, { status: "hecha" }))}
      >
        <Icon name="check" />
        Hecha
      </button>
    );
  } else if (step.kind === "esperar" && task) {
    detail = taskStatusText(task, view.today);
    actions = (
      <button
        type="button"
        className={buttonClass.primary}
        onClick={() => void startChase(task.id)}
      >
        <Icon name="sent" />
        Redactar reclamación
      </button>
    );
  } else if (step.kind === "desbloquear") {
    detail = `Faltan: ${step.blockers.join(", ")}`;
  } else if (step.kind === "cerrar") {
    detail = "Todas las tareas están hechas o no aplican.";
  }
  if (view.case.status === "cerrado") return null;
  return (
    <div className="mx-5 mt-3 flex shrink-0 items-center gap-3 rounded-md border border-l-4 border-accent bg-accent-soft px-3 py-2.5">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className="text-[11px] font-semibold tracking-[0.04em] text-accent-strong uppercase">
          Siguiente paso
        </span>
        <b className="font-semibold">{nextStepText(step, view.today)}</b>
        {detail && <span className="truncate text-xs text-ink-2">{detail}</span>}
      </div>
      {actions}
    </div>
  );
}

function Parties({ view, change }: { view: CaseView; change: ReturnType<typeof useCaseChange> }) {
  const [q, setQ] = useState("");
  const contacts = useQuery({
    queryKey: [...KEY, "contacts", q, ""],
    queryFn: () =>
      apiGet<{ contacts: Contact[] }>(`${BASE}/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    enabled: q.length > 0,
  });
  return (
    <div className="flex flex-col gap-3 p-1">
      {view.parties.length === 0 && (
        <p className="m-0 text-xs text-ink-2">
          Todavía no hay intervinientes apuntados. Se añaden solos al registrar una espera a alguien
          del directorio, o desde aquí.
        </p>
      )}
      {view.parties.map((party) => (
        <div
          key={`${party.contactId}-${party.role}`}
          className="flex items-center gap-3 border-b border-line-soft py-1.5"
        >
          <span className="w-44 shrink-0 text-xs text-ink-2">{roleLabel(party.role)}</span>
          <b className="grow font-semibold">{party.name}</b>
          <span className="text-xs text-ink-2">
            {party.email ?? ""}
            {party.reference ? ` · ref. ${party.reference}` : ""}
          </span>
        </div>
      ))}
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-semibold">Añadir del directorio</span>
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Buscar perito, taller, aseguradora…"
          className={`${fieldClass} max-w-sm`}
        />
      </label>
      {contacts.data?.contacts.map((contact) => (
        <button
          key={contact.id}
          type="button"
          onClick={() => {
            change.run(() =>
              tramitacion.addParty(view.case.id, { contactId: contact.id, role: contact.role }),
            );
            setQ("");
          }}
          className="max-w-sm border-0 bg-transparent p-0 text-left text-accent"
        >
          + {contact.name} <span className="text-ink-2">· {roleLabel(contact.role)}</span>
        </button>
      ))}
    </div>
  );
}

const HISTORY_TEXT: Record<
  string,
  (detail: Record<string, string | number | boolean | null>) => string
> = {
  creada: (detail) =>
    detail.template ? `Plan aplicado: ${String(detail.template)}` : `Tarea añadida`,
  estado: (detail) => `De «${String(detail.from)}» a «${String(detail.to)}»`,
  asignada: () => "Cambio de responsable",
  plazo: () => "Cambio de plazo o de dependencias",
  espera: (detail) =>
    `Esperando${detail.client ? " al cliente" : ""}; reclamar el ${shortDay(String(detail.chaseAt))}`,
  reclamada: (detail) =>
    `Reclamación ${String(detail.count)}; la próxima, el ${shortDay(String(detail.next))}`,
  nota: (detail) =>
    String(detail.text ?? (detail.subject ? `Correo anotado: ${String(detail.subject)}` : "Nota")),
  prueba: (detail) => `Cumplida con el correo «${String(detail.subject ?? "")}»`,
  cierre: (detail) => `Expediente cerrado: ${String(detail.reason)}`,
};

function History({ view }: { view: CaseView }) {
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {view.history.map((event) => (
        <li key={event.id} className="flex gap-3 border-b border-line-soft py-1.5 text-xs">
          <span className="w-24 shrink-0 text-ink-2">
            {new Date(event.at).toLocaleString("es-ES", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="w-24 shrink-0 truncate text-ink-2">{event.userName ?? "Sistema"}</span>
          <span className="min-w-0 grow">
            {event.taskName && <b className="font-semibold">{event.taskName}: </b>}
            {(HISTORY_TEXT[event.kind] ?? (() => event.kind))(event.detail)}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ pantalla

export function CaseProject({ caseId, userId }: { caseId: string; userId: string }) {
  const caseQuery = useCase(caseId);
  const change = useCaseChange();
  const [tab, setTab] = useState<"plan" | "intervinientes" | "historial">("plan");
  const [filter, setFilter] = useState<Filter>("pendientes");
  const [closing, setClosing] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const view = caseQuery.data;

  // Las fases terminadas empiezan plegadas.
  useEffect(() => {
    if (view && collapsed === null)
      setCollapsed(
        new Set(view.phases.filter((phase) => phase.state === "hecha").map((phase) => phase.id)),
      );
  }, [view, collapsed]);

  const visible = useMemo(() => {
    if (!view) return [];
    return view.tasks.filter((task) =>
      filter === "todas"
        ? true
        : filter === "mias"
          ? task.assigneeId === userId && task.state !== "hecha" && task.state !== "omitida"
          : task.state !== "hecha" && task.state !== "omitida",
    );
  }, [view, filter, userId]);

  if (caseQuery.isLoading) {
    return (
      <div role="status" aria-label="Cargando el plan" className="flex flex-col gap-2 p-6">
        {[90, 72, 84, 60, 78].map((width) => (
          <div key={width} className="h-2.5 rounded bg-line-soft" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }
  if (caseQuery.isError || !view) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center justify-center gap-2 p-10 text-center"
      >
        <b className="font-semibold">No se ha podido cargar el plan</b>
        <span className="text-xs text-ink-2">
          Puede ser la conexión con el servidor de la oficina.
        </span>
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => void caseQuery.refetch()}
        >
          Reintentar
        </button>
      </div>
    );
  }
  const kase = view.case;
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <main className="flex min-h-0 min-w-0 grow flex-col bg-panel">
      <header className="flex shrink-0 flex-col gap-2 border-b border-line px-5 pt-3 pb-2.5">
        <nav aria-label="Ruta" className="flex items-center gap-1.5 text-xs text-ink-2">
          <button
            type="button"
            className="border-0 bg-transparent p-0 text-ink-2 hover:text-ink"
            onClick={() => navigate({ sub: "cartera" })}
          >
            Tramitación
          </button>
          <Icon name="right" size={10} />
          <button
            type="button"
            className="border-0 bg-transparent p-0 text-ink-2 hover:text-ink"
            onClick={() => navigate({ sub: "cartera" })}
          >
            Cartera
          </button>
          <Icon name="right" size={10} />
          <span className="font-semibold text-ink">{kase.number}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 min-w-0 truncate text-lg font-semibold tracking-[-0.01em]">
            {kase.number} · {kase.title}
          </h1>
          <span className="grow" />
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 ${view.health.level === "riesgo" ? "border-warn-line bg-warn" : "border-line bg-ground"}`}
          >
            <HealthBadge health={view.health} />
            {view.health.reasons.length > 0 && (
              <span className="max-w-[340px] truncate text-xs text-ink-2">
                {view.health.reasons.join(" · ")}
              </span>
            )}
          </span>
          {kase.status === "abierto" ? (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setClosing(true)}
            >
              Cerrar expediente
            </button>
          ) : (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() =>
                change.run(async () => {
                  await tramitacion.reopen(kase.id);
                  return apiGet<CaseView>(`${BASE}/cases/${kase.id}`);
                })
              }
            >
              Reabrir
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
          {kase.claimRef && (
            <span>
              Siniestro de la aseguradora <b className="font-semibold text-ink">{kase.claimRef}</b>
            </span>
          )}
          {kase.insurerName && (
            <span>
              Aseguradora <b className="font-semibold text-ink">{kase.insurerName}</b>
            </span>
          )}
          <span>
            Fecha del siniestro{" "}
            <b className="font-semibold text-ink">
              {kase.lossDate ? shortDay(kase.lossDate, view.today) : "sin indicar"}
            </b>
          </span>
          <span className="inline-flex items-center gap-1.5">
            Gestor <Avatar name={kase.ownerName} size={18} />
            <b className="font-semibold text-ink">{kase.ownerName ?? "sin asignar"}</b>
          </span>
          <span>
            Abierto hace {daysBetween(kase.createdAt.slice(0, 10), view.today)} d
            {kase.typeName ? ` · ${kase.typeName}` : ""}
          </span>
          {kase.status === "cerrado" && (
            <span>
              Cerrado {kase.closedAt ? shortDay(kase.closedAt.slice(0, 10), view.today) : ""} ·{" "}
              {kase.closeReason}
            </span>
          )}
        </div>
        {view.phases.length > 0 && <PhaseBar phases={view.phases} />}
      </header>
      {change.error && (
        <div
          role="alert"
          className="mx-5 mt-2 flex items-center gap-2 rounded-md border border-warn-line bg-warn px-3 py-2 text-xs text-warn-ink"
        >
          <Icon name="alert" size={14} />
          <span className="grow">{change.error}</span>
          <button
            type="button"
            className="border-0 bg-transparent p-0 font-semibold text-warn-ink"
            onClick={change.clear}
          >
            Cerrar
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 grow">
        <div className="flex min-w-0 grow flex-col overflow-hidden">
          {view.plan ? <NextStepBand view={view} change={change} /> : <NoPlan caseId={kase.id} />}
          <div role="tablist" className="mx-5 mt-2 flex shrink-0 border-b border-line">
            {(["plan", "intervinientes", "historial"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                onClick={() => setTab(entry)}
                className={`mr-4 h-9 border-0 border-b-2 bg-transparent px-0.5 capitalize ${tab === entry ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2"}`}
              >
                {entry === "plan"
                  ? "Plan"
                  : entry === "intervinientes"
                    ? "Intervinientes"
                    : "Historial"}
              </button>
            ))}
          </div>
          <div className="min-h-0 grow overflow-y-auto px-5 pt-2 pb-6">
            {tab === "plan" && view.plan && (
              <>
                <div className="mb-2 flex items-center gap-1.5">
                  <Chip active={filter === "todas"} onClick={() => setFilter("todas")}>
                    Todas
                  </Chip>
                  <Chip active={filter === "pendientes"} onClick={() => setFilter("pendientes")}>
                    Pendientes
                  </Chip>
                  <Chip active={filter === "mias"} onClick={() => setFilter("mias")}>
                    Mías
                  </Chip>
                </div>
                <div
                  role="table"
                  aria-label="Tareas por fase"
                  className="overflow-visible rounded-md border border-line"
                >
                  {view.phases.map((phase) => {
                    const own = view.tasks.filter((task) => task.phaseId === phase.id);
                    const shown = visible.filter((task) => task.phaseId === phase.id);
                    const done = own.filter(
                      (task) => task.state === "hecha" || task.state === "omitida",
                    ).length;
                    const isOpen = !(collapsed ?? new Set()).has(phase.id);
                    return (
                      <div key={phase.id} role="rowgroup">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => toggle(phase.id)}
                          className="flex h-[30px] w-full items-center gap-2 border-0 border-b border-line bg-ground px-3 text-left text-xs font-semibold text-ink"
                        >
                          <Icon name={isOpen ? "down" : "right"} size={12} />
                          {phase.name}
                          <span className="font-normal text-ink-2">
                            {done} de {own.length} hechas
                          </span>
                        </button>
                        {isOpen &&
                          shown.map((task) => (
                            <TaskRow
                              key={task.id}
                              task={task}
                              view={view}
                              change={change}
                              focus={focus === task.id}
                              onFocus={() => setFocus(task.id)}
                            />
                          ))}
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 mb-0 text-[11px] text-ink-2">
                  Teclado: H marca hecha, E registra una espera, R redacta la reclamación. Los
                  plazos con <Icon name="scales" size={11} className="inline align-[-1px]" /> son
                  legales orientativos.
                </p>
              </>
            )}
            {tab === "intervinientes" && <Parties view={view} change={change} />}
            {tab === "historial" && <History view={view} />}
          </div>
        </div>
        <MailColumn caseId={kase.id} selected={reading} onOpen={setReading} />
        {reading && (
          <MailReader
            messageId={reading}
            view={view}
            change={change}
            onClose={() => setReading(null)}
          />
        )}
      </div>
      {closing && <CloseDialog view={view} change={change} onClose={() => setClosing(false)} />}
    </main>
  );
}

function NoPlan({ caseId }: { caseId: string }) {
  const templates = useQuery({
    queryKey: [...KEY, "templates"],
    queryFn: () =>
      apiGet<{ templates: { id: string; name: string; active: boolean }[] }>(`${BASE}/templates`),
  });
  const apply = useApplyView();
  const [error, setError] = useState("");
  return (
    <div className="m-5 flex flex-col items-start gap-2 rounded-md border border-dashed border-line-strong p-4">
      <b className="font-semibold">Este expediente aún no tiene plan</b>
      <span className="text-xs text-ink-2">
        Se abrió solo para agrupar correos. Aplica una plantilla para llevar sus tareas y plazos.
      </span>
      <span className="flex flex-wrap gap-2">
        {templates.data?.templates
          .filter((entry) => entry.active)
          .map((template) => (
            <button
              key={template.id}
              type="button"
              className={buttonClass.primary}
              onClick={() =>
                void tramitacion
                  .applyPlan(caseId, template.id)
                  .then(apply, (failure: unknown) => setError(errorText(failure)))
              }
            >
              {template.name}
            </button>
          ))}
      </span>
      {error && (
        <span role="alert" className="text-xs text-bad-ink">
          {error}
        </span>
      )}
    </div>
  );
}
