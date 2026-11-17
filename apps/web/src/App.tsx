import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, setCsrfToken, type MessageDetail, type Session } from "./api.ts";
import { ContextPanel } from "./components/ContextPanel.tsx";
import { Icon } from "./components/Icon.tsx";
import { Login } from "./components/Login.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ReadingPane } from "./components/ReadingPane.tsx";
import { SearchView } from "./components/SearchView.tsx";
import { FolderPanel, Rail } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { folderName } from "./folders.ts";
import { navigate, useUrlState } from "./url-state.ts";

/** A partir de este ancho el panel de contexto cabe al lado; por debajo se superpone. */
const WIDE = 1440;

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= WIDE);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= WIDE);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return wide;
}

/** Escucha los avisos del servidor y refresca lo que haya en pantalla. */
function useLiveUpdates(): boolean {
  const queryClient = useQueryClient();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const source = new EventSource("/api/stream");
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onopen = () => setOnline(true);
    source.onerror = () => setOnline(false);
    source.onmessage = () => {
      // Varios cambios seguidos provocan un solo refresco.
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const key of ["folders", "messages", "archive", "message", "thread", "search"]) {
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
  const wide = useWide();
  const online = useLiveUpdates();
  const [contextOpen, setContextOpen] = useState(false);
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
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const select = useCallback((id: string) => navigate({ messageId: id }), []);
  const onLoaded = useCallback((message: MessageDetail) => setOpened(message), []);
  useEffect(() => {
    if (!url.messageId) setOpened(null);
  }, [url.messageId]);

  // Esc cierra el panel de contexto.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const account = accounts.data?.find((entry) => entry.id === accountId);

  return (
    <div className="flex h-full min-w-[1024px] flex-col bg-ground">
      <TopBar user={session.user} accounts={accounts.data} online={online} />
      <div className="relative flex min-h-0 grow">
        <Rail />
        <FolderPanel accounts={accounts.data ?? []} />

        {url.view === "search" ? (
          <SearchView
            selectedId={url.messageId}
            onSelect={select}
            compact={Boolean(url.messageId)}
          />
        ) : (
          <MessageList
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
                    Aquí aparecerán los correos que se borren o se vacíen del buzón del servidor. No
                    se pierden: se conservan aquí.
                  </p>
                </>
              ) : (
                <>
                  <Icon name="folder" size={28} className="text-ink-2" />
                  <h3 className="m-0 text-sm font-semibold">No hay correos en esta carpeta</h3>
                  <p className="m-0 text-xs leading-normal text-ink-2">
                    Cuando muevas correos aquí, desde esta ventana o desde Outlook, aparecerán al
                    momento.
                  </p>
                </>
              )
            }
          />
        )}

        {(url.view !== "search" || url.messageId) && (
          <ReadingPane messageId={url.messageId} onSelect={select} onLoaded={onLoaded} />
        )}

        {contextOpen && (
          <ContextPanel
            message={opened}
            onClose={() => setContextOpen(false)}
            onSelect={select}
            overlay={!wide}
          />
        )}
        <aside
          aria-label="Pestañas de contexto"
          className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-line bg-ground py-2"
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
