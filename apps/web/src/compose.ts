import { api, type OutboundKind } from "./api.ts";
import { navigate } from "./url-state.ts";

/**
 * Responder o reenviar un correo que se está leyendo en la página de un módulo (un expediente,
 * la ficha de tramitación): se abre el redactor de siempre, en el buzón de ese correo.
 */
export async function composeFromPage(kind: OutboundKind, sourceMessageId: string): Promise<void> {
  const message = await api.message(sourceMessageId);
  const outbound = await api.createOutbound(message.accountId, kind, sourceMessageId);
  navigate({
    view: "mail",
    pluginId: null,
    sub: null,
    accountId: message.accountId,
    folderId: null,
    messageId: sourceMessageId,
    composeId: outbound.id,
  });
}
