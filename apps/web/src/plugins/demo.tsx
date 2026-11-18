import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { displayName, formatListDate } from "../format.ts";
import type { WebPlugin } from "./types.ts";

/** Plugin de demostración: expedientes. Usa solo sus propias rutas y los huecos de la interfaz. */

type Case = { id: string; number: string; title: string };
type CaseSummary = Case & { messageCount: number; lastMessageAt: string | null };
type CaseMessage = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: string;
  how: "manual" | "thread" | "reference";
};
type CaseOfMessage = { case: Case | null; messages: CaseMessage[] };

const BASE = "/plugins/demo";
const KEY = ["plugins", "demo"] as const;
const HOW: Record<string, string> = {
  manual: "añadido a mano",
  thread: "por conversación",
  reference: "por el número en el asunto",
};

const useCaseOf = (messageId: string) =>
  useQuery({
    queryKey: [...KEY, "by-message", messageId],
    queryFn: () => apiGet<CaseOfMessage>(`${BASE}/by-message/${messageId}`),
  });

function MessageLine({
  entry,
  current,
  onSelect,
}: {
  entry: CaseMessage;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      aria-current={current ? "true" : undefined}
      className={`flex flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left text-xs text-ink ${
        current ? "border-accent bg-accent-soft" : "border-line bg-panel hover:bg-ground"
      }`}
    >
      <span className="flex gap-2">
        <span className="min-w-0 grow truncate font-semibold">
          {displayName(entry.fromName, entry.fromAddress)}
        </span>
        <span className="whitespace-nowrap text-ink-2">{formatListDate(entry.internalDate)}</span>
      </span>
      <span className="truncate text-ink-2">
        {entry.subject || "(sin asunto)"} · {HOW[entry.how] ?? entry.how}
      </span>
    </button>
  );
}

export const demoPlugin: WebPlugin = {
  id: "demo",
  rail: { icon: "case", label: "Expedientes" },

  View({ accountId, selectedId, onSelect }) {
    const [openId, setOpenId] = useState<string | null>(null);
    const cases = useQuery({
      queryKey: [...KEY, "cases", accountId],
      queryFn: () =>
        apiGet<{ cases: CaseSummary[] }>(
          `${BASE}/cases${accountId ? `?accountId=${accountId}` : ""}`,
        ),
    });
    const detail = useQuery({
      queryKey: [...KEY, "case", openId],
      queryFn: () => apiGet<{ messages: CaseMessage[] }>(`${BASE}/cases/${openId}`),
      enabled: Boolean(openId),
    });
    const list = cases.data?.cases ?? [];

    return (
      <section
        aria-label="Expedientes"
        className="flex w-[360px] shrink-0 flex-col border-r border-line bg-panel"
      >
        <div className="border-b border-line px-3 pt-3 pb-2.5">
          <h2 className="m-0 text-[15px] font-semibold">Expedientes</h2>
        </div>
        <div className="min-h-0 grow overflow-y-auto">
          {cases.isSuccess && list.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Icon name="case" size={28} className="text-ink-2" />
              <h3 className="m-0 text-sm font-semibold">Todavía no hay expedientes</h3>
              <p className="m-0 text-xs leading-normal text-ink-2">
                Abre un correo y pulsa «Crear expediente» en su barra. Entrará con toda su
                conversación.
              </p>
            </div>
          )}
          {list.map((item) => {
            const open = item.id === openId;
            return (
              <div key={item.id} className="border-b border-line-soft">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : item.id)}
                  className={`flex w-full flex-col gap-0.5 border-0 border-l-[3px] px-3 py-2.5 text-left text-ink ${
                    open
                      ? "border-l-accent bg-accent-soft"
                      : "border-l-transparent bg-panel hover:bg-ground"
                  }`}
                >
                  <span className="flex gap-2">
                    <span className="font-semibold">{item.number}</span>
                    <span className="grow" />
                    <span className="text-xs text-ink-2">
                      {item.lastMessageAt ? formatListDate(item.lastMessageAt) : ""}
                    </span>
                  </span>
                  <span className="truncate">{item.title}</span>
                  <span className="text-xs text-ink-2">
                    {item.messageCount === 1 ? "1 correo" : `${item.messageCount} correos`}
                  </span>
                </button>
                {open && (
                  <div className="flex flex-col gap-1.5 bg-ground px-3 py-2.5">
                    {(detail.data?.messages ?? []).map((entry) => (
                      <MessageLine
                        key={entry.id}
                        entry={entry}
                        current={entry.id === selectedId}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  },

  useLabels(messageIds) {
    const ids = useMemo(() => [...messageIds].sort(), [messageIds]);
    const labels = useQuery({
      queryKey: [...KEY, "labels", ids],
      queryFn: () =>
        apiPost<{ labels: Record<string, { number: string }> }>(`${BASE}/labels`, {
          messageIds: ids.slice(0, 500),
        }),
      enabled: ids.length > 0,
      placeholderData: (previous) => previous,
    });
    return useMemo(
      () =>
        new Map(Object.entries(labels.data?.labels ?? {}).map(([id, label]) => [id, label.number])),
      [labels.data],
    );
  },

  ToolbarAction({ message, openContext }) {
    const queryClient = useQueryClient();
    const current = useCaseOf(message.id);
    const create = useMutation({
      mutationFn: () => apiPost<{ case: Case }>(`${BASE}/cases`, { messageId: message.id }),
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: KEY });
        openContext();
      },
    });
    if (current.data?.case) {
      return (
        <button
          type="button"
          onClick={openContext}
          title="Ver el expediente en el panel de contexto"
          className="flex h-[30px] items-center gap-1.5 rounded-md border-0 bg-accent-soft px-2.5 font-semibold whitespace-nowrap text-accent-strong"
        >
          <Icon name="case" />
          {current.data.case.number}
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => create.mutate()}
        disabled={create.isPending || current.isLoading}
        className="flex h-[30px] items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 font-semibold whitespace-nowrap text-ink hover:bg-ground disabled:opacity-60"
      >
        <Icon name="case" />
        {create.isError ? "No se pudo crear. Reintentar" : "Crear expediente"}
      </button>
    );
  },

  ContextSection({ message, onSelect }) {
    const current = useCaseOf(message.id);
    if (!current.data?.case) return null;
    return (
      <section className="flex flex-col gap-2">
        <h3 className="m-0 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
          Expediente
        </h3>
        <span className="font-semibold">
          {current.data.case.number} · {current.data.case.title}
        </span>
        {current.data.messages.map((entry) => (
          <MessageLine
            key={entry.id}
            entry={entry}
            current={entry.id === message.id}
            onSelect={onSelect}
          />
        ))}
        <span className="text-xs leading-normal text-ink-2">
          Los correos nuevos de esta conversación, o con el número en el asunto, entran solos.
        </span>
      </section>
    );
  },
};
