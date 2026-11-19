/**
 * Módulo de WhatsApp: los mensajes del número de empresa se guardan como correos en una
 * carpeta del buzón, un hilo por contacto, para que todo esté en un solo sitio y siga el
 * mismo camino que el correo (expedientes, lectura de adjuntos, búsqueda, tramitación).
 * Lo que se contesta desde la aplicación a un contacto de WhatsApp sale por WhatsApp.
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
import { downloadMedia } from "./graph.ts";
import { messagesOf, validSignature, type WaMessage } from "./meta.ts";
import { phoneOf, whatsappTransport } from "./send.ts";
import { setSettings, settingsFrom, type Settings } from "./settings.ts";
import { appendToThread, ensureFolder, unseen, windowOf, type WaFile } from "./thread.ts";

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

/** Las columnas vienen con su nombre de la base; el cliente IMAP las quiere como en el esquema. */
function asAccount(row: Record<string, unknown>): Account {
  const camel = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  );
  return camel as unknown as Account;
}

async function mailboxOf(db: Db, settings: Settings): Promise<Account> {
  if (!settings.mailbox) {
    throw new Error("Falta WHATSAPP_MAILBOX: el buzón donde se guardan los mensajes.");
  }
  const [row] = (
    await db.execute<Record<string, unknown>>(
      sql`select * from accounts where lower(email) = lower(${settings.mailbox})`,
    )
  ).rows;
  if (!row) throw new Error(`No hay ningún buzón ${settings.mailbox} dado de alta.`);
  return asAccount(row);
}

/** Convierte en correos los avisos pendientes. Uno a la vez: el orden importa para los hilos. */
function makeProcessor(context: AppDeps, settings: Settings) {
  const { db } = context;
  let running: Promise<void> | null = null;

  async function convert(account: Account, messages: WaMessage[]) {
    const fresh = await unseen(db, messages);
    if (fresh.length === 0) return;
    const client = imapClient(account, await resolveAuth(context, account));
    await client.connect();
    try {
      await ensureFolder(client, settings.folder);
      for (const message of fresh) {
        let file: WaFile | null = null;
        let text = message.text;
        if (message.media) {
          try {
            file = {
              filename: message.media.filename ?? "adjunto",
              content: await downloadMedia(settings, message.media.id),
              contentType: message.media.mime,
            };
          } catch (error) {
            text += `\n\n(No se ha podido traer el adjunto de WhatsApp: ${error instanceof Error ? error.message : String(error)})`;
          }
        }
        await appendToThread({
          db,
          client,
          account,
          folder: settings.folder,
          message: { ...message, text },
          file,
        });
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    // El buzón trae la carpeta enseguida, sin esperar a su próxima vuelta.
    context.onActionQueued?.(account.id);
  }

  async function drain() {
    for (;;) {
      const pending = await db.execute<{ id: string; payload: unknown }>(sql`
        select id, payload from wa_events
         where processed_at is null and attempts < ${MAX_ATTEMPTS} order by id limit 20`);
      if (pending.rows.length === 0) return;
      for (const event of pending.rows) {
        try {
          const messages = messagesOf(event.payload);
          if (messages.length > 0) await convert(await mailboxOf(db, settings), messages);
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

const verifyQuery = z.object({
  "hub.mode": z.string().optional(),
  "hub.verify_token": z.string().optional(),
  "hub.challenge": z.string().optional(),
});
const labelsBody = z.object({ messageIds: z.array(z.uuid()).max(500) });
const windowQuery = z.object({ address: z.string().min(3).max(320) });

type RawRequest = FastifyRequest & { rawBody?: Buffer };

export const whatsappPlugin: ServerPlugin = {
  id: "whatsapp",
  name: "WhatsApp",
  description:
    "Guarda los mensajes del WhatsApp de empresa como correos, un hilo por contacto, con sus fotos y documentos, y permite contestar desde aquí.",
  setup,
  transport: whatsappTransport,
  async routes(app, { context }) {
    const settings = settingsFrom(context.config);
    setSettings(settings);
    const processor = makeProcessor(context, settings);
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
      if (
        !settings.verifyToken ||
        query["hub.mode"] !== "subscribe" ||
        query["hub.verify_token"] !== settings.verifyToken
      ) {
        throw new HttpError(403, "forbidden", "La comprobación no coincide.");
      }
      return reply.type("text/plain").send(query["hub.challenge"] ?? "");
    });

    app.post("/webhook", async (request, reply) => {
      const body = (request as RawRequest).rawBody ?? Buffer.alloc(0);
      const signature = request.headers["x-hub-signature-256"];
      if (
        !settings.appSecret ||
        !validSignature(
          body,
          typeof signature === "string" ? signature : undefined,
          settings.appSecret,
        )
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

    // Para el redactor: si a esta dirección se le puede escribir ahora y hasta cuándo.
    app.get("/window", async (request) => {
      requireSession(request);
      const { address } = windowQuery.parse(request.query);
      const account = await mailboxOf(context.db, settings).catch(() => null);
      if (!account) return { open: false, until: null, name: null, ready: false };
      const window = await windowOf(context.db, account.id, phoneOf(address));
      return {
        ...window,
        ready: Boolean(settings.token && settings.phoneNumberId),
      };
    });

    // Estado para Configuración: qué falta, a dónde avisa Meta y cuánto ha llegado.
    app.get("/status", async (request) => {
      requireSession(request);
      const config = context.config;
      const base = (config?.PUBLIC_URL ?? `http://127.0.0.1:${config?.PORT ?? 3000}`).replace(
        /\/$/,
        "",
      );
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
        phoneNumberId: Boolean(settings.phoneNumberId),
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
