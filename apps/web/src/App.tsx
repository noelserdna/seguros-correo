import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  setCsrfToken,
  type MessageDetail,
  type Outbound,
  type OutboundKind,
  type Session,
} from "./api.ts";
import { Composer } from "./components/Composer.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { OutboxList } from "./components/Outbox.tsx";
import { ContextPanel } from "./components/ContextPanel.tsx";
import { Icon } from "./components/Icon.tsx";
import { Login } from "./components/Login.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ReadingPane } from "./components/ReadingPane.tsx";
import { SearchView } from "./components/SearchView.tsx";
import { FolderPanel, Rail } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { pickLocation, useMailActions } from "./actions.ts";
import { ConfirmDelete, ToastView } from "./components/Feedback.tsx";
import { folderName } from "./folders.ts";
import { plugins, setActivePlugins, usePluginLabels } from "./plugins/index.ts";
import { useLayout } from "./layout.ts";
import { navigate, useUrlState } from "./url-state.ts";

/** Escucha los avisos del servidor y refresca lo que haya en pantalla. */
type LiveEvent = { type: string; payload?: { message?: string; userId?: string | null } };

function useLiveUpdates(onEvent: (event: LiveEvent) => void): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const queryClient = useQueryClient();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const source = new EventSource("/api/stream");
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onopen = () => setOnline(true);
    source.onerror = () => setOnline(false);
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(event.data) as LiveEvent);
      } catch {
        // Un aviso ilegible no impide refrescar.
      }
      // Varios cambios seguidos provocan un solo refresco.
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const key of [
          "accounts",
          "folders",
          "messages",
          "archive",
          "message",
          "thread",
          "search",
          "outbox",
          "plugins",
        ]) {
          void queryClient.invalidateQueries({ queryKey: [key] });
        }
      }, 400);
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [queryClient]);
  return online;
}

