import { useSyncExternalStore } from "react";

/** Dónde está el usuario. Vive en la dirección de la página, para que Atrás y recargar funcionen. */
export type View = "mail" | "archive" | "search" | "outbox" | "plugin" | "settings";
export type UrlState = {
  view: View;
  accountId: string | null;
  folderId: string | null;
  messageId: string | null;
  /** Módulo elegido en el riel cuando la vista es la de un plugin. */
  pluginId: string | null;
  /** Correo que se está escribiendo; ocupa el panel de lectura. */
  composeId: string | null;
  q: string;
  from: string;
  since: string;
  until: string;
  attachments: boolean;
  archive: boolean;
};

const listeners = new Set<() => void>();
let cachedSearch = "";
let cachedState: UrlState | null = null;

function read(): UrlState {
  const search = window.location.search;
  if (cachedState && search === cachedSearch) return cachedState;
  const params = new URLSearchParams(search);
  const view = params.get("v");
  cachedSearch = search;
  cachedState = {
    view:
      view === "archive" ||
      view === "search" ||
      view === "outbox" ||
      view === "plugin" ||
      view === "settings"
        ? view
        : "mail",
    pluginId: params.get("p"),
    composeId: params.get("r"),
    accountId: params.get("b"),
    folderId: params.get("c"),
    messageId: params.get("m"),
    q: params.get("q") ?? "",
    from: params.get("de") ?? "",
    since: params.get("desde") ?? "",
    until: params.get("hasta") ?? "",
    attachments: params.get("adj") === "1",
    archive: params.get("arch") !== "0",
  };
  return cachedState;
}

function write(state: UrlState, replace: boolean): void {
  const params = new URLSearchParams();
  if (state.view !== "mail") params.set("v", state.view);
  if (state.accountId) params.set("b", state.accountId);
  if (state.folderId) params.set("c", state.folderId);
  if (state.messageId) params.set("m", state.messageId);
  if (state.composeId) params.set("r", state.composeId);
  if (state.view === "plugin" && state.pluginId) params.set("p", state.pluginId);
  if (state.view === "search") {
    if (state.q) params.set("q", state.q);
    if (state.from) params.set("de", state.from);
    if (state.since) params.set("desde", state.since);
    if (state.until) params.set("hasta", state.until);
    if (state.attachments) params.set("adj", "1");
    if (!state.archive) params.set("arch", "0");
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function useUrlState(): UrlState {
  return useSyncExternalStore(subscribe, read);
}

/** Cambia parte del estado. Con `replace` no añade un paso al historial (p. ej. al teclear). */
export function navigate(change: Partial<UrlState>, { replace = false } = {}): void {
  write({ ...read(), ...change }, replace);
}
