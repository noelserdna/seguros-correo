/**
 * Módulo de WhatsApp en la interfaz: la etiqueta «WhatsApp» en los correos que vienen de un
 * chat, y su apartado en Configuración con lo que falta para conectarlo y lo que ha llegado.
 * Los mensajes en sí son correos normales: se leen, se buscan y van a expedientes como tales.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { Rows, SettingsBlock, settingsButton } from "../components/settings.tsx";
import type { WebPlugin } from "./types.ts";

const BASE = "/plugins/whatsapp";
const KEY = ["plugins", "whatsapp"];

type Status = {
  webhookUrl: string;
  mailbox: string | null;
  mailboxName: string | null;
  mailboxFound: boolean;
  folder: string;
  verifyToken: boolean;
  appSecret: boolean;
  token: boolean;
  incoming: number;
  outgoing: number;
  contacts: number;
  last: string | null;
  pending: number;
  failed: number;
  lastError: string | null;
};

function Check({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <li className="flex min-h-12 items-start gap-3 py-2">
      <span className="mt-0.5 shrink-0">
        {ok ? (
          <Icon name="circleCheck" size={16} className="text-ok" label="Hecho" />
        ) : (
          <Icon name="circle" size={16} className="text-ink-2" label="Falta" />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="font-semibold">{title}</b>
        <span className="text-xs leading-normal text-ink-2">{detail}</span>
      </span>
    </li>
  );
}

function WhatsAppSettings({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: [...KEY, "status"],
    queryFn: () => apiGet<Status>(`${BASE}/status`),
    refetchInterval: 5000,
  });
  const retry = useMutation({
    mutationFn: () => apiPost(`${BASE}/retry`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const [copied, setCopied] = useState(false);
  const data = status.data;
  if (status.isError) {
    return (
      <p role="alert" className="m-0 text-ink-2">
        No se ha podido consultar el estado de WhatsApp.
      </p>
    );
  }
  if (!data) return null;
  const copy = () => {
    navigator.clipboard.writeText(data.webhookUrl).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <>
      {data.contacts > 0 && (
        <dl className="m-0 grid grid-cols-2 gap-y-4 sm:grid-cols-4">
          {[
            [data.contacts, "contactos"],
            [data.incoming, "mensajes recibidos"],
            [data.outgoing, "respuestas desde el móvil"],
            [
              data.last
                ? new Date(data.last).toLocaleString("es-ES", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })
                : "—",
              "último mensaje",
            ],
          ].map(([value, label]) => (
            <div
              key={label}
              className="flex flex-col gap-0.5 border-l border-line pl-4 first:border-l-0 first:pl-0"
            >
              <dd className="m-0 text-[22px] font-semibold tabular-nums">{value}</dd>
              <dt className="text-xs text-ink-2">{label}</dt>
            </div>
          ))}
        </dl>
      )}
      {(data.pending > 0 || data.failed > 0) && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border border-warn-line bg-warn px-3 py-2 text-xs text-warn-ink"
        >
          <Icon name="triangle" size={13} className="text-flag" />
          <span className="min-w-0 grow">
            {data.failed > 0
              ? `${data.failed} avisos no se han podido guardar como correo${data.lastError ? `: ${data.lastError}` : "."}`
              : `${data.pending} avisos guardándose como correo.`}
          </span>
          {isAdmin && data.failed > 0 && (
            <button
              type="button"
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
              className={settingsButton.link}
            >
              Reintentar
            </button>
          )}
        </div>
      )}
      <SettingsBlock
        title="Conexión con Meta"
        description="Con la coexistencia, el número sigue en la app WhatsApp Business del móvil y además cada mensaje llega aquí. Los grupos no entran."
      >
        <Rows>
          <Check
            ok={data.mailboxFound}
            title={
              data.mailboxFound
                ? `Se guardan en ${data.mailboxName ?? data.mailbox} › ${data.folder}`
                : "Buzón donde se guardan"
            }
            detail={
              data.mailboxFound
                ? "Un hilo por contacto. Lo que contesta la empresa desde el móvil entra en el mismo hilo."
                : data.mailbox
                  ? `No hay ningún buzón ${data.mailbox} dado de alta.`
                  : "Falta WHATSAPP_MAILBOX en la configuración del servidor."
            }
          />
          <Check
            ok={data.appSecret}
            title="Firma de los avisos"
            detail="WHATSAPP_APP_SECRET: el secreto de la aplicación de Meta. Sin él no se acepta ningún aviso."
          />
          <Check
            ok={data.verifyToken}
            title="Comprobación de la dirección"
            detail="WHATSAPP_VERIFY_TOKEN: la palabra que se pone en Meta al dar de alta la dirección de avisos."
          />
          <Check
            ok={data.token}
            title="Permiso para traer fotos y documentos"
            detail="WHATSAPP_TOKEN: sin él llegan los textos, pero no los adjuntos."
          />
        </Rows>
      </SettingsBlock>
      <SettingsBlock
        title="Dirección de avisos"
        description="En la aplicación de Meta, en WhatsApp › Configuración › Webhooks: suscribir messages, smb_message_echoes y history."
      >
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 rounded-md border border-line bg-ground px-2.5 py-1.5 text-xs break-all select-all">
            {data.webhookUrl}
          </code>
          <button type="button" onClick={copy} className={settingsButton.secondary}>
            {copied ? "Copiada" : "Copiar"}
          </button>
        </div>
        <p className="m-0 text-xs leading-normal text-ink-2">
          Tiene que ser accesible desde internet con https. Para probar, un túnel de Cloudflare al
          servidor; se configura con PUBLIC_URL.
        </p>
      </SettingsBlock>
    </>
  );
}

export const whatsappPlugin: WebPlugin = {
  id: "whatsapp",
  settings: [
    {
      id: "whatsapp",
      group: "Correo",
      label: "WhatsApp",
      description:
        "Los mensajes del WhatsApp de empresa, guardados como correos para tenerlo todo en un sitio.",
      adminOnly: true,
      Component: WhatsAppSettings,
    },
  ],

  useLabels(messageIds) {
    const ids = useMemo(() => [...messageIds].sort(), [messageIds]);
    const labels = useQuery({
      queryKey: [...KEY, "labels", ids],
      queryFn: () =>
        apiPost<{ labels: Record<string, string[]> }>(`${BASE}/labels`, {
          messageIds: ids.slice(0, 500),
        }),
      enabled: ids.length > 0,
      placeholderData: (previous) => previous,
    });
    return useMemo(() => new Map(Object.entries(labels.data?.labels ?? {})), [labels.data]);
  },
};
