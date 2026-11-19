/**
 * La página de la agenda: la lista («lista»), la ficha de cada contacto («c:<id>») y lo que
 * hay por revisar («revisar»). La subruta va en la dirección, como en la tramitación.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, apiGet, ApiError } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { settingsButton } from "../../components/settings.tsx";
import { navigate, useUrlState } from "../../url-state.ts";
import { plugins } from "../index.ts";
import {
  BASE,
  contactos,
  formatPhone,
  initials,
  KEY,
  roleLabel,
  ROLES,
  useContactSearch,
  useRefreshContacts,
  useReview,
  type ContactRow,
  type Detail,
  type Suggestion,
} from "./api.ts";
import { ContactEditor, draftOf, emptyDraft } from "./Editor.tsx";
import { ContactPicker } from "./Picker.tsx";

type Editing = { id: string | null; draft: ReturnType<typeof emptyDraft> } | null;

export const openContact = (id: string) =>
  navigate({
    view: "plugin",
    pluginId: "contactos",
    sub: `c:${id}`,
    messageId: null,
    composeId: null,
  });

/** Lleva a un expediente: a su plan si la tramitación está activa; si no, a Expedientes. */
const openCase = (id: string) =>
  plugins.some((plugin) => plugin.id === "tramitacion")
    ? navigate({ view: "plugin", pluginId: "tramitacion", sub: `exp:${id}` })
    : navigate({ view: "plugin", pluginId: "expedientes", sub: `c:${id}`, messageId: null });

function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-strong"
      style={{ width: size, height: size, fontSize: size >= 40 ? 16 : 12 }}
    >
      {initials(name) || "?"}
    </span>
  );
}

const RoleTags = ({ roles }: { roles: string[] }) => (
  <span className="flex flex-wrap gap-1">
    {roles.map((role) => (
      <span
        key={role}
        className="rounded-full border border-line bg-ground px-1.5 text-[11px] font-semibold"
      >
        {roleLabel(role)}
      </span>
    ))}
  </span>
);

const when = (iso: string) => {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" });
};

// ------------------------------------------------------------------ lista

