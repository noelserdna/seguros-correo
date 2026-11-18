/** Llamada a un modelo de visión por la API de chat estándar (OpenRouter, o un servidor local). */

export type VisionSettings = {
  apiUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Imágenes a la vez. */
  concurrency: number;
  /** Páginas por documento como máximo: un escaneado enorme no debe agotar el presupuesto. */
  maxPages: number;
  /** Espera antes de reintentar un fallo pasajero; crece con cada intento. */
  retryDelayMs: number;
  /** Intentos antes de dar un documento por fallido. */
  maxAttempts: number;
};

/** Fallo que puede arreglarse solo: límite de peticiones, servidor caído, corte de red. */
export class TransientError extends Error {}

export type ModelReply = { output: string; cost: number; tokensIn: number; tokensOut: number };

export async function askModel(
  settings: VisionSettings,
  prompt: string,
  image: { data: Buffer; mime: string },
): Promise<ModelReply> {
  let response: Response;
  try {
    response = await fetch(`${settings.apiUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        max_tokens: 3000,
        usage: { include: true },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${image.mime};base64,${image.data.toString("base64")}` },
              },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    throw new TransientError(`Sin respuesta del modelo: ${String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string };
  };
  if (response.status === 429 || response.status >= 500) {
    throw new TransientError(body.error?.message ?? `El modelo responde ${response.status}`);
  }
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `El modelo responde ${response.status}`);
  }
  return {
    output: body.choices?.[0]?.message?.content ?? "",
    cost: body.usage?.cost ?? 0,
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
  };
}
