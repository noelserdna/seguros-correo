/**
 * Módulo de WhatsApp: los mensajes del número de empresa se guardan como correos en una
 * carpeta del buzón, un hilo por contacto, para que todo esté en un solo sitio y siga el
 * mismo camino que el correo (expedientes, lectura de adjuntos, búsqueda, tramitación).
 *
 * Meta avisa en `/api/plugins/whatsapp/webhook`. Cada aviso se guarda tal cual, firmado, y
 * después se convierte: así no se pierde nada aunque el buzón no responda en ese momento.
 */
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveAuth } from "../../accounts/auth.ts";
import type { Db } from "../../db/client.ts";
import { HttpError, requireSession, type AppDeps } from "../../http/app.ts";
import { imapClient, type Account } from "../../imap/connection.ts";
import type { ServerPlugin } from "../host.ts";
import { buildMail, mailIdOf } from "./mail.ts";
import { messagesOf, validSignature, type WaMessage } from "./meta.ts";

const MAX_ATTEMPTS = 5;

async function setup(db: Db): Promise<void> {
  // Cada aviso de Meta tal como llegó: es la prueba del origen de cada mensaje.
  await db.execute(sql`
    create table if not exists wa_events (
      id bigserial primary key,
      received_at timestamptz not null default now(),
      payload jsonb not null,
      processed_at timestamptz,
      attempts integer not null default 0,
      error text
    )`);
  await db.execute(sql`
    create index if not exists wa_events_pending on wa_events (id) where processed_at is null`);
  // Cada mensaje ya convertido en correo, con el identificador de correo que se le dio.
  await db.execute(sql`
    create table if not exists wa_messages (
      wamid text primary key,
      account_id uuid not null references accounts(id) on delete cascade,
      phone text not null,
      direction text not null,
      kind text not null,
      at timestamptz not null,
      mail_id text not null,
      raw jsonb not null,
      created_at timestamptz not null default now()
    )`);
  await db.execute(sql`create index if not exists wa_messages_mail on wa_messages (mail_id)`);
  // Un hilo por contacto: su nombre y el primer y último correo, para encadenar los nuevos.
  await db.execute(sql`
    create table if not exists wa_threads (
      account_id uuid not null references accounts(id) on delete cascade,
      phone text not null,
      name text,
      first_mail_id text not null,
      last_mail_id text not null,
      last_at timestamptz not null,
      primary key (account_id, phone)
    )`);
}

type Settings = {
  mailbox: string | undefined;
  folder: string;
  verifyToken: string | undefined;
  appSecret: string | undefined;
  token: string | undefined;
  graphUrl: string;
};

function settingsOf(context: AppDeps): Settings {
  const config = context.config;
  return {
    mailbox: config?.WHATSAPP_MAILBOX,
    folder: config?.WHATSAPP_FOLDER ?? "WhatsApp",
    verifyToken: config?.WHATSAPP_VERIFY_TOKEN,
    appSecret: config?.WHATSAPP_APP_SECRET,
    token: config?.WHATSAPP_TOKEN,
    graphUrl: (config?.WHATSAPP_GRAPH_URL ?? "https://graph.facebook.com/v21.0").replace(/\/$/, ""),
  };
}

/** Descarga una foto o documento de Meta: primero su dirección, después el fichero. */
async function download(settings: Settings, mediaId: string): Promise<Buffer> {
  if (!settings.token) throw new Error("Falta WHATSAPP_TOKEN para descargar adjuntos.");
  const headers = { authorization: `Bearer ${settings.token}` };
  const info = await fetch(`${settings.graphUrl}/${encodeURIComponent(mediaId)}`, { headers });
  if (!info.ok) throw new Error(`Meta no da el adjunto ${mediaId} (${info.status}).`);
  const { url } = (await info.json()) as { url?: string };
  if (!url) throw new Error(`Meta no da la dirección del adjunto ${mediaId}.`);
  const file = await fetch(url, { headers });
  if (!file.ok)
    throw new Error(`No se ha podido descargar el adjunto ${mediaId} (${file.status}).`);
  return Buffer.from(await file.arrayBuffer());
}

