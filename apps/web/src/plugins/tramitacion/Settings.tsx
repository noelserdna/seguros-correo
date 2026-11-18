/**
 * Apartados de Configuración de la tramitación: plantillas (lista de tareas con un panel para
 * editar cada una) y directorio de terceros (tabla con un cajón para añadir o cambiar).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiGet } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { errorText, Field, settingsButton, settingsField } from "../../components/settings.tsx";
import type { SettingsPage } from "../types.ts";
import {
  BASE,
  CONTACT_ROLES,
  KEY,
  PARTY_ROLES,
  roleLabel,
  tramitacion,
  type Contact,
  type TemplateSummary,
  type TemplateTask,
  type TemplateTree,
} from "./api.ts";
import { templateTaskSummary } from "./logic.ts";

// ------------------------------------------------------------------ plantillas

type Selected = { phase: number; task: number } | null;
const iconButton =
  "flex size-7 items-center justify-center rounded-md border-0 bg-transparent text-ink hover:bg-ground";

function TaskPanel({
  tree,
  at,
  disabled,
  onChange,
  onMove,
  onRemove,
  onClose,
}: {
  tree: TemplateTree;
  at: { phase: number; task: number };
  disabled: boolean;
  onChange: (task: TemplateTask) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const task = tree.phases[at.phase]!.tasks[at.task]!;
  const set = (patch: Partial<TemplateTask>) => onChange({ ...task, ...patch });
  const others = tree.phases
    .flatMap((phase) => phase.tasks)
    .filter((entry) => entry.key !== task.key);
  const after = task.after ?? [];
  const nameOf = (key: string) => others.find((entry) => entry.key === key)?.name ?? key;
  const numberValue = (value: string) => (value === "" ? null : Math.max(0, Number(value)));

  return (
    <aside
      aria-label={`Tarea ${task.key}`}
      className="flex w-full shrink-0 flex-col rounded-lg border border-line lg:w-[380px]"
    >
      <div className="flex items-center gap-1 border-b border-line px-4 py-2.5">
        <b className="grow text-sm font-semibold">Tarea {task.key}</b>
        {!disabled && (
          <>
            <button
              type="button"
              aria-label="Subir"
              onClick={() => onMove(-1)}
              className={iconButton}
            >
              <Icon name="down" size={12} className="rotate-180" />
            </button>
            <button
              type="button"
              aria-label="Bajar"
              onClick={() => onMove(1)}
              className={iconButton}
            >
              <Icon name="down" size={12} />
            </button>
          </>
        )}
        <button type="button" aria-label="Cerrar el panel" onClick={onClose} className={iconButton}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-4">
        <Field label="Nombre">
          <input
            value={task.name}
            onChange={(event) => set({ name: event.target.value })}
            className={settingsField}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Responsable">
            <select
              value={task.ownerRule ?? ""}
              onChange={(event) => set({ ownerRule: event.target.value ? "gestor" : null })}
              className={settingsField}
            >
              <option value="gestor">Gestor</option>
              <option value="">Sin responsable</option>
            </select>
          </Field>
          <Field label="Espera a">
            <select
              value={task.waitsOnRole ?? ""}
              onChange={(event) => set({ waitsOnRole: event.target.value || null })}
              className={settingsField}
            >
              <option value="">Nadie</option>
              {PARTY_ROLES.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">Plazo</span>
          <div className="flex gap-2">
            <input
              aria-label="Días de plazo"
              type="number"
              min={0}
              placeholder="—"
              value={task.dueDays ?? ""}
              onChange={(event) => set({ dueDays: numberValue(event.target.value) })}
              className={`${settingsField} w-16! shrink-0`}
            />
            <select
              aria-label="Tipo de días"
              value={task.dueUnit ?? "naturales"}
              onChange={(event) => set({ dueUnit: event.target.value as TemplateTask["dueUnit"] })}
              className={settingsField}
            >
              <option value="naturales">días</option>
              <option value="habiles">días hábiles</option>
            </select>
          </div>
          <select
            aria-label="Desde cuándo"
            value={task.dueAnchor ?? "lista"}
            onChange={(event) =>
              set({ dueAnchor: event.target.value as TemplateTask["dueAnchor"] })
            }
            className={settingsField}
          >
            <option value="lista">tras las anteriores</option>
            <option value="apertura">desde la apertura</option>
            <option value="siniestro">desde el siniestro</option>
          </select>
          <span className="text-xs text-ink-2">Vacío: la tarea no tiene plazo.</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">Después de</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {after.map((key) => (
              <span
                key={key}
                className="inline-flex h-[26px] max-w-full items-center gap-1 rounded-full border border-line bg-ground pr-1 pl-2.5 text-xs"
              >
                <span className="truncate">
                  {key} · {nameOf(key)}
                </span>
                {!disabled && (
                  <button
                    type="button"
                    aria-label={`Quitar ${key}`}
                    onClick={() => set({ after: after.filter((entry) => entry !== key) })}
                    className="flex size-5 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-ink-2 hover:text-ink"
                  >
                    <Icon name="close" size={11} />
                  </button>
                )}
              </span>
            ))}
            {after.length === 0 && (
              <span className="text-xs text-ink-2">Puede empezar desde la apertura.</span>
            )}
          </div>
          {!disabled && (
            <select
              aria-label="Añadir una tarea anterior"
              value=""
              onChange={(event) =>
                event.target.value && set({ after: [...after, event.target.value] })
              }
              className={settingsField}
            >
              <option value="">Añadir una tarea anterior…</option>
              {others
                .filter((entry) => !after.includes(entry.key))
                .map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.key} · {entry.name}
                  </option>
                ))}
            </select>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reclamar cada" hint="Días hábiles, si espera a alguien.">
            <input
              type="number"
              min={1}
              placeholder="—"
              value={task.chaseDays ?? ""}
              onChange={(event) => set({ chaseDays: numberValue(event.target.value) })}
              className={settingsField}
            />
          </Field>
          <Field label="Plazo legal" hint="La cita, si lo hay.">
            <input
              value={task.legalRef ?? ""}
              onChange={(event) => set({ legalRef: event.target.value || null })}
              className={settingsField}
            />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={task.optional ?? false}
            onChange={(event) => set({ optional: event.target.checked })}
            className="mt-0.5"
          />
          <span>
            Opcional
            <span className="block text-xs text-ink-2">
              Se crea como «no aplica» y se activa si hace falta.
            </span>
          </span>
        </label>
      </fieldset>
      {!disabled && (
        <div className="border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onRemove}
            className={`${settingsButton.link} text-bad-ink!`}
          >
            Quitar la tarea
          </button>
        </div>
      )}
    </aside>
  );
}

function Templates({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [...KEY, "templates"],
    queryFn: () => apiGet<{ templates: TemplateSummary[] }>(`${BASE}/templates`),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const current = chosen ?? list.data?.templates[0]?.id ?? null;
  const tree = useQuery({
    queryKey: [...KEY, "template", current],
    queryFn: () => apiGet<{ template: TemplateTree }>(`${BASE}/templates/${current}`),
    enabled: Boolean(current),
  });
  const [draft, setDraft] = useState<TemplateTree | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Selected>(null);
  const [closed, setClosed] = useState<Set<number>>(new Set());
  useEffect(() => {
    setDraft(tree.data?.template ?? null);
    setDirty(false);
    setSelected(null);
  }, [tree.data]);

  const refresh = (id: string | undefined) => {
    if (id) setChosen(id);
    void queryClient.invalidateQueries({ queryKey: [...KEY, "templates"] });
    void queryClient.invalidateQueries({ queryKey: [...KEY, "template"] });
  };
  const save = useMutation({
    mutationFn: (input: { id: string | null; tree: TemplateTree }) =>
      tramitacion.saveTemplate(input.id, input.tree),
    onSuccess: (result) => refresh(result.template.id),
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => tramitacion.duplicateTemplate(id),
    onSuccess: (result) => refresh(result.template.id),
  });
  const create = () =>
    save.mutate({
      id: null,
      tree: {
        name: `Nueva plantilla ${new Date().toLocaleDateString("es-ES")}`,
        caseTypeId: null,
        active: false,
        phases: [
          { name: "Apertura", tasks: [{ key: "T1", name: "Primera tarea", ownerRule: "gestor" }] },
        ],
      },
    });

  const update = (next: TemplateTree) => {
    setDraft(next);
    setDirty(true);
  };
  const editPhases = (fn: (phases: TemplateTree["phases"]) => void) => {
    if (!draft) return;
    const phases = draft.phases.map((phase) => ({ ...phase, tasks: [...phase.tasks] }));
    fn(phases);
    update({ ...draft, phases });
  };
  const allKeys = useMemo(
    () => draft?.phases.flatMap((phase) => phase.tasks.map((task) => task.key)) ?? [],
    [draft],
  );
  const nextKey = () => {
    let n = allKeys.length + 1;
    while (allKeys.includes(`T${n}`)) n += 1;
    return `T${n}`;
  };
  const addTask = (phase: number) => {
    const count = draft?.phases[phase]?.tasks.length ?? 0;
    editPhases((phases) => {
      phases[phase]!.tasks.push({ key: nextKey(), name: "Nueva tarea", ownerRule: "gestor" });
    });
    setClosed((current) => {
      const next = new Set(current);
      next.delete(phase);
      return next;
    });
    setSelected({ phase, task: count });
  };
  const togglePhase = (phase: number) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return next;
    });
  const discard = () => {
    setDraft(tree.data?.template ?? null);
    setDirty(false);
    setSelected(null);
    save.reset();
  };
  const disabled = !isAdmin;
  const templates = list.data?.templates ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex min-w-0 items-center gap-2">
          <span className="sr-only">Plantilla</span>
          <select
            value={current ?? ""}
            onChange={(event) => {
              discard();
              setChosen(event.target.value);
            }}
            className={`${settingsField} w-auto! max-w-[360px] font-semibold`}
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
                {template.active ? "" : " (inactiva)"}
              </option>
            ))}
          </select>
        </label>
        {draft && (
          <label className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox"
              disabled={disabled}
              checked={draft.active}
              onChange={(event) => update({ ...draft, active: event.target.checked })}
            />
            Activa: se ofrece al abrir expedientes
          </label>
        )}
        <span className="grow" />
        {isAdmin && (
          <span className="flex gap-2">
            <button
              type="button"
              disabled={!current || duplicate.isPending}
              onClick={() => current && duplicate.mutate(current)}
              className={settingsButton.secondary}
            >
              Duplicar
            </button>
            <button
              type="button"
              onClick={create}
              disabled={save.isPending}
              className={settingsButton.secondary}
            >
              <Icon name="plus" size={14} />
              Nueva plantilla
            </button>
          </span>
        )}
      </div>
      {draft && isAdmin && (
        <Field label="Nombre de la plantilla" className="max-w-[480px]">
          <input
            value={draft.name}
            onChange={(event) => update({ ...draft, name: event.target.value })}
            className={settingsField}
          />
        </Field>
      )}
      {list.isSuccess && templates.length === 0 && (
        <p className="m-0 text-ink-2">Todavía no hay plantillas.</p>
      )}
      {draft && (
        <div className="flex flex-col items-start gap-6 lg:flex-row">
          <div className="flex w-full min-w-0 grow flex-col gap-2">
            <div className="overflow-hidden rounded-lg border border-line">
              {draft.phases.map((phase, phaseIndex) => {
                const open = !closed.has(phaseIndex);
                return (
                  <div key={phaseIndex}>
                    <div className="flex h-9 items-center gap-2 border-b border-line bg-ground px-2 text-xs font-semibold">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={open ? "Plegar la fase" : "Desplegar la fase"}
                        onClick={() => togglePhase(phaseIndex)}
                        className="flex size-6 items-center justify-center rounded border-0 bg-transparent text-ink"
                      >
                        <Icon name={open ? "down" : "right"} size={12} />
                      </button>
                      <span className="shrink-0">{phaseIndex + 1}.</span>
                      {isAdmin ? (
                        <input
                          aria-label="Nombre de la fase"
                          value={phase.name}
                          onChange={(event) =>
                            editPhases((phases) => {
                              phases[phaseIndex] = {
                                ...phases[phaseIndex]!,
                                name: event.target.value,
                              };
                            })
                          }
                          className="h-7 min-w-0 grow rounded border border-transparent bg-transparent px-1.5 font-semibold text-ink hover:border-line-strong focus:border-accent focus:bg-panel focus:outline-none"
                        />
                      ) : (
                        <span className="grow">{phase.name}</span>
                      )}
                      <span className="font-normal whitespace-nowrap text-ink-2">
                        {phase.tasks.length === 1 ? "1 tarea" : `${phase.tasks.length} tareas`}
                      </span>
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => addTask(phaseIndex)}
                          className={`${settingsButton.link} ml-2 inline-flex items-center gap-1 text-xs`}
                        >
                          <Icon name="plus" size={12} />
                          Tarea
                        </button>
                      )}
                      {isAdmin && phase.tasks.length === 0 && draft.phases.length > 1 && (
                        <button
                          type="button"
                          onClick={() => editPhases((phases) => phases.splice(phaseIndex, 1))}
                          className={`${settingsButton.link} ml-2 text-xs`}
                        >
                          Quitar fase
                        </button>
                      )}
                    </div>
                    {open &&
                      phase.tasks.map((task, taskIndex) => {
                        const on = selected?.phase === phaseIndex && selected.task === taskIndex;
                        return (
                          <button
                            key={`${task.key}-${taskIndex}`}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setSelected(on ? null : { phase: phaseIndex, task: taskIndex })
                            }
                            className={`flex min-h-10 w-full items-center gap-3 border-0 border-b border-l-[3px] border-b-line-soft py-1.5 pr-3 pl-3 text-left text-ink ${on ? "border-l-accent bg-accent-soft" : "border-l-transparent bg-panel hover:bg-ground"}`}
                          >
                            <span className="w-8 shrink-0 text-[11px] font-semibold text-ink-2">
                              {task.key}
                            </span>
                            <span className="flex min-w-0 grow flex-col gap-0.5 xl:flex-row xl:items-center xl:gap-3">
                              <span
                                className={`truncate xl:w-[260px] xl:shrink-0 ${on ? "font-semibold" : ""}`}
                              >
                                {task.name}
                                {task.optional ? (
                                  <span className="font-normal text-ink-2"> · opcional</span>
                                ) : null}
                              </span>
                              <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2">
                                {task.legalRef && (
                                  <Icon
                                    name="scales"
                                    size={12}
                                    label="Plazo legal"
                                    className="shrink-0"
                                  />
                                )}
                                <span className="truncate">{templateTaskSummary(task)}</span>
                              </span>
                            </span>
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() =>
                  update({ ...draft, phases: [...draft.phases, { name: "Nueva fase", tasks: [] }] })
                }
                className={`${settingsButton.link} inline-flex items-center gap-1 self-start`}
              >
                <Icon name="plus" size={14} />
                Añadir fase
              </button>
            )}
            <p className="m-0 text-xs leading-normal text-ink-2">
              Los cambios valen para los expedientes que se abran desde ahora; los abiertos
              conservan su copia. Los plazos con{" "}
              <Icon name="scales" size={11} className="inline align-[-1px]" /> son legales
              orientativos hasta confirmarlos.
            </p>
          </div>
          {selected && draft.phases[selected.phase]?.tasks[selected.task] && (
            <TaskPanel
              tree={draft}
              at={selected}
              disabled={disabled}
              onClose={() => setSelected(null)}
              onChange={(task) =>
                editPhases((phases) => {
                  phases[selected.phase]!.tasks[selected.task] = task;
                })
              }
              onRemove={() => {
                editPhases((phases) => phases[selected.phase]!.tasks.splice(selected.task, 1));
                setSelected(null);
              }}
              onMove={(delta) => {
                const target = selected.task + delta;
                const size = draft.phases[selected.phase]!.tasks.length;
                if (target < 0 || target >= size) return;
                editPhases((phases) => {
                  const tasks = phases[selected.phase]!.tasks;
                  [tasks[selected.task], tasks[target]] = [tasks[target]!, tasks[selected.task]!];
                });
                setSelected({ ...selected, task: target });
              }}
            />
          )}
        </div>
      )}
      {isAdmin && draft && (dirty || save.isError) && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-panel px-4 py-3 shadow-[0_-4px_16px_rgba(27,35,48,0.08)]">
          <span className="grow text-[13px]">
            {save.isError ? (
              <span role="alert" className="text-bad-ink">
                {errorText(save.error)}
              </span>
            ) : (
              "Hay cambios sin guardar en esta plantilla."
            )}
          </span>
          <button type="button" onClick={discard} className={settingsButton.secondary}>
            Descartar
          </button>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate({ id: current, tree: draft })}
            className={settingsButton.primary}
          >
            Guardar plantilla
          </button>
        </div>
      )}
      {!isAdmin && (
        <p className="m-0 text-xs text-ink-2">Las plantillas las cambia quien administra.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ directorio

type ContactForm = { role: string; name: string; email: string; phone: string; notes: string };
const EMPTY: ContactForm = { role: "perito", name: "", email: "", phone: "", notes: "" };

function ContactDrawer({
  contact,
  isAdmin,
  onClose,
}: {
  contact: Contact | null;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ContactForm>(
    contact
      ? {
          role: contact.role,
          name: contact.name,
          email: contact.email ?? "",
          phone: contact.phone ?? "",
          notes: contact.notes ?? "",
        }
      : EMPTY,
  );
  const set = (key: keyof ContactForm) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: KEY });
    onClose();
  };
  const body = () => ({
    role: form.role,
    name: form.name,
    email: form.email || null,
    phone: form.phone || null,
    notes: form.notes || null,
  });
  const save = useMutation({
    mutationFn: (): Promise<unknown> =>
      contact ? tramitacion.updateContact(contact.id, body()) : tramitacion.addContact(body()),
    onSuccess: done,
  });
  const toggle = useMutation({
    mutationFn: (target: Contact) =>
      tramitacion.updateContact(target.id, { active: !target.active }),
    onSuccess: done,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (form.name.trim()) save.mutate();
  };
  const failure = save.error ?? toggle.error;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20">
      <button
        type="button"
        aria-label="Cerrar el panel"
        onClick={onClose}
        className="grow border-0 bg-transparent"
      />
      <form
        aria-label={contact ? `Editar ${contact.name}` : "Añadir tercero"}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        className="flex h-full w-full max-w-[400px] flex-col bg-panel shadow-[-8px_0_24px_rgba(27,35,48,0.12)]"
      >
        <div className="flex items-center px-5 pt-5 pb-3">
          <h3 className="m-0 grow truncate text-base font-semibold">
            {contact ? contact.name : "Añadir tercero"}
          </h3>
          <button type="button" aria-label="Cerrar" onClick={onClose} className={iconButton}>
            <Icon name="close" />
          </button>
        </div>
        <div className="flex grow flex-col gap-4 overflow-y-auto px-5 py-1">
          <Field label="Tipo">
            <select value={form.role} onChange={set("role")} className={settingsField}>
              {CONTACT_ROLES.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nombre">
            <input
              autoFocus
              required
              value={form.name}
              onChange={set("name")}
              className={settingsField}
            />
          </Field>
          <Field label="Correo" hint="Sirve para reconocer sus respuestas en el correo.">
            <input
              type="email"
              value={form.email}
              onChange={set("email")}
              className={settingsField}
            />
          </Field>
          <Field label="Teléfono">
            <input value={form.phone} onChange={set("phone")} className={settingsField} />
          </Field>
          <Field label="Notas">
            <textarea
              rows={3}
              value={form.notes}
              onChange={set("notes")}
              className={`${settingsField} h-auto! py-2`}
            />
          </Field>
          {failure && (
            <p role="alert" className="m-0 text-xs text-bad-ink">
              {errorText(failure)}
            </p>
          )}
          {contact && isAdmin && (
            <div className="flex flex-col gap-1 border-t border-line-soft pt-4">
              <button
                type="button"
                onClick={() => toggle.mutate(contact)}
                disabled={toggle.isPending}
                className={`${settingsButton.link} self-start ${contact.active ? "text-bad-ink!" : ""}`}
              >
                {contact.active ? "Desactivar" : "Volver a activar"}
              </button>
              <span className="text-xs leading-normal text-ink-2">
                Un desactivado no se ofrece al registrar esperas, pero sigue en los expedientes
                donde ya está.
              </span>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button type="button" onClick={onClose} className={settingsButton.secondary}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!form.name.trim() || save.isPending}
            className={settingsButton.primary}
          >
            {contact ? "Guardar" : "Añadir"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Directory({ isAdmin }: { isAdmin: boolean }) {
  const contacts = useQuery({
    queryKey: [...KEY, "directory"],
    queryFn: () => apiGet<{ contacts: Contact[] }>(`${BASE}/contacts?all=1`),
  });
  const [role, setRole] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const all = contacts.data?.contacts ?? [];
  const needle = q.trim().toLowerCase();
  const shown = all.filter(
    (contact) =>
      (!role || contact.role === role) &&
      (!needle ||
        [contact.name, contact.email ?? ""].some((text) => text.toLowerCase().includes(needle))),
  );
  const count = (id: string | null) =>
    all.filter((contact) => contact.active && (!id || contact.role === id)).length;
  const chip = (on: boolean) =>
    `h-[26px] rounded-full border px-2.5 text-xs whitespace-nowrap ${on ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line-strong bg-panel text-ink hover:bg-ground"}`;
  const roles = CONTACT_ROLES.filter((entry) => count(entry.id) > 0 || entry.id === role);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-[34px] w-full max-w-[300px] items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-ink-2 focus-within:border-accent">
          <Icon name="search" size={14} />
          <span className="sr-only">Buscar</span>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Buscar por nombre o correo"
            className="min-w-0 grow border-0 bg-transparent text-[13px] text-ink outline-none"
          />
        </label>
        <span className="grow" />
        <button type="button" onClick={() => setEditing("new")} className={settingsButton.primary}>
          <Icon name="plus" size={14} />
          Añadir tercero
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={role === null}
          onClick={() => setRole(null)}
          className={chip(role === null)}
        >
          Todos <span className="font-normal text-ink-2">{count(null)}</span>
        </button>
        {roles.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={role === entry.id}
            onClick={() => setRole(role === entry.id ? null : entry.id)}
            className={chip(role === entry.id)}
          >
            {entry.plural} <span className="font-normal text-ink-2">{count(entry.id)}</span>
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[720px] table-fixed border-collapse text-[13px]">
          <thead className="bg-ground text-left text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
            <tr className="border-b border-line">
              <th className="w-[230px] px-3 py-2 font-semibold">Nombre</th>
              <th className="w-[150px] px-3 py-2 font-semibold">Tipo</th>
              <th className="px-3 py-2 font-semibold">Correo</th>
              <th className="w-[130px] px-3 py-2 font-semibold">Teléfono</th>
              <th className="w-[90px] px-3 py-2 text-right font-semibold">Abiertos</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((contact) => (
              <tr
                key={contact.id}
                tabIndex={0}
                onClick={() => setEditing(contact)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setEditing(contact);
                }}
                className={`h-11 cursor-pointer border-b border-line-soft hover:bg-ground focus:bg-accent-soft focus:outline-none ${contact.active ? "" : "text-ink-2"}`}
              >
                <td className="truncate px-3 font-semibold">
                  {contact.name}
                  {!contact.active && <span className="font-normal"> · desactivado</span>}
                </td>
                <td className="truncate px-3">{roleLabel(contact.role)}</td>
                <td className="truncate px-3 text-ink-2">{contact.email ?? "—"}</td>
                <td className="truncate px-3">{contact.phone ?? "—"}</td>
                <td className="px-3 text-right tabular-nums">{contact.openCases}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {contacts.isSuccess && shown.length === 0 && (
          <p className="m-0 p-4 text-ink-2">
            {all.length === 0
              ? "Todavía no hay nadie en el directorio."
              : "Nadie cumple el filtro."}
          </p>
        )}
      </div>
      <p className="m-0 text-xs leading-normal text-ink-2">
        Cualquiera puede añadir y corregir; desactivar es cosa de quien administra.
      </p>
      {editing && (
        <ContactDrawer
          contact={editing === "new" ? null : editing}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

export const TRAMITACION_SETTINGS: SettingsPage[] = [
  {
    id: "plantillas",
    group: "Tramitación",
    label: "Plantillas",
    description:
      "Las fases y tareas con las que se abre cada expediente. Elige una tarea para cambiarla.",
    adminOnly: true,
    wide: true,
    Component: Templates,
  },
  {
    id: "directorio",
    group: "Tramitación",
    label: "Directorio de terceros",
    description:
      "Peritos, talleres, aseguradoras y demás con los que se tramita. Lo comparte toda la oficina.",
    wide: true,
    Component: Directory,
  },
];
