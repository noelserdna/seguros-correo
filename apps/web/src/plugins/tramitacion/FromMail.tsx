/** Lo que la tramitación pone junto a un correo: el botón «Tramitar», su diálogo y el panel de contexto. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiGet, ApiError, type MessageDetail } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import {
  BASE,
  KEY,
  tramitacion,
  useApplyView,
  type ByMessage,
  type TemplateSummary,
} from "./api.ts";
import { openCase } from "./actions.ts";
import { looksLikeClaim, nextStepText } from "./logic.ts";
import {
  buttonClass,
  DueCell,
  fieldClass,
  HealthBadge,
  PhaseBar,
  SectionTitle,
} from "./pieces.tsx";

const useByMessage = (messageId: string) =>
  useQuery({
    queryKey: [...KEY, "by-message", messageId],
    queryFn: () => apiGet<ByMessage>(`${BASE}/by-message/${messageId}`),
  });

const todayLocal = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

/** Diálogo para abrir el expediente desde el correo del atestado, con su plan. */
export function OpenCaseDialog({
  message,
  onClose,
}: {
  message: MessageDetail;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const templates = useQuery({
    queryKey: [...KEY, "templates"],
    queryFn: () => apiGet<{ templates: TemplateSummary[] }>(`${BASE}/templates`),
  });
  const people = useQuery({
    queryKey: [...KEY, "people-of", message.accountId],
    queryFn: () =>
      apiGet<{ people: { id: string; name: string }[] }>(
        `${BASE}/people?accountId=${message.accountId}`,
      ),
  });
  const insurers = useQuery({
    queryKey: ["plugins", "expedientes", "insurers"],
    queryFn: () =>
      apiGet<{ insurers: { id: string; name: string }[] }>("/plugins/expedientes/insurers"),
  });
  const active = (templates.data?.templates ?? []).filter((entry) => entry.active);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [form, setForm] = useState({
    lossDate: "",
    ownerId: "",
    claimRef: "",
    insurerId: "",
    title: message.subject,
  });
  const chosen = templateId ?? active[0]?.id ?? null;
  const apply = useApplyView();
  const open = useMutation({
    mutationFn: () =>
      tramitacion.open({
        messageId: message.id,
        templateId: chosen,
        lossDate: form.lossDate,
        ownerId: form.ownerId || null,
        claimRef: form.claimRef || null,
        insurerId: form.insurerId || null,
        title: form.title,
      }),
    onSuccess: (view) => {
      apply(view);
      onClose();
      openCase(view.case.id);
    },
  });
  const invalidDate = !form.lossDate || form.lossDate > todayLocal();
  const field = (label: string, input: React.ReactNode, required = false) => (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold">
        {label}
        {required ? " *" : ""}
      </span>
      {input}
    </label>
  );
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="abrir-expediente"
      className="m-auto w-[540px] max-w-[calc(100vw-32px)] rounded-[10px] border-0 bg-panel p-5 text-ink shadow-[0_16px_40px_rgba(27,35,48,0.3)] backdrop:bg-ink/30"
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalidDate && chosen) open.mutate();
        }}
        className="flex flex-col gap-3.5"
      >
        <h2 id="abrir-expediente" className="m-0 text-base font-semibold">
          Abrir expediente desde este correo
        </h2>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">Tipo de tramitación *</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {active.map((template) => (
              <button
                key={template.id}
                type="button"
                aria-pressed={chosen === template.id}
                onClick={() => setTemplateId(template.id)}
                className={`flex flex-col gap-0.5 rounded-md border px-3 py-2.5 text-left ${chosen === template.id ? "border-accent bg-accent-soft" : "border-line-strong bg-panel"}`}
              >
                <b className="font-semibold">{template.name}</b>
                <span className="text-xs text-ink-2">
                  {template.phases} fases · {template.tasks} tareas
                </span>
              </button>
            ))}
          </div>
          {templates.isSuccess && active.length === 0 && (
            <span className="text-xs text-ink-2">
              No hay plantillas activas: un administrador puede crearlas en Configuración.
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {field(
            "Fecha del siniestro",
            <input
              type="date"
              required
              max={todayLocal()}
              value={form.lossDate}
              onChange={(event) => setForm({ ...form, lossDate: event.target.value })}
              className={fieldClass}
            />,
            true,
          )}
          {field(
            "Gestor",
            <select
              value={form.ownerId}
              onChange={(event) => setForm({ ...form, ownerId: event.target.value })}
              className={fieldClass}
            >
              <option value="">Yo</option>
              {people.data?.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>,
          )}
          {field(
            "Nº de siniestro de la aseguradora",
            <input
              value={form.claimRef}
              placeholder="Si ya lo tienes"
              onChange={(event) => setForm({ ...form, claimRef: event.target.value })}
              className={fieldClass}
            />,
          )}
          {field(
            "Aseguradora",
            <select
              value={form.insurerId}
              onChange={(event) => setForm({ ...form, insurerId: event.target.value })}
              className={fieldClass}
            >
              <option value="">Sin indicar</option>
              {insurers.data?.insurers.map((insurer) => (
                <option key={insurer.id} value={insurer.id}>
                  {insurer.name}
                </option>
              ))}
            </select>,
          )}
        </div>
        {field(
          "Título",
          <input
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            className={fieldClass}
          />,
        )}
        <p className="m-0 text-xs leading-normal text-ink-2">
          Los plazos se cuentan desde la fecha del siniestro. Entra toda la conversación de este
          correo, y los que lleguen con el número del expediente o del siniestro entrarán solos.
        </p>
        {open.isError && (
          <p role="alert" className="m-0 text-xs text-bad-ink">
            {open.error instanceof ApiError ? open.error.message : "No se ha podido abrir."}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={invalidDate || !chosen || open.isPending}
            className={buttonClass.primary}
          >
            Abrir expediente
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Botón de la barra del correo: «Tramitar» o el expediente en el que ya está. */
export function TramitarAction({ message }: { message: MessageDetail }) {
  const cases = useByMessage(message.id);
  const [opening, setOpening] = useState(false);
  const first = cases.data?.cases[0];
  if (first) {
    return (
      <button
        type="button"
        onClick={() => openCase(first.case.id)}
        title={first.health.reasons.join(" · ") || "Abrir el plan"}
        className="inline-flex h-[30px] items-center gap-1.5 rounded-md border-0 bg-accent-soft px-2.5 font-semibold whitespace-nowrap text-accent-strong"
      >
        <Icon name="tasks" />
        {first.case.number}
        <span className="hidden font-normal @2xl:inline">
          · <HealthBadge health={first.health} size={12} />
        </span>
      </button>
    );
  }
  const hint = looksLikeClaim(
    message.subject,
    message.attachments.map((file) => file.filename),
  );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpening(true)}
        title="Abrir un expediente con su plan de tareas"
        className={`inline-flex h-[30px] items-center gap-1.5 rounded-md px-2.5 font-semibold whitespace-nowrap ${hint ? "border border-accent bg-accent-soft text-accent-strong" : "border border-line-strong bg-panel text-ink hover:bg-ground"}`}
      >
        <Icon name="tasks" />
        Tramitar
        {hint && <span className="hidden font-normal @2xl:inline">· parece un atestado</span>}
      </button>
      {opening && <OpenCaseDialog message={message} onClose={() => setOpening(false)} />}
    </>
  );
}

/** Sección del panel de contexto de un correo. */
export function TramitacionContext({ message }: { message: MessageDetail }) {
  const cases = useByMessage(message.id);
  const apply = useApplyView();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const run = (promise: Promise<Parameters<typeof apply>[0]>) =>
    void promise.then(
      (view) => {
        setError("");
        apply(view);
      },
      (failure: unknown) =>
        setError(failure instanceof ApiError ? failure.message : "No se ha podido guardar."),
    );
  if (!cases.data) return null;
  if (cases.data.cases.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <SectionTitle>Tramitación</SectionTitle>
        <p className="m-0 text-xs leading-normal text-ink-2">
          Este correo no está en ningún expediente en tramitación.
        </p>
        <span>
          <button type="button" className={buttonClass.secondary} onClick={() => setOpening(true)}>
            <Icon name="tasks" />
            Tramitar
          </button>
        </span>
        {opening && <OpenCaseDialog message={message} onClose={() => setOpening(false)} />}
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3">
      {cases.data.cases.map((entry) => {
        const step = entry.nextStep;
        return (
          <div key={entry.case.id} className="flex flex-col gap-2">
            {entry.awaited && (
              <div
                role="status"
                className="flex flex-col gap-1.5 rounded-md border border-line-strong bg-ground p-2.5 text-xs"
              >
                <span className="flex items-start gap-2">
                  <Icon name="hourglass" className="mt-px text-ink-2" />
                  <span>
                    <b className="font-semibold">Esperabas a {entry.awaited.who}</b> desde hace{" "}
                    {entry.awaited.days} días, para «{entry.awaited.taskName}».
                  </span>
                </span>
                <span className="flex gap-1.5">
                  <button
                    type="button"
                    className={buttonClass.small}
                    onClick={() =>
                      run(tramitacion.evidence(entry.awaited!.taskId, message.id, true))
                    }
                  >
                    Es la respuesta
                  </button>
                  <button
                    type="button"
                    className={buttonClass.small}
                    onClick={() =>
                      run(tramitacion.evidence(entry.awaited!.taskId, message.id, false))
                    }
                  >
                    Sigue pendiente
                  </button>
                </span>
                <span className="text-ink-2">
                  Se reconoce porque el remitente está en el directorio. Lo confirmas tú.
                </span>
              </div>
            )}
            <SectionTitle>Tramitación</SectionTitle>
            <span className="flex items-center gap-2 text-[13px]">
              <b className="font-semibold">{entry.case.number}</b>
              <span className="grow" />
              <HealthBadge health={entry.health} size={13} />
            </span>
            <span className="text-xs text-ink-2">
              {entry.case.title}
              {entry.currentPhase ? ` · fase ` : ""}
              <b className="font-semibold text-ink">{entry.currentPhase ?? ""}</b>
            </span>
            <PhaseBar phases={entry.phases} compact />
            {entry.case.status === "abierto" && (
              <div className="flex flex-col gap-1 rounded-md border border-l-4 border-accent bg-accent-soft p-2.5 text-xs">
                <span className="text-[11px] font-semibold tracking-[0.04em] text-accent-strong uppercase">
                  Siguiente paso
                </span>
                <b className="text-[13px] font-semibold">{nextStepText(step, todayLocal())}</b>
                {step.kind === "tarea" && (
                  <>
                    <DueCell
                      due={step.due}
                      today={todayLocal()}
                      legalRef={step.legal ? "plazo legal" : null}
                    />
                    <span>
                      <button
                        type="button"
                        className={buttonClass.small}
                        onClick={() => run(tramitacion.patchTask(step.taskId, { status: "hecha" }))}
                      >
                        <Icon name="check" size={13} />
                        Hecha
                      </button>
                    </span>
                  </>
                )}
              </div>
            )}
            <span>
              <button
                type="button"
                className={buttonClass.link}
                onClick={() => openCase(entry.case.id)}
              >
                Abrir el plan
              </button>
            </span>
          </div>
        );
      })}
      {error && (
        <span role="alert" className="text-xs text-bad-ink">
          {error}
        </span>
      )}
    </section>
  );
}
