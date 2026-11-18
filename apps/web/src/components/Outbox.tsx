import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type OutboxItem } from "../api.ts";
import { formatListDate } from "../format.ts";
import { formatRecipients } from "../recipients.ts";
import { Icon } from "./Icon.tsx";

const STATE_TEXT: Record<string, string> = {
  queued: "Sale en unos segundos",
  sending: "Enviando…",
  failed: "No se ha enviado",
};

/** Bandeja de salida: lo que está saliendo y lo que no ha podido salir. */
export function OutboxList({
  accountId,
  onOpen,
  onError,
}: {
  accountId: string;
  onOpen: (id: string) => void;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const outbox = useQuery({
    queryKey: ["outbox", accountId],
    queryFn: () => api.outbox(accountId),
    refetchInterval: 5000,
  });
  const items = outbox.data ?? [];

  const undo = (item: OutboxItem) => {
    api
      .cancelSend(item.id)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["outbox"] });
        onOpen(item.id);
      })
      .catch((error: unknown) =>
        onError(error instanceof ApiError ? error.message : "No se ha podido deshacer el envío."),
      );
  };

  return (
    <section
      aria-label="Bandeja de salida"
      className="flex w-full flex-col bg-panel md:w-[300px] md:shrink-0 md:border-r md:border-line lg:w-[360px]"
    >
      <div className="border-b border-line px-3 pt-3 pb-2.5">
        <h2 className="m-0 text-[15px] font-semibold">Bandeja de salida</h2>
      </div>
      <div className="min-h-0 grow overflow-y-auto">
        {outbox.isSuccess && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Icon name="sent" size={28} className="text-ink-2" />
            <h3 className="m-0 text-sm font-semibold">No hay nada pendiente de salir</h3>
            <p className="m-0 text-xs leading-normal text-ink-2">
              Lo que envías pasa por aquí unos segundos y después queda en Enviados.
            </p>
          </div>
        )}
        {items.map((item) => (
          <div key={item.id} className="flex flex-col gap-1 border-b border-line-soft px-3 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 grow truncate font-semibold">
                {item.subject || "(sin asunto)"}
              </span>
              <span className="text-xs whitespace-nowrap text-ink-2">
                {formatListDate(item.updatedAt)}
              </span>
            </div>
            <div className="truncate text-xs text-ink-2">Para: {formatRecipients(item.to)}</div>
            <div
              className={`text-xs ${item.state === "failed" ? "font-semibold text-warn-ink" : "text-ink-2"}`}
            >
              {STATE_TEXT[item.state] ?? item.state}
              {item.state === "failed" && item.error && (
                <span className="font-normal"> · {item.error}</span>
              )}
            </div>
            {item.state === "failed" && (
              <button
                type="button"
                onClick={() => onOpen(item.id)}
                className="self-start border-0 bg-transparent p-0 text-xs font-semibold text-accent hover:text-accent-strong"
              >
                Abrir para revisarlo y volver a enviar
              </button>
            )}
            {item.state === "queued" && (
              <button
                type="button"
                onClick={() => undo(item)}
                className="self-start border-0 bg-transparent p-0 text-xs font-semibold text-accent hover:text-accent-strong"
              >
                Deshacer el envío
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
