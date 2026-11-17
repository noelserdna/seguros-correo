import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Account, type User } from "../api.ts";
import { formatAgo, initials } from "../format.ts";
import { PRODUCT_NAME } from "../product.ts";
import { navigate, useUrlState } from "../url-state.ts";
import { Icon } from "./Icon.tsx";

type Status = { tone: "ok" | "warn" | "bad"; text: string };

/** Estado de los buzones en una frase, sin jerga. */
export function syncStatus(accounts: Account[] | undefined, online: boolean): Status {
  if (!online) return { tone: "warn", text: "Sin conexión con el servidor de la oficina" };
  if (!accounts) return { tone: "ok", text: "Cargando…" };
  if (accounts.length === 0) return { tone: "warn", text: "No tienes ningún buzón asignado" };
  const expired = accounts.find((account) => account.state === "auth_error");
  if (expired) return { tone: "bad", text: `La contraseña del buzón «${expired.name}» ya no vale` };
  if (accounts.some((account) => account.state === "offline")) {
    return { tone: "warn", text: "Sin conexión · reintentando" };
  }
  const dates = accounts.flatMap((account) => (account.lastSyncAt ? [account.lastSyncAt] : []));
  if (dates.length === 0) return { tone: "ok", text: "Trayendo tu correo…" };
  return { tone: "ok", text: `Al día · ${formatAgo(dates.sort()[0]!)}` };
}

const DOT = { ok: "bg-ok", warn: "bg-flag", bad: "bg-bad-ink" };

export function TopBar({
  user,
  accounts,
  online,
}: {
  user: User;
  accounts: Account[] | undefined;
  online: boolean;
}) {
  const url = useUrlState();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(url.q);
  const status = syncStatus(accounts, online);

  useEffect(() => setText(url.q), [url.q]);

  // «/» lleva al buscador desde cualquier sitio, salvo si ya se está escribiendo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable]");
      if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(["session"], null);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = text.trim();
    if (q) navigate({ view: "search", q, messageId: null });
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel pr-3">
      <div className="flex h-12 w-64 shrink-0 items-center gap-2.5 pl-3">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent text-white">
          <Icon name="mail" size={14} />
        </span>
        <span className="text-sm font-semibold tracking-[-0.01em]">{PRODUCT_NAME}</span>
      </div>

      <form
        role="search"
        onSubmit={submit}
        className="flex h-8 max-w-[560px] grow items-center gap-2 rounded-md border border-line bg-ground px-2.5 text-ink-2 focus-within:border-accent"
      >
        <Icon name="search" />
        <label htmlFor="buscador" className="sr-only">
          Buscar en todos los buzones
        </label>
        <input
          id="buscador"
          ref={input}
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Buscar en todos los buzones, también en el archivo"
          className="min-w-0 grow border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-2"
        />
        <kbd className="rounded border border-line-strong px-[5px] py-px font-sans text-[11px] text-ink-2">
          /
        </kbd>
      </form>

      <div className="grow" />

      <div
        role="status"
        className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2"
        title={status.text}
      >
        <span className={`size-2 shrink-0 rounded-full ${DOT[status.tone]}`} />
        <span className="truncate">{status.text}</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
          {initials(user.name, user.email)}
        </span>
        <span className="max-w-40 truncate">{user.name}</span>
        <button
          type="button"
          onClick={() => logout.mutate()}
          aria-label="Salir"
          title="Salir"
          className="flex size-8 items-center justify-center rounded-md border-0 bg-transparent text-ink-2 hover:bg-ground hover:text-ink"
        >
          <Icon name="logout" />
        </button>
      </div>
    </header>
  );
}