function Mailbox({ session }: { session: Session }) {
  const url = useUrlState();
  const { layout, wide } = useLayout();
  const phone = layout === "phone";
  const [contextOpen, setContextOpen] = useState(false);
  // En pantallas estrechas las carpetas viven en un panel lateral que se abre desde la barra.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    setNavOpen(false);
  }, [url.view, url.folderId, url.accountId, url.pluginId, url.composeId, layout]);
  const [opened, setOpened] = useState<MessageDetail | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
    refetchInterval: 30_000,
  });
  const accountId = url.accountId ?? accounts.data?.[0]?.id ?? null;
  const folders = useQuery({
    queryKey: ["folders", accountId],
    queryFn: () => api.folders(accountId!),
    enabled: Boolean(accountId),
  });

  // Al entrar sin carpeta elegida, se abre la Entrada del primer buzón.
  useEffect(() => {
    if (url.view !== "mail" || url.folderId || !accountId || !folders.data) return;
    const inbox = folders.data.find((folder) => folder.specialUse === "inbox") ?? folders.data[0];
    if (inbox) navigate({ accountId, folderId: inbox.id }, { replace: true });
  }, [url.view, url.folderId, accountId, folders.data]);

  const folder = folders.data?.find((entry) => entry.id === url.folderId) ?? null;
  const messages = useInfiniteQuery({
    queryKey: ["messages", url.folderId],
    queryFn: ({ pageParam }) => api.messages(url.folderId!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: url.view === "mail" && Boolean(url.folderId),
  });
  const archive = useInfiniteQuery({
    queryKey: ["archive", accountId],
    queryFn: ({ pageParam }) => api.archive(accountId!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: url.view === "archive" && Boolean(accountId),
  });

  const list = url.view === "archive" ? archive : messages;
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const visibleIds = useMemo(() => items.map((item) => item.id), [items]);
  const labels = usePluginLabels(visibleIds);
  const activePlugin =
    url.view === "plugin" ? plugins.find((plugin) => plugin.id === url.pluginId) : undefined;
  // Un módulo con página propia ocupa todo el ancho: sin carpetas, sin lista ni lectura.
  const pagePlugin = activePlugin?.Page ? activePlugin : undefined;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const select = useCallback((id: string | null) => navigate({ messageId: id }), []);
  const actions = useMailActions({ items, onSelect: select });
  const { showToast, setFlags, remove, undo } = actions;
  const userId = session.user.id;
  const online = useLiveUpdates(
    useCallback(
      (event: LiveEvent) => {
        // Solo se avisa a quien lo pidió; a los demás les basta con ver el estado real.
        if (event.payload?.userId !== userId) return;
        const detail = event.payload.message ?? "";
        if (event.type === "action.failed") {
          showToast({ tone: "error", title: "No se ha podido completar la acción", detail });
        } else if (event.type === "outbound.failed") {
          showToast({
            tone: "error",
            title: "El correo no se ha enviado",
            detail: `${detail} Lo tienes en la Bandeja de salida.`,
          });
        } else if (event.type === "outbound.sent") {
          showToast({ tone: "info", title: "Correo enviado", ms: 4000 });
        }
      },
      [userId, showToast],
    ),
  );
  const canAct = url.view !== "archive";

  // Vuelta de la página de Google o Microsoft tras conectar un buzón.
  const queryClient = useQueryClient();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get("oauth_state");
    const code = params.get("oauth_code");
    const error = params.get("oauth_error");
    if (!state && !error) return;
    // El código es de un solo uso: se quita de la dirección antes de canjearlo.
    window.history.replaceState(null, "", window.location.pathname);
    if (state && code) {
      // Canjear el permiso y probar la entrada al buzón tarda unos segundos.
      showToast({
        tone: "info",
        busy: true,
        title: "Conectando el buzón…",
        detail: "Comprobando el permiso. Tarda unos segundos.",
        ms: 90_000,
      });
    }
    api
      .oauthComplete({
        state: state ?? undefined,
        code: code ?? undefined,
        error: error ?? undefined,
      })
      .then(({ email }) => {
        showToast({
          tone: "info",
          title: `Buzón conectado: ${email}`,
          detail: "Estamos trayendo su correo.",
        });
        void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      })
      .catch((failure: unknown) =>
        showToast({
          tone: "error",
          title: "No se ha podido conectar el buzón",
          detail: failure instanceof ApiError ? failure.message : undefined,
        }),
      );
  }, [showToast, queryClient]);

  const openContext = useCallback(() => setContextOpen(true), []);
  const toolbarExtra = useCallback(
    (message: MessageDetail) =>
      plugins.map(
        (plugin) =>
          plugin.ToolbarAction && (
            <plugin.ToolbarAction key={plugin.id} message={message} openContext={openContext} />
          ),
      ),
    [openContext],
  );

  const openDraft = useCallback((id: string) => navigate({ composeId: id }), []);
  const closeComposer = useCallback(() => navigate({ composeId: null }), []);
  const compose = useCallback(
    (kind: OutboundKind, sourceMessageId?: string) => {
      const target = sourceMessageId ? (opened?.accountId ?? accountId) : accountId;
      if (!target) return;
      api
        .createOutbound(target, kind, sourceMessageId)
        .then((outbound) => openDraft(outbound.id))
        .catch((error: unknown) =>
          showToast({
            tone: "error",
            title: "No se ha podido empezar el correo",
            detail: error instanceof ApiError ? error.message : undefined,
          }),
        );
    },
    [opened, accountId, openDraft, showToast],
  );
  const onSent = useCallback(
    (outbound: Outbound, undoMs: number) => {
      closeComposer();
      showToast({
        tone: "info",
        title: `Enviando en ${Math.round(undoMs / 1000)} segundos…`,
        ms: undoMs,
        undo: () => {
          api
            .cancelSend(outbound.id)
            .then(() => {
              openDraft(outbound.id);
              showToast({ tone: "info", title: "Envío deshecho. Sigue en Borradores." });
            })
            .catch((error: unknown) =>
              showToast({
                tone: "error",
                title: "No se ha podido deshacer el envío",
                detail: error instanceof ApiError ? error.message : undefined,
              }),
            );
        },
      });
    },
    [closeComposer, openDraft, showToast],
  );

  // Abrir un correo lo marca como leído, aquí y en el servidor de correo.
  const autoRead = useRef<string | null>(null);
  useEffect(() => {
    if (!canAct || !opened || opened.id !== url.messageId || autoRead.current === opened.id) return;
    autoRead.current = opened.id;
    const location = pickLocation(opened, url.folderId);
    if (location && !location.flags.includes("\\Seen")) {
      setFlags(opened, location.folderId, ["\\Seen"], []);
    }
  }, [canAct, opened, url.messageId, url.folderId, setFlags]);
  useEffect(() => {
    if (!url.messageId) autoRead.current = null;
  }, [url.messageId]);

  // Supr borra el correo abierto; Ctrl + Z deshace mientras el aviso sigue en pantalla.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select, [contenteditable]") ||
        target?.closest("dialog")
      ) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if (url.composeId) return;
      if (event.key !== "Delete" || !canAct || !opened || opened.id !== url.messageId) return;
      const location = pickLocation(opened, url.folderId);
      if (location) remove(opened, location);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAct, opened, url.messageId, url.folderId, url.composeId, remove, undo]);
  const onLoaded = useCallback((message: MessageDetail) => setOpened(message), []);
  useEffect(() => {
    if (!url.messageId) setOpened(null);
  }, [url.messageId]);
  // En la página de un módulo (Expedientes, Tramitación) el correo abierto lo pinta el módulo:
  // el panel de contexto lo carga aquí para enseñar lo mismo que en la bandeja.
  const pageMessage = useQuery({
    queryKey: ["message", url.messageId],
    queryFn: () => api.message(url.messageId!),
    enabled: url.view === "plugin" && Boolean(url.messageId),
  });
  const contextMessage =
    url.view === "plugin" ? (url.messageId ? (pageMessage.data ?? null) : null) : opened;

  // Esc cierra el panel de contexto.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextOpen(false);
      setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const account = accounts.data?.find((entry) => entry.id === accountId);

  // En el teléfono se ve una sola cosa: la lista, o el correo que se ha abierto.
  const detailOpen = Boolean(url.messageId || url.composeId);
  const showList = !phone || !detailOpen;
  const showDetail = !phone || detailOpen;
  const folderPanel = (
    <FolderPanel
      accounts={accounts.data ?? []}
      onCompose={() => {
        setNavOpen(false);
        compose("new");
      }}
      isAdmin={session.user.role === "admin"}
    />
  );

  return (
    <div className="flex h-full flex-col bg-ground">
      <TopBar
        user={session.user}
        accounts={accounts.data}
        online={online}
        onMenu={layout === "desktop" ? undefined : () => setNavOpen(true)}
        onCompose={layout === "desktop" || !accountId ? undefined : () => compose("new")}
      />
      <div className="relative flex min-h-0 grow">
        {!phone && <Rail />}
        {layout === "desktop" && !pagePlugin && url.view !== "settings" && folderPanel}
        {navOpen && layout !== "desktop" && (
          <div className="fixed inset-0 z-40 flex">
            <div className="flex max-w-[calc(100vw-48px)] shadow-[8px_0_24px_rgba(27,35,48,0.18)]">
              {phone && <Rail />}
              {folderPanel}
            </div>
            <button
              type="button"
              aria-label="Cerrar el menú"
              onClick={() => setNavOpen(false)}
              className="grow border-0 bg-ink/30"
            />
          </div>
        )}

        {url.view === "settings" ? (
          <SettingsView isAdmin={session.user.role === "admin"} />
        ) : pagePlugin?.Page && !url.composeId ? (
          <pagePlugin.Page isAdmin={session.user.role === "admin"} userId={session.user.id} />
        ) : (
          <>
            {!showList ? null : url.view === "outbox" && accountId ? (
              <OutboxList
                accountId={accountId}
                onOpen={openDraft}
                onError={(detail) =>
                  showToast({ tone: "error", title: "No se ha podido deshacer el envío", detail })
                }
              />
            ) : url.view === "search" ? (
              <SearchView
                selectedId={url.messageId}
                onSelect={select}
                compact={phone || Boolean(url.messageId)}
                full={phone}
              />
            ) : activePlugin?.View ? (
              <activePlugin.View
                accountId={accountId}
                selectedId={url.messageId}
                onSelect={select}
              />
            ) : (
              <MessageList
                labels={labels}
                title={url.view === "archive" ? "Archivo" : folder ? folderName(folder) : "Correo"}
                subtitle={
                  url.view === "archive"
                    ? account?.name
                    : folder && folder.unread > 0
                      ? `${folder.unread} sin leer`
                      : undefined
                }
                items={items}
                isLoading={
                  list.isLoading || (url.view === "mail" && !url.folderId && !accounts.isError)
                }
                isError={list.isError}
                hasMore={Boolean(hasNextPage)}
                loadMore={loadMore}
                onRetry={() => void list.refetch()}
                selectedId={url.messageId}
                onSelect={select}
                archived={url.view === "archive"}
                empty={
                  url.view === "archive" ? (
                    <>
                      <Icon name="archive" size={28} className="text-ink-2" />
                      <h3 className="m-0 text-sm font-semibold">El archivo está vacío</h3>
                      <p className="m-0 text-xs leading-normal text-ink-2">
                        Aquí aparecerán los correos que se borren o se vacíen del buzón del
                        servidor. No se pierden: se conservan aquí.
                      </p>
                    </>
                  ) : (
                    <>
                      <Icon name="folder" size={28} className="text-ink-2" />
                      <h3 className="m-0 text-sm font-semibold">No hay correos en esta carpeta</h3>
                      <p className="m-0 text-xs leading-normal text-ink-2">
                        Cuando muevas correos aquí, desde esta ventana o desde Outlook, aparecerán
                        al momento.
                      </p>
                    </>
                  )
                }
              />
            )}

            {!showDetail ? null : url.composeId ? (
              <Composer
                id={url.composeId}
                accounts={accounts.data ?? []}
                onClose={closeComposer}
                onSent={onSent}
              />
            ) : (
              (url.view !== "search" || url.messageId) && (
                <ReadingPane
                  messageId={url.messageId}
                  onSelect={select}
                  onLoaded={onLoaded}
                  actions={canAct ? actions : undefined}
                  folderId={url.view === "mail" ? url.folderId : null}
                  onCompose={compose}
                  onEditDraft={openDraft}
                  toolbarExtra={toolbarExtra}
                  onBack={phone ? () => select(null) : undefined}
                  onContext={phone ? openContext : undefined}
                />
              )
            )}
          </>
        )}

        {contextOpen && (
          <ContextPanel
            message={contextMessage}
            fallback={
              url.view === "plugin" && !url.messageId && activePlugin?.PageContext ? (
                <activePlugin.PageContext sub={url.sub} />
              ) : undefined
            }
            onClose={() => setContextOpen(false)}
            onSelect={select}
            overlay={!wide}
            full={phone}
          />
        )}
        <aside
          aria-label="Pestañas de contexto"
          className="hidden w-10 shrink-0 flex-col items-center gap-1 border-l border-line bg-ground py-2 md:flex"
        >
          <button
            type="button"
            onClick={() => setContextOpen((open) => !open)}
            aria-expanded={contextOpen}
            aria-label={contextOpen ? "Cerrar el panel de contexto" : "Abrir el panel de contexto"}
            title="Contexto"
            className={`flex h-11 w-8 items-center justify-center rounded-md border-0 ${
              contextOpen
                ? "bg-accent-soft text-accent-strong"
                : "bg-transparent text-ink hover:bg-line-soft"
            }`}
          >
            <Icon name="panel" />
          </button>
          {/* Hueco para plugins: cada módulo puede añadir aquí su pestaña. */}
        </aside>
      </div>
      {actions.toast && (
        <ToastView toast={actions.toast} onUndo={actions.undo} onClose={actions.dismissToast} />
      )}
      {actions.pendingDelete && (
        <ConfirmDelete onConfirm={actions.confirmDelete} onCancel={actions.cancelDelete} />
      )}
    </div>
  );
}

export function App() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        const current = await api.session();
        setCsrfToken(current.csrfToken);
        setActivePlugins(current.plugins);
        return current;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: Infinity,
    retry: false,
  });

  if (session.isLoading) return null;
  if (session.isError) {
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <Icon name="alert" size={28} className="text-flag" />
        <h1 className="m-0 text-base font-semibold">
          No hay conexión con el servidor de la oficina
        </h1>
        <p className="m-0 max-w-sm text-ink-2">
          Comprueba que estás en la red de la oficina y vuelve a intentarlo.
        </p>
        <button
          type="button"
          onClick={() => void session.refetch()}
          className="h-9 rounded-md border-0 bg-accent px-4 font-semibold text-white"
        >
          Reintentar
        </button>
      </div>
    );
  }
  if (!session.data) return <Login />;
  return <Mailbox session={session.data} />;
}
