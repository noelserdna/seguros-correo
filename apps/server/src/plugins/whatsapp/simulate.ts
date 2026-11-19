/**
 * Avisos con la misma forma que los de Meta, para las pruebas y el simulador local.
 * Referencia: los campos `messages`, `smb_message_echoes` y `history` del webhook de la
 * API de WhatsApp Business (coexistencia).
 */
export type SimMessage = {
  id: string;
  from: string;
  to?: string;
  timestamp: number;
  type: string;
  [key: string]: unknown;
};

const envelope = (business: string, field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA-DEMO",
      changes: [
        {
          field,
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: business, phone_number_id: "PHONE-DEMO" },
            ...value,
          },
        },
      ],
    },
  ],
});

/** Lo que escribe un cliente. */
export const incoming = (
  business: string,
  contacts: { phone: string; name: string }[],
  messages: SimMessage[],
) =>
  envelope(business, "messages", {
    contacts: contacts.map((contact) => ({
      profile: { name: contact.name },
      wa_id: contact.phone,
    })),
    messages,
  });

/** Lo que contesta la empresa desde la app del móvil. */
export const echoes = (business: string, messages: SimMessage[]) =>
  envelope(business, "smb_message_echoes", { message_echoes: messages });

/** El historial que llega una vez, al conectar el número. */
export const history = (business: string, threads: { phone: string; messages: SimMessage[] }[]) =>
  envelope(business, "history", {
    history: [
      {
        metadata: { phase: 0, chunk_order: 1, progress: 100 },
        threads: threads.map((thread) => ({ id: thread.phone, messages: thread.messages })),
      },
    ],
  });

let counter = 0;
/** Un identificador con el aspecto de los de Meta. */
export const wamid = () =>
  `wamid.HBgL${Date.now().toString(36).toUpperCase()}${(counter++).toString(36).toUpperCase()}AA==`;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export const text = (from: string, at: Date, body: string, to?: string): SimMessage => ({
  id: wamid(),
  from,
  ...(to ? { to } : {}),
  timestamp: seconds(at),
  type: "text",
  text: { body },
});

export const media = (
  from: string,
  at: Date,
  type: "image" | "document" | "audio",
  mediaId: string,
  mime: string,
  extra: { caption?: string; filename?: string; voice?: boolean } = {},
  to?: string,
): SimMessage => ({
  id: wamid(),
  from,
  ...(to ? { to } : {}),
  timestamp: seconds(at),
  type,
  [type]: { id: mediaId, mime_type: mime, ...extra },
});

export const location = (
  from: string,
  at: Date,
  latitude: number,
  longitude: number,
  name: string,
): SimMessage => ({
  id: wamid(),
  from,
  timestamp: seconds(at),
  type: "location",
  location: { latitude, longitude, name },
});
