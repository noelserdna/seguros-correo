/** Configuración de la tramitación: plantillas en forma de lista y directorio de terceros. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, ApiError } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
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
import { buttonClass, Chip, fieldClass } from "./pieces.tsx";

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : "No se ha podido guardar.";
const cell =
  "h-7 rounded border border-line-strong bg-panel px-1.5 text-xs text-ink disabled:border-transparent disabled:bg-transparent";

function TaskEditor({
  task,
  disabled,
  onChange,
  onRemove,
  onMove,
}: {
  task: TemplateTask;
  disabled: boolean;
  onChange: (task: TemplateTask) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const set = (patch: Partial<TemplateTask>) => onChange({ ...task, ...patch });
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft px-2.5 py-1.5 text-xs">
      <input
        aria-label="Clave"
        value={task.key}
        disabled={disabled}
        onChange={(event) => set({ key: event.target.value })}
        className={`${cell} w-12`}
      />
      <input
        aria-label="Tarea"
        value={task.name}
        disabled={disabled}
        onChange={(event) => set({ name: event.target.value })}
        className={`${cell} min-w-[220px] grow text-[13px]`}
      />
      <select
        aria-label="Responsable"
        value={task.ownerRule ?? ""}
        disabled={disabled}
        onChange={(event) => set({ ownerRule: event.target.value ? "gestor" : null })}
        className={`${cell} w-24`}
      >
        <option value="gestor">Gestor</option>
        <option value="">Sin asignar</option>
      </select>
      <select
        aria-label="Espera a"
        value={task.waitsOnRole ?? ""}
        disabled={disabled}
        onChange={(event) => set({ waitsOnRole: event.target.value || null })}
        className={`${cell} w-36`}
      >
        <option value="">No espera a nadie</option>
        {PARTY_ROLES.map((role) => (
          <option key={role.id} value={role.id}>
            Espera a: {role.label.toLowerCase()}
          </option>
        ))}
      </select>
      <input
        aria-label="Días de plazo"
        type="number"
        min={0}
        value={task.dueDays ?? ""}
        disabled={disabled}
        onChange={(event) =>
          set({ dueDays: event.target.value === "" ? null : Number(event.target.value) })
        }
        className={`${cell} w-14`}
        placeholder="días"
      />
      <select
        aria-label="Unidad"
        value={task.dueUnit ?? "naturales"}
        disabled={disabled}
        onChange={(event) => set({ dueUnit: event.target.value as TemplateTask["dueUnit"] })}
        className={`${cell} w-24`}
      >
        <option value="naturales">naturales</option>
        <option value="habiles">hábiles</option>
      </select>
      <select
        aria-label="Desde"
        value={task.dueAnchor ?? "lista"}
        disabled={disabled}
        onChange={(event) => set({ dueAnchor: event.target.value as TemplateTask["dueAnchor"] })}
        className={`${cell} w-40`}
      >
        <option value="lista">desde la tarea anterior</option>
        <option value="apertura">desde la apertura</option>
        <option value="siniestro">desde el siniestro</option>
      </select>
      <input
        aria-label="Después de (claves)"
        value={(task.after ?? []).join(", ")}
        disabled={disabled}
        onChange={(event) =>
          set({
            after: event.target.value
              .split(",")
              .map((key) => key.trim())
              .filter(Boolean),
          })
        }
        className={`${cell} w-24`}
        placeholder="después de"
        title="Claves de las tareas que van antes, separadas por comas"
      />
      <input
        aria-label="Reclamar cada (días hábiles)"
        type="number"
        min={1}
        value={task.chaseDays ?? ""}
        disabled={disabled}
        onChange={(event) =>
          set({ chaseDays: event.target.value === "" ? null : Number(event.target.value) })
        }
        className={`${cell} w-16`}
        placeholder="reclamar"
        title="Días hábiles hasta reclamar una espera"
      />
      <input
        aria-label="Plazo legal"
        value={task.legalRef ?? ""}
        disabled={disabled}
        onChange={(event) => set({ legalRef: event.target.value || null })}
        className={`${cell} w-40`}
        placeholder="plazo legal (cita)"
      />
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={task.optional ?? false}
          disabled={disabled}
          onChange={(event) => set({ optional: event.target.checked })}
        />
        opcional
      </label>
      {!disabled && (
        <span className="ml-auto flex gap-0.5">
          <button
            type="button"
            aria-label="Subir"
            onClick={() => onMove(-1)}
            className="flex size-6 items-center justify-center rounded border-0 bg-transparent hover:bg-ground"
          >
            <Icon name="down" size={12} className="rotate-180" />
          </button>
          <button
            type="button"
            aria-label="Bajar"
            onClick={() => onMove(1)}
            className="flex size-6 items-center justify-center rounded border-0 bg-transparent hover:bg-ground"
          >
            <Icon name="down" size={12} />
          </button>
          <button
            type="button"
            aria-label="Quitar la tarea"
            onClick={onRemove}
            className="flex size-6 items-center justify-center rounded border-0 bg-transparent text-bad-ink hover:bg-ground"
          >
            <Icon name="close" size={13} />
          </button>
        </span>
      )}
    </div>
  );
}

function TemplateEditor({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [...KEY, "templates"],
    queryFn: () => apiGet<{ templates: TemplateSummary[] }>(`${BASE}/templates`),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected ?? list.data?.templates[0]?.id ?? null;
  const tree = useQuery({
    queryKey: [...KEY, "template", current],
    queryFn: () => apiGet<{ template: TemplateTree }>(`${BASE}/templates/${current}`),
    enabled: Boolean(current),
  });
  const [draft, setDraft] = useState<TemplateTree | null>(null);
  useEffect(() => setDraft(tree.data?.template ?? null), [tree.data]);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (input: { id: string | null; tree: TemplateTree }) =>
      tramitacion.saveTemplate(input.id, input.tree),
    onSuccess: (result) => {
      setSaved(true);
      setSelected(result.template.id ?? null);
      void queryClient.invalidateQueries({ queryKey: [...KEY, "templates"] });
      void queryClient.invalidateQueries({ queryKey: [...KEY, "template"] });
    },
  });
  const disabled = !isAdmin;
  const update = (next: TemplateTree) => {
    setSaved(false);
    setDraft(next);
  };
  const setTask = (phase: number, index: number, task: TemplateTask | null, move = 0) => {
    if (!draft) return;
    const phases = draft.phases.map((entry) => ({ ...entry, tasks: [...entry.tasks] }));
    const tasks = phases[phase]!.tasks;
    if (task === null) tasks.splice(index, 1);
    else if (move !== 0) {
      const target = index + move;
      if (target < 0 || target >= tasks.length) return;
      [tasks[index], tasks[target]] = [tasks[target]!, tasks[index]!];
    } else tasks[index] = task;
    update({ ...draft, phases });
  };
  const nextKey = () => `T${(draft?.phases.flatMap((phase) => phase.tasks).length ?? 0) + 1}`;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 grow text-sm font-semibold">Plantillas de tramitación</h2>
        {isAdmin && (
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() =>
              save.mutate({
                id: null,
                tree: {
                  name: `Nueva plantilla ${new Date().toLocaleDateString("es-ES")}`,
                  caseTypeId: null,
                  active: false,
                  phases: [
                    {
                      name: "Apertura",
                      tasks: [{ key: "T1", name: "Primera tarea", ownerRule: "gestor" }],
                    },
                  ],
                },
              })
            }
          >
            <Icon name="plus" size={14} />
            Nueva
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {list.data?.templates.map((template) => (
          <Chip
            key={template.id}
            active={template.id === current}
            onClick={() => setSelected(template.id)}
          >
            {template.name}
            {template.active ? "" : " · inactiva"}
          </Chip>
        ))}
      </div>
      {draft && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input
              aria-label="Nombre de la plantilla"
              value={draft.name}
              disabled={disabled}
              onChange={(event) => update({ ...draft, name: event.target.value })}
              className={`${fieldClass} min-w-[260px]`}
            />
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draft.active}
                disabled={disabled}
                onChange={(event) => update({ ...draft, active: event.target.checked })}
              />
              Activa (se ofrece al abrir expedientes)
            </label>
          </div>
          <div className="overflow-hidden rounded-md border border-line">
            {draft.phases.map((phase, phaseIndex) => (
              <div key={phaseIndex}>
                <div className="flex items-center gap-2 border-b border-line bg-ground px-2.5 py-1">
                  <span className="text-xs font-semibold text-ink-2">{phaseIndex + 1}.</span>
                  <input
                    aria-label="Nombre de la fase"
                    value={phase.name}
                    disabled={disabled}
                    onChange={(event) =>
                      update({
                        ...draft,
                        phases: draft.phases.map((entry, index) =>
                          index === phaseIndex ? { ...entry, name: event.target.value } : entry,
                        ),
                      })
                    }
                    className={`${cell} font-semibold`}
                  />
                  <span className="grow" />
                  {isAdmin && (
                    <>
                      <button
                        type="button"
                        className={buttonClass.link}
                        onClick={() =>
                          update({
                            ...draft,
                            phases: draft.phases.map((entry, index) =>
                              index === phaseIndex
                                ? {
                                    ...entry,
                                    tasks: [
                                      ...entry.tasks,
                                      { key: nextKey(), name: "Nueva tarea", ownerRule: "gestor" },
                                    ],
                                  }
                                : entry,
                            ),
                          })
                        }
                      >
                        + Tarea
                      </button>
                      {draft.phases.length > 1 && phase.tasks.length === 0 && (
                        <button
                          type="button"
                          className={buttonClass.link}
                          onClick={() =>
                            update({
                              ...draft,
                              phases: draft.phases.filter((_, index) => index !== phaseIndex),
                            })
                          }
                        >
                          Quitar fase
                        </button>
                      )}
                    </>
                  )}
                </div>
                {phase.tasks.map((task, index) => (
                  <TaskEditor
                    key={`${task.key}-${index}`}
                    task={task}
                    disabled={disabled}
                    onChange={(next) => setTask(phaseIndex, index, next)}
                    onRemove={() => setTask(phaseIndex, index, null)}
                    onMove={(delta) => setTask(phaseIndex, index, task, delta)}
                  />
                ))}
              </div>
            ))}
          </div>
          {isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={buttonClass.link}
                onClick={() =>
                  update({ ...draft, phases: [...draft.phases, { name: "Nueva fase", tasks: [] }] })
                }
              >
                + Fase
              </button>
              <span className="grow" />
              {save.isError && (
                <span role="alert" className="text-xs text-bad-ink">
                  {errorText(save.error)}
                </span>
              )}
              {saved && !save.isError && (
                <span role="status" className="text-xs text-ink-2">
                  Guardada.
                </span>
              )}
              <button
                type="button"
                disabled={save.isPending}
                className={buttonClass.primary}
                onClick={() => save.mutate({ id: current, tree: draft })}
              >
                Guardar plantilla
              </button>
            </div>
          ) : (
            <p className="m-0 text-xs text-ink-2">Las plantillas las cambia un administrador.</p>
          )}
          <p className="m-0 text-xs leading-normal text-ink-2">
            Los cambios valen para los expedientes que se abran desde ahora; los abiertos conservan
            su copia. Los plazos legales son orientativos hasta confirmarlos.
          </p>
        </>
      )}
    </section>
  );
}

function Directory({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<string | null>(null);
  const contacts = useQuery({
    queryKey: [...KEY, "directory", role ?? ""],
    queryFn: () =>
      apiGet<{ contacts: Contact[] }>(`${BASE}/contacts?all=1${role ? `&role=${role}` : ""}`),
  });
  const [form, setForm] = useState({ role: "perito", name: "", email: "", phone: "" });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [...KEY] });
  const add = useMutation({
    mutationFn: () =>
      tramitacion.addContact({
        role: form.role,
        name: form.name,
        email: form.email || null,
        phone: form.phone || null,
      }),
    onSuccess: () => {
      setForm({ ...form, name: "", email: "", phone: "" });
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (contact: Contact) =>
      tramitacion.updateContact(contact.id, { active: !contact.active }),
    onSuccess: refresh,
  });
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <h2 className="m-0 text-sm font-semibold">Directorio de terceros</h2>
      <div className="flex flex-wrap gap-1.5">
        <Chip active={role === null} onClick={() => setRole(null)}>
          Todos
        </Chip>
        {CONTACT_ROLES.map((entry) => (
          <Chip key={entry.id} active={role === entry.id} onClick={() => setRole(entry.id)}>
            {entry.plural}
          </Chip>
        ))}
      </div>
      <div className="overflow-hidden rounded-md border border-line">
        {contacts.data?.contacts.map((contact) => (
          <div
            key={contact.id}
            className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line-soft px-3 py-2 text-xs ${contact.active ? "" : "text-ink-2"}`}
          >
            <b className="text-[13px] font-semibold">{contact.name}</b>
            <span className="text-ink-2">{roleLabel(contact.role)}</span>
            <span className="min-w-0 grow truncate text-ink-2">
              {[contact.email, contact.phone].filter(Boolean).join(" · ")}
            </span>
            <span className="text-ink-2">{contact.openCases} abiertos</span>
            {isAdmin && (
              <button
                type="button"
                className={buttonClass.small}
                onClick={() => toggle.mutate(contact)}
              >
                {contact.active ? "Desactivar" : "Activar"}
              </button>
            )}
          </div>
        ))}
        {contacts.isSuccess && contacts.data.contacts.length === 0 && (
          <p className="m-0 p-3 text-xs text-ink-2">No hay nadie en el directorio todavía.</p>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (form.name.trim()) add.mutate();
        }}
        className="flex flex-wrap items-end gap-2 text-xs"
      >
        <label className="flex flex-col gap-1">
          <span>Tipo</span>
          <select
            value={form.role}
            onChange={(event) => setForm({ ...form, role: event.target.value })}
            className={fieldClass}
          >
            {CONTACT_ROLES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>Nombre</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Correo</span>
          <input
            type="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Teléfono</span>
          <input
            value={form.phone}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
            className={`${fieldClass} w-32`}
          />
        </label>
        <button
          type="submit"
          disabled={!form.name.trim() || add.isPending}
          className={buttonClass.secondary}
        >
          <Icon name="plus" size={14} />
          Añadir
        </button>
        {add.isError && (
          <span role="alert" className="text-bad-ink">
            {errorText(add.error)}
          </span>
        )}
      </form>
      <p className="m-0 text-xs text-ink-2">
        Cualquier tramitador añade contactos; desactivarlos es cosa de un administrador. Su correo
        sirve para reconocer quién escribe.
      </p>
    </section>
  );
}

export function TramitacionSettings({ isAdmin }: { isAdmin: boolean }) {
  return (
    <>
      <TemplateEditor isAdmin={isAdmin} />
      <Directory isAdmin={isAdmin} />
    </>
  );
}
