/** Crear o editar una ficha, en un cajón lateral. También sirve para «Crear ficha» desde una sugerencia. */
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ApiError } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Field, settingsButton, settingsField } from "../../components/settings.tsx";
import {
  contactos,
  ROLES,
  useContactSearch,
  useRefreshContacts,
  type ContactInput,
  type ContactRow,
  type Detail,
} from "./api.ts";

type Draft = ContactInput;

export function draftOf(contact: ContactRow): Draft {
  return {
    kind: contact.kind,
    name: contact.name,
    companyId: contact.companyId,
    notes: contact.notes,
    roles: contact.roles,
    channels: contact.channels.map((channel) => ({
      kind: channel.kind,
      value: channel.value,
      label: channel.label,
      sourceMessageId: channel.sourceMessageId,
    })),
  };
}

export const emptyDraft = (patch: Partial<Draft> = {}): Draft => ({
  kind: "persona",
  name: "",
  companyId: null,
  notes: null,
  roles: [],
  channels: [{ kind: "email", value: "", label: null }],
  ...patch,
});

const chip = (on: boolean) =>
  `h-[26px] rounded-full border px-2.5 text-xs whitespace-nowrap ${on ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line-strong bg-panel text-ink hover:bg-ground"}`;

export function ContactEditor({
  contactId,
  initial,
  isAdmin,
  onSaved,
  onClose,
}: {
  contactId: string | null;
  initial: Draft;
  isAdmin: boolean;
  onSaved: (detail: Detail) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const refresh = useRefreshContacts();
  const companies = useContactSearch("", undefined);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const clean = (): Draft => ({
    ...draft,
    name: draft.name.trim(),
    notes: draft.notes?.trim() || null,
    channels: draft.channels.filter((channel) => channel.value.trim()),
  });
  const save = useMutation({
    mutationFn: () =>
      contactId ? contactos.update(contactId, clean()) : contactos.create(clean()),
    onSuccess: (detail) => {
      refresh();
      onSaved(detail);
    },
  });
  const archive = useMutation({
    mutationFn: () => contactos.archive(contactId!, true),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.name.trim()) save.mutate();
  };
  const setChannel = (index: number, patch: Partial<Draft["channels"][number]>) =>
    set({
      channels: draft.channels.map((channel, i) =>
        i === index ? { ...channel, ...patch } : channel,
      ),
    });
  const failure = save.error ?? archive.error;
  const options = (companies.data?.contacts ?? []).filter(
    (contact) => contact.kind === "empresa" && contact.id !== contactId,
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={onClose}
        className="grow border-0 bg-transparent"
      />
      <form
        aria-label={contactId ? `Editar ${initial.name}` : "Nuevo contacto"}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        className="flex h-full w-full max-w-[440px] flex-col bg-panel shadow-[-8px_0_24px_rgba(27,35,48,0.12)]"
      >
        <div className="flex items-center px-5 pt-5 pb-3">
          <h2 className="m-0 grow truncate text-base font-semibold">
            {contactId ? initial.name : "Nuevo contacto"}
          </h2>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-md border-0 bg-transparent text-ink hover:bg-ground"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="flex grow flex-col gap-4 overflow-y-auto px-5 py-1">
          <div className="flex gap-1.5" role="radiogroup" aria-label="Tipo">
            {(["persona", "empresa"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={draft.kind === kind}
                onClick={() => set({ kind })}
                className={chip(draft.kind === kind)}
              >
                {kind === "persona" ? "Persona" : "Empresa"}
              </button>
            ))}
          </div>
          <Field label="Nombre">
            <input
              autoFocus
              required
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              className={settingsField}
            />
          </Field>
          {draft.kind === "persona" && (
            <Field
              label="Empresa"
              hint="Otra ficha de la agenda: sus expedientes se ven en las dos."
            >
              <select
                value={draft.companyId ?? ""}
                onChange={(event) => set({ companyId: event.target.value || null })}
                className={settingsField}
              >
                <option value="">Sin empresa</option>
                {options.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">Papel</span>
            <div className="flex flex-wrap gap-1.5">
              {ROLES.map((role) => {
                const on = draft.roles.includes(role.id);
                return (
                  <button
                    key={role.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        roles: on
                          ? draft.roles.filter((entry) => entry !== role.id)
                          : [...draft.roles, role.id],
                      })
                    }
                    className={chip(on)}
                  >
                    {role.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">Correos y teléfonos</span>
            {draft.channels.map((channel, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <select
                  aria-label="Tipo de canal"
                  value={channel.kind}
                  onChange={(event) =>
                    setChannel(index, { kind: event.target.value as "email" | "phone" })
                  }
                  className={`${settingsField} w-[92px]! shrink-0`}
                >
                  <option value="email">Correo</option>
                  <option value="phone">Teléfono</option>
                </select>
                <input
                  aria-label={channel.kind === "email" ? "Correo" : "Teléfono"}
                  type={channel.kind === "email" ? "email" : "tel"}
                  value={channel.value}
                  onChange={(event) => setChannel(index, { value: event.target.value })}
                  className={settingsField}
                />
                <input
                  aria-label="Etiqueta"
                  placeholder="trabajo, móvil…"
                  value={channel.label ?? ""}
                  onChange={(event) => setChannel(index, { label: event.target.value || null })}
                  className={`${settingsField} w-[96px]! shrink-0`}
                />
                <button
                  type="button"
                  aria-label="Quitar"
                  onClick={() => set({ channels: draft.channels.filter((_, i) => i !== index) })}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-ink-2 hover:bg-ground hover:text-ink"
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                set({ channels: [...draft.channels, { kind: "email", value: "", label: null }] })
              }
              className={`${settingsButton.link} self-start`}
            >
              + Añadir correo o teléfono
            </button>
            <span className="text-xs leading-normal text-ink-2">
              Los teléfonos sirven también para reconocer sus WhatsApp. Un correo o teléfono solo
              puede estar en una ficha.
            </span>
          </div>
          <Field label="Notas">
            <textarea
              rows={3}
              value={draft.notes ?? ""}
              onChange={(event) => set({ notes: event.target.value })}
              className={`${settingsField} h-auto! py-2`}
            />
          </Field>
          {failure && (
            <p role="alert" className="m-0 text-xs text-bad-ink">
              {failure instanceof ApiError ? failure.message : "No se ha podido guardar."}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-4">
          {contactId && isAdmin ? (
            <button
              type="button"
              onClick={() => archive.mutate()}
              className={`${settingsButton.link} grow text-left text-bad-ink!`}
            >
              Archivar
            </button>
          ) : (
            <span className="grow" />
          )}
          <button type="button" onClick={onClose} className={settingsButton.secondary}>
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!draft.name.trim() || save.isPending}
            className={settingsButton.primary}
          >
            Guardar
          </button>
        </div>
      </form>
    </div>
  );
}
