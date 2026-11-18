import { and, asc, desc, eq, gt, isNotNull, isNull, lt, max, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import {
  attachments,
  documentPages,
  documentTexts,
  events,
  folderMessages,
  folders,
  messages,
} from "../../db/schema.ts";
import { renderEmailHtml, renderEmailText, type InlineImage } from "../../mail/render.ts";
import { accessibleAccountIds, assertAccess } from "../access.ts";
import { audit, notFound, requireSession, type RouteOptions } from "../app.ts";

const idParams = z.object({ id: z.uuid() });
const htmlQuery = z.object({ images: z.enum(["0", "1"]).default("0") });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().optional(),
});
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const searchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  from: z.string().trim().max(200).optional(),
  /** Persona o dominio que aparece en el correo, en cualquier papel. */
  with: z.string().trim().max(200).optional(),
  direction: z.enum(["in", "out"]).optional(),
  since: day.optional(),
  until: day.optional(),
  attachments: z.enum(["0", "1"]).default("0"),
  /** Incluir lo que ya no está en el buzón del servidor. */
  archive: z.enum(["0", "1"]).default("1"),
  accountId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const STREAM_POLL_MS = 1500;
const STREAM_PING_MS = 20_000;

/** Marcas que delimitan el término encontrado; la interfaz las convierte en resaltado. */
const MARK_START = "⁣[[";
const MARK_END = "]]⁣";

