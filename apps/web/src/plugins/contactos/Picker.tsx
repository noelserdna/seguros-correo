/** Buscar una ficha de la agenda y elegirla: para «Es de…» y para el cliente de un expediente. */
import { useState } from "react";
import { settingsButton, settingsField } from "../../components/settings.tsx";
import { roleLabel, useContactSearch, type ContactRow } from "./api.ts";

export function ContactPicker({
  placeholder = "Buscar en la agenda",
  onPick,
  onCreate,
  onClose,
  inline = false,
}: {
  /** En una columna estrecha (el panel de contexto) va en su sitio y a todo el ancho. */
  inline?: boolean;
  placeholder?: string;
  onPick: (contact: ContactRow) => void;
  onCreate?: (name: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const results = useContactSearch(q, undefined, q.trim().length > 0);
  return (
    <div
      role="dialog"
      aria-label="Elegir contacto"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className={`${inline ? "w-full" : "absolute top-full right-0 z-30 mt-1 w-[340px]"} flex flex-col gap-1.5 rounded-lg border border-line-strong bg-panel p-2.5 text-left text-[13px] shadow-[0_8px_24px_rgba(27,35,48,0.16)]`}
    >
      <input
        autoFocus
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder={placeholder}
        className={settingsField}
      />
      <div className="flex max-h-60 flex-col overflow-y-auto">
        {results.data?.contacts.slice(0, 8).map((contact) => (
          <button
            key={contact.id}
            type="button"
            onClick={() => onPick(contact)}
            className="flex flex-col gap-0.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-ground"
          >
            <b className="font-semibold">{contact.name}</b>
            <span className="truncate text-xs text-ink-2">
              {[contact.companyName, contact.roles.map(roleLabel).join(", "), contact.email]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
        ))}
        {q.trim() && results.isSuccess && results.data.contacts.length === 0 && (
          <span className="px-2 py-1.5 text-xs text-ink-2">Nadie con ese nombre en la agenda.</span>
        )}
      </div>
      {onCreate && q.trim() && (
        <button
          type="button"
          onClick={() => onCreate(q.trim())}
          className={`${settingsButton.link} px-2 text-left`}
        >
          + Crear ficha «{q.trim()}»
        </button>
      )}
    </div>
  );
}
