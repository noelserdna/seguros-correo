/**
 * Módulo de contactos en la interfaz: la agenda (página propia), quién es el remitente en el
 * panel de contexto de cada correo y el cliente dentro de cada expediente.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, ApiError, type MessageDetail } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { settingsButton } from "../../components/settings.tsx";
import type { WebPlugin } from "../types.ts";
import {
  BASE,
  contactos,
  formatPhone,
  KEY,
  roleLabel,
  useRefreshContacts,
  type ContactRow,
} from "./api.ts";
import { ContactEditor, emptyDraft } from "./Editor.tsx";
import { ContactsPage, openContact } from "./Page.tsx";
import { ContactPicker } from "./Picker.tsx";

type ByAddress = {
  contact: ContactRow | null;
  cases: { id: string; number: string; title: string }[];
  suggestion: {
    name: string;
    channel: { kind: "email" | "phone"; value: string };
    count: number;
    cases: number;
    guess: string | null;
  } | null;
};

const Title = ({ children }: { children: string }) => (
  <h3 className="m-0 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
    {children}
  </h3>
);

/** En el panel de contexto: quién escribe, o qué parece y cómo darle ficha. */
function SenderSection({ message }: { message: MessageDetail }) {
  const address = message.from.address;
  const refresh = useRefreshContacts();
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const data = useQuery({
    queryKey: [...KEY, "by-address", address.toLowerCase()],
    queryFn: () => apiGet<ByAddress>(`${BASE}/by-address?${new URLSearchParams({ address })}`),
    enabled: message.direction !== "out" && address.includes("@"),
  });
  if (!data.data) return null;
  const { contact, suggestion, cases } = data.data;

  if (contact) {
    return (
      <section className="flex flex-col gap-1.5">
        <Title>Agenda</Title>
        <button
          type="button"
          onClick={() => openContact(contact.id)}
          className="flex flex-col gap-0.5 rounded-md border border-line bg-panel px-2.5 py-2 text-left text-ink hover:bg-ground"
        >
          <b className="text-[13px] font-semibold">{contact.name}</b>
          <span className="text-xs text-ink-2">
            {[contact.companyName, contact.roles.map(roleLabel).join(", ")]
              .filter(Boolean)
              .join(" · ") || "En la agenda"}
          </span>
          {cases.length > 0 && (
            <span className="text-xs">
              {cases.length === 1 ? "1 expediente abierto" : `${cases.length} expedientes abiertos`}
              : {cases.map((entry) => entry.number).join(", ")}
            </span>
          )}
        </button>
      </section>
    );
  }
  if (!suggestion) return null;
  const shown =
    suggestion.channel.kind === "phone"
      ? `WhatsApp · ${formatPhone(suggestion.channel.value)}`
      : suggestion.channel.value;
  return (
    <section className="flex flex-col gap-1.5">
      <Title>Agenda</Title>
      <div className="relative flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2.5 py-2 text-xs">
        <span>
          <b className="text-[13px] font-semibold">{suggestion.name}</b> no está en la agenda.
        </span>
        <span className="text-ink-2">
          {shown} · {suggestion.count === 1 ? "1 mensaje" : `${suggestion.count} mensajes`}
          {suggestion.guess && ` · parece ${roleLabel(suggestion.guess).toLowerCase()}`}
        </span>
        <span className="flex gap-1.5">
          <button
            type="button"
            className={settingsButton.secondary}
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" size={14} />
            Crear ficha
          </button>
          <button
            type="button"
            className={settingsButton.secondary}
            aria-expanded={picking}
            onClick={() => setPicking(!picking)}
          >
            Es de…
          </button>
        </span>
        {error && (
          <span role="alert" className="text-bad-ink">
            {error}
          </span>
        )}
        {picking && (
          <ContactPicker
            inline
            onClose={() => setPicking(false)}
            onPick={(target) => {
              setPicking(false);
              contactos
                .addChannel(target.id, { ...suggestion.channel, sourceMessageId: message.id })
                .then(refresh, (failure: unknown) =>
                  setError(
                    failure instanceof ApiError ? failure.message : "No se ha podido añadir.",
                  ),
                );
            }}
          />
        )}
      </div>
      {creating && (
        <ContactEditor
          contactId={null}
          isAdmin={false}
          initial={emptyDraft({
            kind: suggestion.guess && suggestion.guess !== "cliente" ? "empresa" : "persona",
            name: suggestion.name,
            roles: suggestion.guess ? [suggestion.guess] : [],
            channels: [
              {
                ...suggestion.channel,
                label: suggestion.channel.kind === "phone" ? "WhatsApp" : null,
                sourceMessageId: message.id,
              },
            ],
          })}
          onClose={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      )}
    </section>
  );
}

/** Dentro del expediente: su cliente, o quién parece serlo. */
function ClientSection({ caseId }: { caseId: string }) {
  const refresh = useRefreshContacts();
  const [picking, setPicking] = useState(false);
  const data = useQuery({
    queryKey: [...KEY, "client", caseId],
    queryFn: () =>
      apiGet<{
        client: ContactRow | null;
        suggested: ContactRow | null;
        suggestedAddress: string | null;
      }>(`${BASE}/cases/${caseId}/client`),
  });
  const set = useMutation({
    mutationFn: (contactId: string | null) => contactos.setClient(caseId, contactId),
    onSuccess: refresh,
  });
  if (!data.data) return null;
  const { client, suggested } = data.data;
  return (
    <div className="relative flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2.5 py-2">
      <span className="text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
        Cliente
      </span>
      {client ? (
        <span className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => openContact(client.id)}
            className="grow border-0 bg-transparent p-0 text-left text-ink"
          >
            <b className="text-[13px] font-semibold">{client.name}</b>
            <span className="block text-ink-2">
              {[client.email, client.phone && formatPhone(client.phone)]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
          <button
            type="button"
            className={settingsButton.link}
            onClick={() => setPicking(!picking)}
          >
            Cambiar
          </button>
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span className="grow">
            {suggested ? `¿Es ${suggested.name}? Escribió el primer correo.` : "Sin cliente."}
          </span>
          {suggested && (
            <button
              type="button"
              className={settingsButton.secondary}
              disabled={set.isPending}
              onClick={() => set.mutate(suggested.id)}
            >
              Sí, es el cliente
            </button>
          )}
          <button
            type="button"
            className={settingsButton.link}
            onClick={() => setPicking(!picking)}
          >
            Elegir
          </button>
        </span>
      )}
      {picking && (
        <ContactPicker
          onClose={() => setPicking(false)}
          onPick={(contact) => {
            setPicking(false);
            set.mutate(contact.id);
          }}
        />
      )}
    </div>
  );
}

export const contactosPlugin: WebPlugin = {
  id: "contactos",
  rail: { icon: "contacts", label: "Contactos" },
  Page: ContactsPage,
  ContextSection: SenderSection,
  CaseSection: ClientSection,
};