function ContactList({ onNew }: { onNew: () => void }) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const list = useContactSearch(q, role ?? undefined);
  const all = useContactSearch("", undefined);
  const review = useReview();
  const pending = review.data?.suggestions.length ?? 0;
  const counts = all.data?.counts ?? {};
  const chip = (on: boolean) =>
    `h-[26px] rounded-full border px-2.5 text-xs whitespace-nowrap ${on ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line-strong bg-panel text-ink hover:bg-ground"}`;
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col gap-3.5 overflow-y-auto px-5 py-5 md:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 grow text-xl font-semibold tracking-[-0.01em]">Contactos</h1>
        <label className="flex h-8 w-full max-w-[320px] items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-ink-2 focus-within:border-accent">
          <Icon name="search" size={14} />
          <span className="sr-only">Buscar</span>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Buscar por nombre, correo, teléfono o empresa"
            className="min-w-0 grow border-0 bg-transparent text-[13px] text-ink outline-none"
          />
        </label>
        <button type="button" onClick={onNew} className={settingsButton.primary}>
          <Icon name="plus" size={14} />
          Nuevo contacto
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={role === null}
          onClick={() => setRole(null)}
          className={chip(role === null)}
        >
          Todos <span className="font-normal text-ink-2">{all.data?.total ?? ""}</span>
        </button>
        {ROLES.filter((entry) => (counts[entry.id] ?? 0) > 0 || entry.id === role).map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={role === entry.id}
            onClick={() => setRole(role === entry.id ? null : entry.id)}
            className={chip(role === entry.id)}
          >
            {entry.plural} <span className="font-normal text-ink-2">{counts[entry.id] ?? 0}</span>
          </button>
        ))}
        <span className="grow" />
        {pending > 0 && (
          <button
            type="button"
            onClick={() => navigate({ sub: "revisar" })}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-warn-line bg-warn px-2.5 text-xs font-semibold text-warn-ink"
          >
            Por revisar {pending}
          </button>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[820px] table-fixed border-collapse text-[13px]">
          <thead className="bg-ground text-left text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
            <tr className="border-b border-line">
              <th className="w-[290px] px-3 py-2 font-semibold">Nombre</th>
              <th className="w-[170px] px-3 py-2 font-semibold">Papel</th>
              <th className="px-3 py-2 font-semibold">Correo</th>
              <th className="w-[150px] px-3 py-2 font-semibold">Teléfono</th>
              <th className="w-[110px] px-3 py-2 text-right font-semibold">Expedientes</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.contacts.map((contact) => (
              <tr
                key={contact.id}
                tabIndex={0}
                onClick={() => openContact(contact.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") openContact(contact.id);
                }}
                className="h-[52px] cursor-pointer border-b border-line-soft hover:bg-ground focus:bg-accent-soft focus:outline-none"
              >
                <td className="px-3">
                  <span className="flex items-center gap-2.5">
                    <Avatar name={contact.name} />
                    <span className="flex min-w-0 flex-col">
                      <b className="truncate font-semibold">{contact.name}</b>
                      <span className="truncate text-xs text-ink-2">
                        {contact.companyName ?? (contact.kind === "empresa" ? "Empresa" : "")}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="px-3">
                  <RoleTags roles={contact.roles} />
                </td>
                <td className="truncate px-3 text-xs text-ink-2">{contact.email ?? "—"}</td>
                <td className="truncate px-3 text-xs">
                  {contact.phone ? formatPhone(contact.phone) : "—"}
                </td>
                <td className="px-3 text-right tabular-nums">{contact.openCases || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && list.data.contacts.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Icon name="contacts" size={28} className="text-ink-2" />
            <b className="font-semibold">
              {q || role ? "Nadie cumple la búsqueda" : "La agenda está vacía"}
            </b>
            <span className="text-xs text-ink-2">
              {pending > 0
                ? "En «Por revisar» hay quien escribe y aún no tiene ficha."
                : "Crea la primera ficha o espera a que llegue correo."}
            </span>
          </div>
        )}
      </div>
      <p className="m-0 text-xs text-ink-2">
        Una ficha por persona o empresa, con todos sus correos y teléfonos: se la reconoce escriba
        por correo o por WhatsApp.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ ficha

function ContactCard({ id, onEdit }: { id: string; onEdit: (contact: ContactRow) => void }) {
  const detail = useQuery({
    queryKey: [...KEY, "detail", id],
    queryFn: () => apiGet<Detail>(`${BASE}/contacts/${id}`),
  });
  const [writing, setWriting] = useState(false);
  if (detail.isError) {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 p-10 text-center">
        <b className="font-semibold">No se ha encontrado la ficha</b>
        <button
          type="button"
          className={settingsButton.secondary}
          onClick={() => navigate({ sub: null })}
        >
          Volver a la agenda
        </button>
      </div>
    );
  }
  const data = detail.data;
  if (!data)
    return (
      <p role="status" className="m-0 p-6 text-ink-2">
        Cargando la ficha…
      </p>
    );
  const { contact } = data;
  const write = async () => {
    const email = contact.channels.find((channel) => channel.kind === "email");
    const [account] = await api.accounts();
    if (!email || !account) return;
    setWriting(true);
    try {
      const outbound = await api.createOutbound(account.id, "new");
      await api.saveOutbound(outbound.id, {
        to: [{ name: contact.name, address: email.value }],
        cc: [],
        bcc: [],
        subject: "",
        bodyHtml: outbound.bodyHtml,
      });
      navigate({ view: "mail", accountId: account.id, composeId: outbound.id, messageId: null });
    } finally {
      setWriting(false);
    }
  };
  const seen = (count?: number, since?: string | null) =>
    count
      ? `visto en ${count} ${count === 1 ? "mensaje" : "mensajes"}${since ? ` · desde ${new Date(since).toLocaleDateString("es-ES")}` : ""}`
      : "aún sin mensajes";
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <aside className="flex w-full shrink-0 flex-col gap-5 border-line p-6 lg:w-[360px] lg:overflow-y-auto lg:border-r">
        <nav aria-label="Ruta" className="flex items-center gap-1.5 text-xs text-ink-2">
          <button
            type="button"
            onClick={() => navigate({ sub: null })}
            className="border-0 bg-transparent p-0 text-ink-2 hover:text-ink"
          >
            Contactos
          </button>
          <Icon name="right" size={10} />
          <span className="truncate font-semibold text-ink">{contact.name}</span>
        </nav>
        <div className="flex items-center gap-3.5">
          <Avatar name={contact.name} size={48} />
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">{contact.name}</h1>
            {contact.companyName && contact.companyId && (
              <button
                type="button"
                onClick={() => openContact(contact.companyId!)}
                className="flex items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[13px] text-accent"
              >
                <Icon name="building" size={13} className="text-ink-2" />
                {contact.companyName}
              </button>
            )}
            {contact.archived && <span className="text-xs text-ink-2">Archivada</span>}
          </div>
        </div>
        <RoleTags roles={contact.roles} />
        <div className="flex flex-wrap gap-2">
          {contact.email && (
            <button
              type="button"
              onClick={() => void write()}
              disabled={writing}
              className={settingsButton.secondary}
            >
              <Icon name="mail" size={14} />
              Escribir correo
            </button>
          )}
          <button
            type="button"
            onClick={() => onEdit(contact)}
            className={settingsButton.secondary}
          >
            Editar
          </button>
        </div>
        <section className="flex flex-col">
          <h2 className="m-0 mb-1.5 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
            Cómo contactar
          </h2>
          {contact.channels.map((channel) => (
            <div
              key={channel.id}
              className="flex min-h-10 items-center gap-2.5 border-b border-line-soft py-1"
            >
              <Icon
                name={channel.kind === "email" ? "mail" : "phone"}
                size={14}
                className="shrink-0 text-ink-2"
              />
              <span className="flex min-w-0 grow flex-col">
                <span className="truncate text-[13px] select-all">
                  {channel.kind === "phone" ? formatPhone(channel.value) : channel.value}
                </span>
                <span className="text-[11px] text-ink-2">{seen(channel.seen, channel.since)}</span>
              </span>
              {channel.label && <span className="text-[11px] text-ink-2">{channel.label}</span>}
            </div>
          ))}
          {contact.channels.length === 0 && (
            <p className="m-0 text-xs text-ink-2">Sin correos ni teléfonos.</p>
          )}
        </section>
        {data.members.length > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="m-0 mb-1 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
              Personas
            </h2>
            {data.members.map((member) => (
              <button
                key={member.id}
                type="button"
                onClick={() => openContact(member.id)}
                className="border-0 bg-transparent p-0 text-left text-[13px] text-accent"
              >
                {member.name}
              </button>
            ))}
          </section>
        )}
        {contact.notes && (
          <section className="flex flex-col gap-1">
            <h2 className="m-0 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
              Notas
            </h2>
            <p className="m-0 text-[13px] leading-normal whitespace-pre-line">{contact.notes}</p>
          </section>
        )}
      </aside>
      <div className="flex min-w-0 grow flex-col gap-6 p-6 lg:overflow-y-auto lg:px-8">
        <section className="flex flex-col">
          <h2 className="m-0 mb-1.5 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
            Expedientes
          </h2>
          {data.cases.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => openCase(entry.id)}
              className="flex min-h-11 items-center gap-3 border-0 border-b border-line-soft bg-transparent px-0 text-left text-ink hover:bg-ground"
            >
              <b className="w-[120px] shrink-0 font-semibold">{entry.number}</b>
              <span className="min-w-0 grow truncate">{entry.title}</span>
              {entry.role && <span className="text-xs text-ink-2">{roleLabel(entry.role)}</span>}
              <span
                className={`w-20 text-right text-xs ${entry.status === "abierto" ? "" : "text-ink-2"}`}
              >
                {entry.status === "abierto" ? "Abierto" : "Cerrado"}
              </span>
            </button>
          ))}
          {data.cases.length === 0 && (
            <p className="m-0 text-xs text-ink-2">No aparece en ningún expediente.</p>
          )}
        </section>
        <section className="flex flex-col">
          <h2 className="m-0 mb-1.5 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
            Lo último que ha mandado
          </h2>
          {data.activity.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() =>
                navigate({
                  view: "mail",
                  accountId: entry.accountId,
                  folderId: null,
                  messageId: entry.id,
                })
              }
              className="flex min-h-11 items-center gap-2.5 border-0 border-b border-line-soft bg-transparent px-0 text-left text-[13px] text-ink hover:bg-ground"
            >
              <Icon
                name={entry.whatsapp ? "chat" : "mail"}
                size={14}
                className="shrink-0 text-ink-2"
              />
              <span className="w-[86px] shrink-0 font-semibold">
                {entry.whatsapp ? "WhatsApp" : "Correo"}
              </span>
              <span className="min-w-0 grow truncate">
                {entry.whatsapp ? entry.preview || entry.subject : entry.subject || entry.preview}
                {entry.files > 0 && (
                  <span className="text-ink-2">
                    {" "}
                    · {entry.files === 1 ? "1 adjunto" : `${entry.files} adjuntos`}
                  </span>
                )}
              </span>
              {entry.cases.map((number) => (
                <span
                  key={number}
                  className="rounded bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-strong"
                >
                  {number}
                </span>
              ))}
              <span className="w-14 shrink-0 text-right text-xs text-ink-2">{when(entry.at)}</span>
            </button>
          ))}
          {data.activity.length === 0 && (
            <p className="m-0 text-xs text-ink-2">Todavía no ha escrito a ningún buzón que veas.</p>
          )}
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ por revisar