/** Convierte en correos los avisos pendientes. Uno a la vez: el orden importa para los hilos. */
function makeProcessor(context: AppDeps) {
  const { db } = context;
  let running: Promise<void> | null = null;

  async function convert(account: Account, settings: Settings, messages: WaMessage[]) {
    const fresh: WaMessage[] = [];
    for (const message of messages) {
      const seen = await db.execute(sql`select 1 from wa_messages where wamid = ${message.id}`);
      if (seen.rows.length === 0) fresh.push(message);
    }
    if (fresh.length === 0) return;
    const client = imapClient(account, await resolveAuth(context, account));
    await client.connect();
    try {
      const folders = await client.list();
      if (!folders.some((folder) => folder.path === settings.folder)) {
        await client.mailboxCreate(settings.folder);
      }
      for (const message of fresh) {
        const thread = (
          await db.execute<{ name: string | null; firstMailId: string; lastMailId: string }>(sql`
            select name, first_mail_id as "firstMailId", last_mail_id as "lastMailId"
              from wa_threads where account_id = ${account.id} and phone = ${message.phone}`)
        ).rows[0];
        const quoted = message.replyTo
          ? (
              await db.execute<{ mailId: string }>(
                sql`select mail_id as "mailId" from wa_messages where wamid = ${message.replyTo}`,
              )
            ).rows[0]?.mailId
          : undefined;
        const inReplyTo = quoted ?? thread?.lastMailId ?? null;
        const references = [
          ...new Set([thread?.firstMailId, inReplyTo].filter((id): id is string => Boolean(id))),
        ];
        const name = message.name || thread?.name || null;
        let file: { filename: string; content: Buffer; contentType: string } | null = null;
        let text = message.text;
        if (message.media) {
          try {
            file = {
              filename: message.media.filename ?? "adjunto",
              content: await download(settings, message.media.id),
              contentType: message.media.mime,
            };
          } catch (error) {
            text += `\n\n(No se ha podido traer el adjunto de WhatsApp: ${error instanceof Error ? error.message : String(error)})`;
          }
        }
        const raw = await buildMail({
          message: { ...message, text },
          name,
          office: { name: account.name, address: account.email },
          inReplyTo,
          references,
          file,
        });
        const seen = message.direction === "out" || message.history;
        await client.append(settings.folder, raw, seen ? ["\\Seen"] : [], message.at);
        const mailId = mailIdOf(message.id);
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            insert into wa_messages (wamid, account_id, phone, direction, kind, at, mail_id, raw)
            values (${message.id}, ${account.id}, ${message.phone}, ${message.direction}, ${message.kind},
                    ${message.at.toISOString()}::timestamptz, ${mailId}, ${JSON.stringify(message.raw)}::jsonb)
            on conflict do nothing`);
          await tx.execute(sql`
            insert into wa_threads (account_id, phone, name, first_mail_id, last_mail_id, last_at)
            values (${account.id}, ${message.phone}, ${name}, ${mailId}, ${mailId}, ${message.at.toISOString()}::timestamptz)
            on conflict (account_id, phone) do update set
              name = coalesce(excluded.name, wa_threads.name),
              last_mail_id = case when excluded.last_at >= wa_threads.last_at then excluded.last_mail_id else wa_threads.last_mail_id end,
              last_at = greatest(excluded.last_at, wa_threads.last_at)`);
        });
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    // El buzón trae la carpeta enseguida, sin esperar a su próxima vuelta.
    context.onActionQueued?.(account.id);
  }

  async function drain() {
    const settings = settingsOf(context);
    for (;;) {
      const pending = await db.execute<{ id: string; payload: unknown }>(sql`
        select id, payload from wa_events
         where processed_at is null and attempts < ${MAX_ATTEMPTS} order by id limit 20`);
      if (pending.rows.length === 0) return;
      for (const event of pending.rows) {
        try {
          const messages = messagesOf(event.payload);
          if (messages.length > 0) {
            if (!settings.mailbox)
              throw new Error("Falta WHATSAPP_MAILBOX: el buzón donde se guardan los mensajes.");
            const [account] = (
              await db.execute<Account>(
                sql`select * from accounts where lower(email) = lower(${settings.mailbox})`,
              )
            ).rows;
            if (!account) throw new Error(`No hay ningún buzón ${settings.mailbox} dado de alta.`);
            await convert(normalizeAccount(account), settings, messages);
          }
          await db.execute(
            sql`update wa_events set processed_at = now(), error = null where id = ${event.id}`,
          );
        } catch (error) {
          await db.execute(sql`
            update wa_events set attempts = attempts + 1, error = ${error instanceof Error ? error.message : String(error)}
             where id = ${event.id}`);
        }
      }
    }
  }

  return {
    /** Lanza la conversión si no está en marcha. Devuelve la vuelta en curso. */
    kick(): Promise<void> {
      running ??= drain().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

/** Las columnas vienen con su nombre de la base; el cliente IMAP las quiere como en el esquema. */
function normalizeAccount(row: Record<string, unknown>): Account {
  const camel = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  );
  return camel as unknown as Account;
}

const verifyQuery = z.object({
  "hub.mode": z.string().optional(),
  "hub.verify_token": z.string().optional(),
  "hub.challenge": z.string().optional(),
});
const labelsBody = z.object({ messageIds: z.array(z.uuid()).max(500) });

type RawRequest = FastifyRequest & { rawBody?: Buffer };

export const whatsappPlugin: ServerPlugin = {
  id: "whatsapp",
  name: "WhatsApp",
  description:
    "Guarda los mensajes del WhatsApp de empresa como correos, un hilo por contacto, con sus fotos y documentos.",
  setup,
  async routes(app, { context }) {
    const processor = makeProcessor(context);
    // Los avisos que quedaran a medias en el último arranque.
    void processor.kick();

    // Meta firma el cuerpo tal cual: hay que guardarlo antes de interpretarlo.
    app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
      (request as RawRequest).rawBody = body as Buffer;
      try {
        done(
          null,
          (body as Buffer).length > 0 ? JSON.parse((body as Buffer).toString("utf8")) : {},
        );
      } catch (error) {
        done(error as Error, undefined);
      }
    });

    // Meta comprueba la dirección al darla de alta: hay que devolver su reto.
    app.get("/webhook", async (request, reply) => {
      const query = verifyQuery.parse(request.query);
      const { verifyToken } = settingsOf(context);
      if (
        !verifyToken ||
        query["hub.mode"] !== "subscribe" ||
        query["hub.verify_token"] !== verifyToken
      ) {
        throw new HttpError(403, "forbidden", "La comprobación no coincide.");
      }
      return reply.type("text/plain").send(query["hub.challenge"] ?? "");
    });

    app.post("/webhook", async (request, reply) => {
      const { appSecret } = settingsOf(context);
      const body = (request as RawRequest).rawBody ?? Buffer.alloc(0);
      const signature = request.headers["x-hub-signature-256"];
      if (
        !appSecret ||
        !validSignature(body, typeof signature === "string" ? signature : undefined, appSecret)
      ) {
        throw new HttpError(401, "signature", "Firma no válida.");
      }
      await context.db.execute(
        sql`insert into wa_events (payload) values (${body.toString("utf8")}::jsonb)`,
      );
      // Meta quiere la respuesta enseguida; la conversión sigue por su cuenta.
      void processor.kick();
      return reply.status(200).send({ ok: true });
    });

    // Estado para Configuración: qué falta, a dónde avisa Meta y cuánto ha llegado.
    app.get("/status", async (request) => {
      requireSession(request);
      const settings = settingsOf(context);
      const base = (
        context.config?.PUBLIC_URL ?? `http://127.0.0.1:${context.config?.PORT ?? 3000}`
      ).replace(/\/$/, "");
      const account = settings.mailbox
        ? (
            await context.db.execute<{ id: string; name: string }>(sql`
            select id, name from accounts where lower(email) = lower(${settings.mailbox})`)
          ).rows[0]
        : undefined;
      const counts = (
        await context.db.execute<{
          incoming: number;
          outgoing: number;
          contacts: number;
          last: string | null;
        }>(sql`
          select count(*) filter (where direction = 'in')::int as incoming,
                 count(*) filter (where direction = 'out')::int as outgoing,
                 count(distinct phone)::int as contacts, max(at) as last
            from wa_messages`)
      ).rows[0]!;
      const events = (
        await context.db.execute<{ pending: number; failed: number; lastError: string | null }>(sql`
          select count(*) filter (where processed_at is null and attempts < ${MAX_ATTEMPTS})::int as pending,
                 count(*) filter (where processed_at is null and attempts >= ${MAX_ATTEMPTS})::int as failed,
                 (select error from wa_events where error is not null and processed_at is null order by id desc limit 1) as "lastError"
            from wa_events`)
      ).rows[0]!;
      return {
        webhookUrl: `${base}/api/plugins/whatsapp/webhook`,
        mailbox: settings.mailbox ?? null,
        mailboxName: account?.name ?? null,
        mailboxFound: Boolean(account),
        folder: settings.folder,
        verifyToken: Boolean(settings.verifyToken),
        appSecret: Boolean(settings.appSecret),
        token: Boolean(settings.token),
        ...counts,
        ...events,
      };
    });

    // Reintentar los avisos que fallaron (por ejemplo, con el buzón caído).
    app.post("/retry", async (request) => {
      requireSession(request);
      await context.db.execute(sql`update wa_events set attempts = 0 where processed_at is null`);
      await processor.kick();
      return { ok: true };
    });

    // Qué correos de la lista son de WhatsApp: la lista les pone su etiqueta.
    app.post("/labels", async (request) => {
      requireSession(request);
      const { messageIds } = labelsBody.parse(request.body);
      if (messageIds.length === 0) return { labels: {} };
      const ids = sql.join(
        messageIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const rows = await context.db.execute<{ id: string }>(sql`
        select m.id from messages m join wa_messages w on w.mail_id = m.message_id_header
         where m.id in (${ids})`);
      return { labels: Object.fromEntries(rows.rows.map((row) => [row.id, ["WhatsApp"]])) };
    });
  },
};
