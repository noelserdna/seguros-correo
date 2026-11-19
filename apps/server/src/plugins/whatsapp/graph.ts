/**
 * La API de Meta (Graph) para WhatsApp: descargar los adjuntos que llegan, subir los que
 * salen y enviar mensajes. Siempre con el permiso del número de empresa.
 */
import type { Settings } from "./settings.ts";

export class GraphError extends Error {}

const auth = (settings: Settings) => {
  if (!settings.token)
    throw new GraphError("Falta WHATSAPP_TOKEN: el permiso de Meta para este número.");
  return { authorization: `Bearer ${settings.token}` };
};

/** Lo que Meta dice cuando rechaza algo, en una frase. */
async function reason(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? `respuesta ${response.status}`;
}

/** Descarga una foto o documento: primero su dirección, después el fichero. */
export async function downloadMedia(settings: Settings, mediaId: string): Promise<Buffer> {
  const headers = auth(settings);
  const info = await fetch(`${settings.graphUrl}/${encodeURIComponent(mediaId)}`, { headers });
  if (!info.ok) throw new GraphError(`Meta no da el adjunto ${mediaId} (${await reason(info)}).`);
  const { url } = (await info.json()) as { url?: string };
  if (!url) throw new GraphError(`Meta no da la dirección del adjunto ${mediaId}.`);
  const file = await fetch(url, { headers });
  if (!file.ok)
    throw new GraphError(`No se ha podido descargar el adjunto ${mediaId} (${file.status}).`);
  return Buffer.from(await file.arrayBuffer());
}

const numberId = (settings: Settings) => {
  if (!settings.phoneNumberId) {
    throw new GraphError(
      "Falta WHATSAPP_PHONE_NUMBER_ID: el número de empresa desde el que se responde.",
    );
  }
  return settings.phoneNumberId;
};

/** Sube un fichero para mandarlo después. Devuelve su identificador en Meta. */
export async function uploadMedia(
  settings: Settings,
  file: { filename: string; contentType: string; content: Buffer },
): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", file.contentType);
  form.append(
    "file",
    new Blob([new Uint8Array(file.content)], { type: file.contentType }),
    file.filename,
  );
  const response = await fetch(`${settings.graphUrl}/${numberId(settings)}/media`, {
    method: "POST",
    headers: auth(settings),
    body: form,
  });
  if (!response.ok)
    throw new GraphError(`Meta no acepta el adjunto ${file.filename} (${await reason(response)}).`);
  const { id } = (await response.json()) as { id?: string };
  if (!id) throw new GraphError(`Meta no devuelve el identificador de ${file.filename}.`);
  return id;
}

/** Envía un mensaje. Devuelve su identificador de WhatsApp («wamid…»). */
export async function sendMessage(
  settings: Settings,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${settings.graphUrl}/${numberId(settings)}/messages`, {
    method: "POST",
    headers: { ...auth(settings), "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
  });
  if (!response.ok)
    throw new GraphError(`WhatsApp no ha aceptado el mensaje (${await reason(response)}).`);
  const data = (await response.json()) as { messages?: { id?: string }[] };
  const id = data.messages?.[0]?.id;
  if (!id) throw new GraphError("WhatsApp no devuelve el identificador del mensaje enviado.");
  return id;
}

/** Qué tipo de mensaje de WhatsApp corresponde a un fichero. */
export function mediaKind(contentType: string): "image" | "audio" | "video" | "document" {
  if (/^image\/(jpeg|png)$/.test(contentType)) return "image";
  if (/^audio\//.test(contentType)) return "audio";
  if (/^video\/(mp4|3gpp)$/.test(contentType)) return "video";
  return "document";
}