function SuggestionRow({
  entry,
  onCreate,
}: {
  entry: Extract<Suggestion, { kind: "nuevo" }>;
  onCreate: () => void;
}) {
  const refresh = useRefreshContacts();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const channel = entry.whatsapp
    ? { kind: "phone" as const, value: entry.address.split("@")[0]! }
    : { kind: "email" as const, value: entry.address };
  const attach = (contact: ContactRow) => {
    setPicking(false);
    contactos
      .addChannel(contact.id, { ...channel, sourceMessageId: entry.messageId })
      .then(refresh, (failure: unknown) =>
        setError(failure instanceof ApiError ? failure.message : "No se ha podido añadir."),
      );
  };
  return (
    <li className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 py-2">
      <span className="flex min-w-0 grow basis-72 flex-col gap-0.5">
        <b className="font-semibold">{entry.name}</b>
        <span className="text-xs text-ink-2">
          {entry.whatsapp ? `WhatsApp · ${formatPhone(channel.value)}` : entry.address} ·{" "}
          {entry.count === 1 ? "1 mensaje" : `${entry.count} mensajes`}
          {entry.cases > 0 &&
            ` en ${entry.cases === 1 ? "1 expediente" : `${entry.cases} expedientes`}`}
        </span>
        <span className="truncate text-xs">{entry.subject}</span>
        {error && (
          <span role="alert" className="text-xs text-bad-ink">
            {error}
          </span>
        )}
      </span>
      <span className="w-40 shrink-0 text-xs">
        {entry.guess ? `Parece ${roleLabel(entry.guess).toLowerCase()}` : ""}
      </span>
      <span className="relative flex shrink-0 gap-1.5">
        <button type="button" onClick={onCreate} className={settingsButton.secondary}>
          <Icon name="plus" size={14} />
          Crear ficha
        </button>
        <button
          type="button"
          aria-expanded={picking}
          onClick={() => setPicking(!picking)}
          className={settingsButton.secondary}
        >
          Es de…
        </button>
        <button
          type="button"
          onClick={() => void contactos.dismiss("nuevo", entry.key).then(refresh)}
          className={`${settingsButton.link} px-2 text-ink-2!`}
        >
          Ignorar
        </button>
        {picking && <ContactPicker onPick={attach} onClose={() => setPicking(false)} />}
      </span>
    </li>
  );
}