export const contentRoutes: FastifyPluginAsync<RouteOptions> = async (app, { context }) => {
  const { db, rawStore } = context;

  async function loadMessage(userId: string, id: string) {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    if (!message) throw notFound();
    await assertAccess(db, userId, message.accountId);
    return message;
  }

  const parseRaw = (sha256: string): Promise<ParsedMail> => simpleParser(rawStore.open(sha256));

  // El cuerpo del correo, listo para mostrarse sin riesgo.
  app.get("/messages/:id/html", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { images } = htmlQuery.parse(request.query);
    const message = await loadMessage(user.id, id);
    if (!message.rawSha256) return { pending: true, html: "", blockedImages: 0 };

    const parsed = await parseRaw(message.rawSha256);
    if (!parsed.html) return { pending: false, ...renderEmailText(parsed.text ?? "") };

    const inlineImages = new Map<string, InlineImage>();
    for (const part of parsed.attachments) {
      if (part.cid) {
        inlineImages.set(part.cid, { contentType: part.contentType, content: part.content });
      }
    }
    return {
      pending: false,
      ...renderEmailHtml(parsed.html, { allowRemoteImages: images === "1", inlineImages }),
    };
  });

  // Descarga de un adjunto. Siempre como fichero: el navegador nunca lo interpreta.
  app.get("/attachments/:id", async (request, reply) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const [file] = await db.select().from(attachments).where(eq(attachments.id, id));
    if (!file) throw notFound();
    const message = await loadMessage(user.id, file.messageId);
    if (!message.rawSha256) throw notFound();

    const part = (await parseRaw(message.rawSha256)).attachments[file.position];
    if (!part) throw notFound();

    await audit(db, {
      userId: user.id,
      accountId: message.accountId,
      action: "attachment.downloaded",
      target: file.id,
      detail: { messageId: message.id, filename: file.filename },
    });
    const filename = (file.filename ?? "adjunto").replace(/[\r\n"\\/]/g, "_");
    return reply
      .header("content-type", "application/octet-stream")
      .header(
        "content-disposition",
        `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .send(part.content);
  });

  // El texto que se ha podido leer de un adjunto, página a página.
  app.get("/attachments/:id/text", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const [file] = await db.select().from(attachments).where(eq(attachments.id, id));
    if (!file) throw notFound();
    await loadMessage(user.id, file.messageId);
    const [document] = await db
      .select()
      .from(documentTexts)
      .where(eq(documentTexts.contentSha256, file.contentSha256));
    const pages = document
      ? await db
          .select({
            page: documentPages.page,
            label: documentPages.label,
            text: documentPages.text,
            method: documentPages.method,
            confidence: documentPages.confidence,
          })
          .from(documentPages)
          .where(eq(documentPages.contentSha256, file.contentSha256))
          .orderBy(asc(documentPages.page))
      : [];
    return {
      status: document?.status ?? "pending",
      method: document?.method ?? null,
      pagesNeedingOcr: document?.pagesNeedingOcr ?? 0,
      error: document?.error ?? null,
      pages,
    };
  });

  // Los mensajes de una conversación, del más antiguo al más reciente.
  app.get("/threads/:id", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const rows = await db
      .select({
        id: messages.id,
        accountId: messages.accountId,
        messageIdHeader: messages.messageIdHeader,
        subject: messages.subject,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        internalDate: messages.internalDate,
        snippet: messages.snippet,
        removedFromServerAt: messages.removedFromServerAt,
      })
      .from(messages)
      .where(eq(messages.threadId, id))
      .orderBy(asc(messages.internalDate));
    const first = rows[0];
    if (!first) throw notFound();
    await assertAccess(db, user.id, first.accountId);
    return { messages: rows };
  });

  // Lo que ya no está en el buzón del servidor pero se conserva aquí.
  app.get("/accounts/:id/archive", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { limit, before } = pageQuery.parse(request.query);
    await assertAccess(db, user.id, id);

    const [iso, cursorId] = (before ?? "").split("_");
    const cursorDate = iso ? new Date(iso) : null;
    if (before && (!cursorId || !cursorDate || Number.isNaN(cursorDate.getTime())))
      throw notFound();

    const rows = await db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        subject: messages.subject,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        to: messages.to,
        internalDate: messages.internalDate,
        snippet: messages.snippet,
        hasAttachments: messages.hasAttachments,
        removedFromServerAt: messages.removedFromServerAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, id),
          isNotNull(messages.removedFromServerAt),
          // Las versiones viejas de un borrador no son correo: no van al archivo.
          sql`exists (select 1 from folder_messages fm join folders f on f.id = fm.folder_id
                       where fm.message_id = ${messages.id}
                         and f.special_use is distinct from 'drafts')`,
          cursorDate && cursorId
            ? or(
                lt(messages.internalDate, cursorDate),
                and(eq(messages.internalDate, cursorDate), lt(messages.id, cursorId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(messages.internalDate), desc(messages.id))
      .limit(limit + 1);

    const items = rows.slice(0, limit).map((row) => ({ ...row, flags: ["\\Seen"], uid: null }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last ? `${last.internalDate.toISOString()}_${last.id}` : null,
    };
  });

  // Búsqueda en todos los buzones concedidos, archivo incluido.
  app.get("/search", async (request) => {
    const { user } = requireSession(request);
    const query = searchQuery.parse(request.query);
    let accountIds = await accessibleAccountIds(db, user.id);
    if (query.accountId) accountIds = accountIds.filter((id) => id === query.accountId);
    if (accountIds.length === 0) return { items: [], truncated: false };

    const filters = [
      // En el correo o en el texto de alguno de sus adjuntos.
      sql`(m.search @@ q or exists (
            select 1 from attachments a
              join document_pages p on p.content_sha256 = a.content_sha256
             where a.message_id = m.id and p.search @@ q))`,
      // Fuera las versiones viejas de borradores: solo cuenta lo que sigue en una carpeta
      // o estuvo alguna vez en una que no fuera Borradores.
      sql`exists (select 1 from folder_messages fm join folders f on f.id = fm.folder_id
                   where fm.message_id = m.id
                     and (fm.gone_at is null or f.special_use is distinct from 'drafts'))`,
    ];
    if (query.from) {
      const pattern = `%${query.from.replace(/[%_\\]/g, "\\$&")}%`;
      filters.push(sql`(m.from_name ilike ${pattern} or m.from_address ilike ${pattern})`);
    }
    if (query.with) {
      const pattern = `%${query.with.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`;
      filters.push(sql`exists (select 1 from message_addresses a
                                where a.message_id = m.id
                                  and (a.address like ${pattern} or lower(a.name) like ${pattern}))`);
    }
    if (query.direction) filters.push(sql`m.direction = ${query.direction}`);
    if (query.since) filters.push(sql`m.internal_date >= ${query.since}::date`);
    if (query.until) filters.push(sql`m.internal_date < (${query.until}::date + 1)`);
    if (query.attachments === "1") filters.push(sql`m.has_attachments is true`);
    if (query.archive === "0") filters.push(sql`m.removed_from_server_at is null`);

    const result = await db.execute<{
      id: string;
      accountId: string;
      threadId: string;
      subject: string;
      fromName: string;
      fromAddress: string;
      internalDate: Date;
      hasAttachments: boolean | null;
      removedFromServerAt: Date | null;
      headline: string;
      location: string | null;
      locationUse: string | null;
      /** La coincidencia está en un adjunto: cuál, en qué página y el fragmento. */
      attachmentHit: {
        filename: string | null;
        page: number;
        label: string | null;
        pages: number;
        headline: string;
      } | null;
    }>(sql`
      select m.id,
             m.account_id as "accountId",
             m.thread_id as "threadId",
             m.subject,
             m.from_name as "fromName",
             m.from_address as "fromAddress",
             m.internal_date as "internalDate",
             m.has_attachments as "hasAttachments",
             m.removed_from_server_at as "removedFromServerAt",
             ts_headline('es_sin_acentos', coalesce(m.body_text, ''), q,
               ${`MaxWords=24, MinWords=10, MaxFragments=1, StartSel=${MARK_START}, StopSel=${MARK_END}`}) as headline,
             (select f.path
                from folder_messages fm
                join folders f on f.id = fm.folder_id
               where fm.message_id = m.id and fm.gone_at is null and f.gone_at is null
               order by fm.created_at
               limit 1) as location,
             (select f.special_use
                from folder_messages fm
                join folders f on f.id = fm.folder_id
               where fm.message_id = m.id and fm.gone_at is null and f.gone_at is null
               order by fm.created_at
               limit 1) as "locationUse",
             (select json_build_object(
                       'filename', a.filename,
                       'page', p.page,
                       'label', p.label,
                       'pages', d.pages,
                       'headline', ts_headline('es_sin_acentos', left(p.text, 30000), q,
                         ${`MaxWords=24, MinWords=10, MaxFragments=1, StartSel=${MARK_START}, StopSel=${MARK_END}`}))
                from attachments a
                join document_pages p on p.content_sha256 = a.content_sha256
                join document_texts d on d.content_sha256 = a.content_sha256
               where a.message_id = m.id and p.search @@ q
               order by p.page
               limit 1) as "attachmentHit"
        from messages m,
             websearch_to_tsquery('es_sin_acentos', ${query.q}) q
       where m.account_id in (${sql.join(
         accountIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
         and ${sql.join(filters, sql` and `)}
       order by m.internal_date desc, m.id desc
       limit ${query.limit + 1}
    `);

    return {
      items: result.rows.slice(0, query.limit),
      truncated: result.rows.length > query.limit,
      marks: { start: MARK_START, end: MARK_END },
    };
  });

  // Avisos en vivo: la interfaz se entera de lo que cambia sin recargar.
  app.get("/stream", async (request, reply) => {
    const { user } = requireSession(request);
    const [latest] = await db.select({ id: max(events.id) }).from(events);
    let lastId = latest?.id ?? 0;

    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    stream.write(": conectado\n\n");

    let busy = false;
    const poll = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        const rows = await db
          .select()
          .from(events)
          .where(gt(events.id, lastId))
          .orderBy(asc(events.id))
          .limit(500);
        if (rows.length === 0) return;
        lastId = rows.at(-1)!.id;
        const allowed = new Set(await accessibleAccountIds(db, user.id));
        for (const event of rows) {
          if (!allowed.has(event.accountId)) continue;
          const data = {
            type: event.type,
            accountId: event.accountId,
            messageId: event.messageId,
            payload: event.payload,
          };
          stream.write(`id: ${event.id}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, STREAM_POLL_MS);
    const ping = setInterval(() => stream.write(": ping\n\n"), STREAM_PING_MS);

    stream.on("close", () => {
      clearInterval(poll);
      clearInterval(ping);
    });
  });

  // Carpetas en las que está un correo ahora mismo (para la columna «Dónde está»).
  app.get("/messages/:id/locations", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    await loadMessage(user.id, id);
    const rows = await db
      .select({ folderId: folders.id, path: folders.path })
      .from(folderMessages)
      .innerJoin(folders, eq(folders.id, folderMessages.folderId))
      .where(and(eq(folderMessages.messageId, id), isNull(folderMessages.goneAt)));
    return { locations: rows };
  });
};
