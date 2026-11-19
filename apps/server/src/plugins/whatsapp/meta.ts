/**
 * Los avisos de la API de WhatsApp Business de Meta, convertidos en mensajes con la misma
 * forma vengan de donde vengan: un cliente que escribe (`messages`), la empresa que contesta
 * desde la app del móvil (`smb_message_echoes`, con la coexistencia) o el historial que se
 * trae una vez al conectar el número (`history`). Código puro, sin red ni base de datos.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type MediaRef = { id: string; mime: string; filename: string | null };

export type WaMessage = {
  /** Identificador de Meta («wamid…»): único, sirve para no repetir. */
  id: string;
  direction: "in" | "out";
  /** El teléfono del cliente, solo dígitos con prefijo de país. */
  phone: string;
  /** Su nombre en WhatsApp, si Meta lo manda. */
  name: string | null;
  at: Date;
  kind: string;
  text: string;
  media: MediaRef | null;
  /** El mensaje al que responde, si es una respuesta citada. */
  replyTo: string | null;
  /** Parte del historial traído al conectar. */
  history: boolean;
  raw: unknown;
};

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const digits = (value: unknown) => (str(value) ?? "").replace(/\D/g, "");

/** La firma de Meta: HMAC-SHA256 del cuerpo exacto con el secreto de la aplicación. */
export function validSignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signBody(body: Buffer | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const MEDIA_TYPES = ["image", "document", "audio", "video", "sticker"] as const;
const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "video/mp4": "mp4",
};

/** El texto y el adjunto de un mensaje, sea del tipo que sea. */
function contentOf(message: Json): { text: string; media: MediaRef | null } {
  const type = str(message.type) ?? "unknown";
  if (type === "text") return { text: str(obj(message.text).body) ?? "", media: null };
  if ((MEDIA_TYPES as readonly string[]).includes(type)) {
    const part = obj(message[type]);
    const mime = (str(part.mime_type) ?? "application/octet-stream").split(";")[0]!.trim();
    const id = str(part.id);
    const label = {
      image: "Foto",
      document: "Documento",
      audio: part.voice ? "Nota de voz" : "Audio",
      video: "Vídeo",
      sticker: "Pegatina",
    }[type as (typeof MEDIA_TYPES)[number]];
    const filename =
      str(part.filename) ??
      `${label.toLowerCase().replace(/ /g, "_").normalize("NFD").replace(/[̀-ͯ]/g, "")}.${EXTENSION[mime] ?? "bin"}`;
    return {
      text: str(part.caption) ?? `(${label})`,
      media: id ? { id, mime, filename } : null,
    };
  }
  if (type === "location") {
    const place = obj(message.location);
    const where = [str(place.name), str(place.address)].filter(Boolean).join(", ");
    const lat = place.latitude;
    const lon = place.longitude;
    return {
      text: `Ubicación compartida${where ? `: ${where}` : ""}\nhttps://www.google.com/maps?q=${String(lat)},${String(lon)}`,
      media: null,
    };
  }
  if (type === "contacts") {
    const cards = list(message.contacts).map((card) => {
      const person = obj(card);
      const name = str(obj(person.name).formatted_name) ?? "Sin nombre";
      const phones = list(person.phones)
        .map((phone) => str(obj(phone).phone))
        .filter(Boolean);
      return `${name}${phones.length ? ` (${phones.join(", ")})` : ""}`;
    });
    return { text: `Contacto compartido: ${cards.join("; ")}`, media: null };
  }
  if (type === "reaction") {
    const reaction = obj(message.reaction);
    return {
      text: `Reacción ${str(reaction.emoji) ?? ""} a un mensaje anterior`.trim(),
      media: null,
    };
  }
  if (type === "button") return { text: str(obj(message.button).text) ?? "(Botón)", media: null };
  if (type === "interactive") {
    const reply = obj(obj(message.interactive).button_reply ?? obj(message.interactive).list_reply);
    return { text: str(reply.title) ?? "(Respuesta a un menú)", media: null };
  }
  return { text: `(Mensaje de WhatsApp de tipo «${type}» que no se puede mostrar)`, media: null };
}

function toMessage(
  message: Json,
  business: string,
  names: Map<string, string>,
  fallbackPhone: string | null,
  history: boolean,
): WaMessage | null {
  const id = str(message.id);
  if (!id) return null;
  const from = digits(message.from);
  const direction = from && from === business ? "out" : "in";
  const phone = direction === "in" ? from : digits(message.to) || (fallbackPhone ?? "");
  if (!phone) return null;
  const seconds = Number(message.timestamp);
  const { text, media } = contentOf(message);
  return {
    id,
    direction,
    phone,
    name: names.get(phone) ?? null,
    at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
    kind: str(message.type) ?? "unknown",
    text,
    media,
    replyTo: str(obj(message.context).id),
    history,
    raw: message,
  };
}

/** Todos los mensajes de un aviso de Meta, en el orden en que pasaron. */
export function messagesOf(payload: unknown): WaMessage[] {
  const out: WaMessage[] = [];
  for (const entry of list(obj(payload).entry)) {
    for (const change of list(obj(entry).changes)) {
      const field = str(obj(change).field);
      const value = obj(obj(change).value);
      const business = digits(obj(value.metadata).display_phone_number);
      const names = new Map(
        list(value.contacts).map((contact) => [
          digits(obj(contact).wa_id),
          str(obj(obj(contact).profile).name) ?? "",
        ]),
      );
      if (field === "messages") {
        for (const message of list(value.messages)) {
          const item = toMessage(obj(message), business, names, null, false);
          if (item) out.push(item);
        }
      } else if (field === "smb_message_echoes") {
        for (const message of list(value.message_echoes)) {
          const item = toMessage(obj(message), business, names, null, false);
          if (item) out.push({ ...item, direction: "out" });
        }
      } else if (field === "history") {
        for (const chunk of list(value.history)) {
          for (const thread of list(obj(chunk).threads)) {
            const customer = digits(obj(thread).id);
            for (const message of list(obj(thread).messages)) {
              const item = toMessage(obj(message), business, names, customer, true);
              if (item) out.push(item);
            }
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** «+34 600 111 222» a partir de «34600111222»; sin prefijo conocido, con el «+» delante. */
export function formatPhone(phone: string): string {
  if (phone.startsWith("34") && phone.length === 11) {
    return `+34 ${phone.slice(2, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`;
  }
  return `+${phone}`;
}
