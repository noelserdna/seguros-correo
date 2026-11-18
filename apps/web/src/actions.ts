import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type MessageDetail,
  type MessageItem,
  type MessageLocation,
  type MessagePage,
  type UserFlag,
} from "./api.ts";

export type Toast = {
  tone: "info" | "error";
  title: string;
  detail?: string;
  /** Lo que hace «Deshacer» mientras el aviso siga en pantalla. */
  undo?: () => void;
  /** Algo está en marcha: se muestra girando y sin botón de cerrar. */
  busy?: boolean;
  /** Tiempo en pantalla, si no es el habitual. */
  ms?: number;
};

export type PendingDelete = { message: MessageDetail; location: MessageLocation };

const TOAST_MS = 8000;
const ERROR_TOAST_MS = 12_000;

/** Carpeta desde la que se actúa: la que se está viendo si el correo está en ella; si no, la primera. */
export function pickLocation(
  message: MessageDetail,
  preferredFolderId: string | null,
): MessageLocation | null {
  return (
    message.locations.find((location) => location.folderId === preferredFolderId) ??
    message.locations[0] ??
    null
  );
}

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : "Algo ha fallado. Inténtalo de nuevo.";

/**
 * Acciones sobre correos. Cada una cambia la pantalla al instante y avisa al servidor,
 * que la refleja en el buzón; si el servidor la rechaza, la pantalla vuelve a lo real.
 */
export function useMailActions({
  items,
  onSelect,
}: {
  /** Lista que se está viendo, para abrir el siguiente al quitar uno. */
  items: MessageItem[];
  onSelect: (id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<Toast | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestItems = useRef(items);
  latestItems.current = items;

  const show = useCallback((next: Toast | null) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(next);
    if (next) {
      timer.current = setTimeout(
        () => setToast(null),
        next.ms ?? (next.tone === "error" ? ERROR_TOAST_MS : TOAST_MS),
      );
    }
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const refresh = useCallback(
    (...keys: string[]) => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
    },
    [queryClient],
  );
  const refreshAll = useCallback(
    () => refresh("folders", "messages", "message", "thread", "search"),
    [refresh],
  );

  /** Cambia o quita un correo de la lista de una carpeta, sin esperar al servidor. */
  const patchList = useCallback(
    (folderId: string, messageId: string, change: (item: MessageItem) => MessageItem | null) => {
      queryClient.setQueryData<InfiniteData<MessagePage>>(["messages", folderId], (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.flatMap((item) => {
                  if (item.id !== messageId) return [item];
                  const next = change(item);
                  return next ? [next] : [];
                }),
              })),
            }
          : data,
      );
    },
    [queryClient],
  );

  const failed = useCallback(
    (title: string, error: unknown) => {
      show({ tone: "error", title, detail: errorText(error) });
      refreshAll();
    },
    [show, refreshAll],
  );

  const setFlags = useCallback(
    (message: MessageDetail, folderId: string, add: UserFlag[], remove: UserFlag[]) => {
      const apply = (flags: string[]) =>
        [...new Set([...flags, ...add])].filter((flag) => !remove.includes(flag as UserFlag));
      patchList(folderId, message.id, (item) => ({ ...item, flags: apply(item.flags) }));
      queryClient.setQueryData<MessageDetail>(["message", message.id], (detail) =>
        detail
          ? {
              ...detail,
              locations: detail.locations.map((location) =>
                location.folderId === folderId
                  ? { ...location, flags: apply(location.flags) }
                  : location,
              ),
            }
          : detail,
      );
      api
        .setFlags(message.id, folderId, add, remove)
        .then(() => refresh("folders"))
        .catch((error: unknown) => failed("No se ha podido cambiar la marca", error));
    },
    [patchList, queryClient, refresh, failed],
  );

  /** Quita el correo de la lista y abre el siguiente. */
  const takeOut = useCallback(
    (message: MessageDetail, folderId: string) => {
      const list = latestItems.current;
      const index = list.findIndex((item) => item.id === message.id);
      if (index >= 0) onSelect((list[index + 1] ?? list[index - 1])?.id ?? null);
      patchList(folderId, message.id, () => null);
    },
    [onSelect, patchList],
  );

  /** Devuelve a su carpeta un correo movido o borrado. */
  const undoAction = useCallback(
    (actionId: string, messageId: string) => () => {
      show(null);
      api
        .undo(actionId)
        .then(() => {
          show({ tone: "info", title: "Deshecho: el correo vuelve a su carpeta" });
          refreshAll();
          onSelect(messageId);
        })
        .catch((error: unknown) => failed("No se ha podido deshacer", error));
    },
    [show, refreshAll, onSelect, failed],
  );

  const move = useCallback(
    (message: MessageDetail, location: MessageLocation, target: { id: string; name: string }) => {
      takeOut(message, location.folderId);
      api
        .move(message.id, location.folderId, target.id)
        .then(({ action }) => {
          show({
            tone: "info",
            title: `Movido a «${target.name}»`,
            undo: action?.undoable ? undoAction(action.id, message.id) : undefined,
          });
          refresh("folders", "message", "search");
        })
        .catch((error: unknown) => failed("No se ha podido mover el correo", error));
    },
    [takeOut, show, refresh, failed, undoAction],
  );

  const sendDelete = useCallback(
    (message: MessageDetail, location: MessageLocation, permanent: boolean) => {
      takeOut(message, location.folderId);
      api
        .remove(message.id, location.folderId, permanent)
        .then(({ action }) => {
          show({
            tone: "info",
            title: action?.type === "move" ? "Enviado a la Papelera" : "Borrado del buzón",
            detail: action?.type === "move" ? undefined : "Se conserva en el archivo.",
            undo: action?.undoable ? undoAction(action.id, message.id) : undefined,
          });
          refresh("folders", "message", "search", "archive");
        })
        .catch((error: unknown) => {
          // No hay Papelera a la que enviarlo: sería definitivo, así que se pregunta.
          if (error instanceof ApiError && error.code === "confirm_permanent") {
            refreshAll();
            setPendingDelete({ message, location });
            return;
          }
          failed("No se ha podido borrar el correo", error);
        });
    },
    [takeOut, show, refresh, refreshAll, failed, undoAction],
  );

  /** Borrar: a la Papelera; si ya está en ella, se pide confirmación antes. */
  const remove = useCallback(
    (message: MessageDetail, location: MessageLocation) => {
      if (location.specialUse === "trash") setPendingDelete({ message, location });
      else sendDelete(message, location, false);
    },
    [sendDelete],
  );

  const confirmDelete = useCallback(() => {
    if (pendingDelete) sendDelete(pendingDelete.message, pendingDelete.location, true);
    setPendingDelete(null);
  }, [pendingDelete, sendDelete]);

  const undo = useCallback(() => toast?.undo?.(), [toast]);

  return useMemo(
    () => ({
      toast,
      dismissToast: () => show(null),
      showToast: show,
      pendingDelete,
      cancelDelete: () => setPendingDelete(null),
      confirmDelete,
      setFlags,
      move,
      remove,
      undo,
    }),
    [toast, show, pendingDelete, confirmDelete, setFlags, move, remove, undo],
  );
}

export type MailActions = ReturnType<typeof useMailActions>;
