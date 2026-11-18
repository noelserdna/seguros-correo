/** Acciones que salen de la tramitación hacia el resto del cliente de correo. */
import { api } from "../../api.ts";
import { navigate } from "../../url-state.ts";
import { tramitacion } from "./api.ts";
import { textToHtml } from "./logic.ts";

/**
 * Prepara la reclamación de una espera en el redactor de siempre. El borrador queda
 * enlazado a la tarea: cuando sale, la reclamación se apunta sola.
 */
export async function startChase(taskId: string): Promise<void> {
  const { draft } = await tramitacion.chaseDraft(taskId);
  const outbound = await api.createOutbound(draft.accountId, "new");
  await api.saveOutbound(outbound.id, {
    to: draft.to ? [{ name: "", address: draft.to }] : [],
    cc: [],
    bcc: [],
    subject: draft.subject,
    bodyHtml: textToHtml(draft.text) + outbound.bodyHtml,
  });
  await tramitacion.chaseLink(taskId, outbound.id);
  navigate({ view: "mail", accountId: draft.accountId, composeId: outbound.id, messageId: null });
}

export const openCase = (caseId: string) =>
  navigate({
    view: "plugin",
    pluginId: "tramitacion",
    sub: `exp:${caseId}`,
    messageId: null,
    composeId: null,
  });