function Review({
  onCreate,
}: {
  onCreate: (entry: Extract<Suggestion, { kind: "nuevo" }>) => void;
}) {
  const review = useReview();
  const refresh = useRefreshContacts();
  const join = useMutation({
    mutationFn: (entry: Extract<Suggestion, { kind: "duplicado" }>) => {
      const whatsapp = entry.other.whatsapp;
      return contactos.addChannel(entry.contact.id, {
        kind: whatsapp ? "phone" : "email",
        value: whatsapp ? entry.other.address.split("@")[0]! : entry.other.address,
        sourceMessageId: entry.messageId,
      });
    },
    onSuccess: refresh,
  });
  const list = review.data?.suggestions ?? [];
  const duplicates = list.filter(
    (entry): entry is Extract<Suggestion, { kind: "duplicado" }> => entry.kind === "duplicado",
  );
  const fresh = list.filter(
    (entry): entry is Extract<Suggestion, { kind: "nuevo" }> => entry.kind === "nuevo",
  );
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col gap-6 overflow-y-auto px-5 py-5 md:px-8">
      <div className="flex flex-col gap-1">
        <nav aria-label="Ruta" className="flex items-center gap-1.5 text-xs text-ink-2">
          <button
            type="button"
            onClick={() => navigate({ sub: null })}
            className="border-0 bg-transparent p-0 text-ink-2 hover:text-ink"
          >
            Contactos
          </button>
          <Icon name="right" size={10} />
          <span className="font-semibold text-ink">Por revisar</span>
        </nav>
        <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">Por revisar</h1>
        <p className="m-0 max-w-[640px] text-[13px] text-ink-2">
          La aplicación propone; una persona decide. Nada se añade a la agenda sin que alguien lo
          confirme.
        </p>
      </div>
      {join.isError && (
        <p role="alert" className="m-0 text-xs text-bad-ink">
          {join.error instanceof ApiError ? join.error.message : "No se ha podido unir."}
        </p>
      )}
      {duplicates.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-sm font-semibold">Posibles duplicados</h2>
          <ul className="m-0 flex list-none flex-col border-t border-line p-0">
            {duplicates.map((entry) => (
              <li
                key={entry.key}
                className="flex flex-wrap items-center gap-3 border-b border-line-soft py-2.5"
              >
                <span className="flex min-w-0 flex-1 basis-56 flex-col rounded-md border border-line px-3 py-2">
                  <b className="font-semibold">{entry.contact.name}</b>
                  <span className="truncate text-xs text-ink-2">{entry.contact.detail}</span>
                </span>
                <Icon name="merge" size={14} className="text-ink-2" />
                <span className="flex min-w-0 flex-1 basis-56 flex-col rounded-md border border-line px-3 py-2">
                  <b className="font-semibold">{entry.other.name}</b>
                  <span className="truncate text-xs text-ink-2">
                    {entry.other.whatsapp
                      ? `WhatsApp · ${formatPhone(entry.other.address.split("@")[0]!)}`
                      : entry.other.address}{" "}
                    · sin ficha
                  </span>
                </span>
                <span className="w-56 text-xs leading-normal text-ink-2">{entry.reason}</span>
                <span className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={join.isPending}
                    onClick={() => join.mutate(entry)}
                    className={settingsButton.primary}
                  >
                    <Icon name="merge" size={14} />
                    Unir
                  </button>
                  <button
                    type="button"
                    onClick={() => void contactos.dismiss("duplicado", entry.key).then(refresh)}
                    className={`${settingsButton.link} px-2 text-ink-2!`}
                  >
                    No son la misma
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-sm font-semibold">Escriben y no tienen ficha</h2>
        <ul className="m-0 flex list-none flex-col border-t border-line p-0 [&>li]:border-b [&>li]:border-line-soft">
          {fresh.map((entry) => (
            <SuggestionRow key={entry.key} entry={entry} onCreate={() => onCreate(entry)} />
          ))}
        </ul>
        {review.isSuccess && list.length === 0 && (
          <p className="m-0 text-ink-2">No hay nada por revisar.</p>
        )}
      </section>
      <p className="m-0 text-xs text-ink-2">
        «Parece perito» sale de reglas sencillas (asunto, dirección, expedientes en que aparece).
        Más adelante lo podrá proponer la IA.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ página

export function ContactsPage({ isAdmin }: { isAdmin: boolean; userId: string }) {
  const { sub } = useUrlState();
  const [editing, setEditing] = useState<Editing>(null);
  const contactId = sub?.startsWith("c:") ? sub.slice(2) : null;
  return (
    <main className="flex min-h-0 min-w-0 grow bg-panel">
      {contactId ? (
        <ContactCard
          id={contactId}
          onEdit={(contact) => setEditing({ id: contact.id, draft: draftOf(contact) })}
        />
      ) : sub === "revisar" ? (
        <Review
          onCreate={(entry) =>
            setEditing({
              id: null,
              draft: emptyDraft({
                kind: entry.guess && entry.guess !== "cliente" ? "empresa" : "persona",
                name: entry.name,
                roles: entry.guess ? [entry.guess] : [],
                channels: [
                  entry.whatsapp
                    ? {
                        kind: "phone",
                        value: entry.address.split("@")[0]!,
                        label: "WhatsApp",
                        sourceMessageId: entry.messageId,
                      }
                    : {
                        kind: "email",
                        value: entry.address,
                        label: null,
                        sourceMessageId: entry.messageId,
                      },
                ],
              }),
            })
          }
        />
      ) : (
        <ContactList onNew={() => setEditing({ id: null, draft: emptyDraft() })} />
      )}
      {editing && (
        <ContactEditor
          contactId={editing.id}
          initial={editing.draft}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={(detail) => {
            setEditing(null);
            if (!editing.id && sub !== "revisar") openContact(detail.contact.id);
          }}
        />
      )}
    </main>
  );
}
