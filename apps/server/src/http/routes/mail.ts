import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  accountAccess,
  accounts,
  attachments,
  documentNotes,
  documentTexts,
  folderMessages,
  folders,
  messages,
  outboundMessages,
  users,
} from "../../db/schema.ts";
import { addFact } from "../../facts/facts.ts";
import { processingOf, READ, SHOWN_STATUS } from "../../mail/processing.ts";
import { assertAccess } from "../access.ts";
import { audit, notFound, requireSession, type RouteOptions } from "../app.ts";
import { publicAccount } from "./admin.ts";

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Cursor devuelto por la página anterior. */
  before: z.string().optional(),
});

const encodeCursor = (date: Date, id: string) => `${date.toISOString()}_${id}`;
function decodeCursor(cursor: string): { date: Date; id: string } {
  const [iso, id] = cursor.split("_");
  const date = new Date(iso ?? "");
  if (!id || Number.isNaN(date.getTime()) || !z.uuid().safeParse(id).success) throw notFound();
  return { date, id };
}

export const mailRoutes: FastifyPluginAsync<RouteOptions> = async (app, { context }) => {
  const { db } = context;

  app.get("/accounts", async (request) => {
    const { user } = requireSession(request);
    const rows = await db
      .select(publicAccount)
      .from(accounts)
      .innerJoin(accountAccess, eq(accountAccess.accountId, accounts.id))
      .where(eq(accountAccess.userId, user.id))
      .orderBy(accounts.email);
    return { accounts: rows };
  });

  // Resumen de lo procesado en los buzones que ve el usuario.
  app.get("/processing", async (request) => {
    const { user } = requireSession(request);
    const result = await db.execute<{
      messages: number;
      bodyPending: number;
      withFiles: number;
      incomplete: number;
    }>(sql`
      select count(*)::int as messages,
             (count(*) filter (where m.raw_sha256 is null))::int as "bodyPending",
             (count(*) filter (where f.files > 0))::int as "withFiles",
             (count(*) filter (where f.files > f.read))::int as incomplete
        from messages m
        join account_access aa on aa.account_id = m.account_id and aa.user_id = ${user.id}
        cross join lateral (
          select count(a.id) as files,
                 count(a.id) filter (where ${READ}) as read
            from attachments a
            left join document_texts d on d.content_sha256 = a.content_sha256
           where a.message_id = m.id and not a.inline) f
    `);
    // Cada fichero cuenta una vez aunque venga en varios correos.
    const documents = await db.execute<{ status: string; documents: number; noted: number }>(sql`
      select coalesce(${SHOWN_STATUS}, 'pending') as status,
             count(*)::int as documents,
             (count(*) filter (where exists (
                select 1 from document_notes n where n.content_sha256 = docs.sha)))::int as noted
        from (select distinct a.content_sha256 as sha
                from attachments a
                join messages m on m.id = a.message_id
                join account_access aa on aa.account_id = m.account_id and aa.user_id = ${user.id}
               where not a.inline) docs
        left join document_texts d on d.content_sha256 = docs.sha
       group by 1
    `);
    return { ...result.rows[0]!, documents: documents.rows };
  });

  app.get("/accounts/:id/folders", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    await assertAccess(db, user.id, id);
    const rows = await db
      .select({
        id: folders.id,
        path: folders.path,
        delimiter: folders.delimiter,
        specialUse: folders.specialUse,
        /** Aún se está trayendo el histórico de esta carpeta. */
        historyPending: sql<boolean>`coalesce(${folders.backfillBelow}, 1) > 1`,
        total: sql<number>`count(${folderMessages.id})::int`,
        unread: sql<number>`(count(${folderMessages.id}) filter (where not ('\\Seen' = any(${folderMessages.flags}))))::int`,
      })
      .from(folders)
      .leftJoin(
        folderMessages,
        and(eq(folderMessages.folderId, folders.id), isNull(folderMessages.goneAt)),
      )
      .where(and(eq(folders.accountId, id), isNull(folders.goneAt), eq(folders.syncEnabled, true)))
      .groupBy(folders.id)
      .orderBy(folders.path);
    return { folders: rows };
  });

  app.get("/folders/:id/messages", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { limit, before } = listQuery.parse(request.query);
    const [folder] = await db.select().from(folders).where(eq(folders.id, id));
    if (!folder) throw notFound();
    await assertAccess(db, user.id, folder.accountId);

    const cursor = before ? decodeCursor(before) : null;
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
        processing: processingOf,
        flags: folderMessages.flags,
        uid: folderMessages.uid,
      })
      .from(folderMessages)
      .innerJoin(messages, eq(messages.id, folderMessages.messageId))
      .where(
        and(
          eq(folderMessages.folderId, id),
          isNull(folderMessages.goneAt),
          cursor
            ? or(
                lt(messages.internalDate, cursor.date),
                and(eq(messages.internalDate, cursor.date), lt(messages.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(messages.internalDate), desc(messages.id))
      .limit(limit + 1);

    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last.internalDate, last.id) : null,
    };
  });

  app.get("/messages/:id", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    if (!message) throw notFound();
    await assertAccess(db, user.id, message.accountId);

    const locations = await db
      .select({
        folderId: folders.id,
        path: folders.path,
        specialUse: folders.specialUse,
        flags: folderMessages.flags,
        uid: folderMessages.uid,
      })
      .from(folderMessages)
      .innerJoin(folders, eq(folders.id, folderMessages.folderId))
      .where(and(eq(folderMessages.messageId, id), isNull(folderMessages.goneAt)));
    const files = await db
      .select({
        id: attachments.id,
        filename: attachments.filename,
        contentType: attachments.contentType,
        size: attachments.size,
        inline: attachments.inline,
        /** Si se ha podido leer su texto: `ok`, `needs_ocr`, `unsupported`… */
        textStatus: sql<
          string | null
        >`case when ${documentTexts.status} = 'empty' and ${documentTexts.method} like 'ocr:%' then 'no_text_image' else ${documentTexts.status} end`,
        textChars: documentTexts.chars,
        contentSha256: attachments.contentSha256,
      })
      .from(attachments)
      .leftJoin(documentTexts, eq(documentTexts.contentSha256, attachments.contentSha256))
      .where(eq(attachments.messageId, id))
      .orderBy(attachments.position);

    // Lo que se ha anotado de cada adjunto: a mano (`note`) o por un modelo (`autoNote`).
    const shas = [...new Set(files.map((file) => file.contentSha256))];
    const notes = shas.length
      ? await db
          .select({
            contentSha256: documentNotes.contentSha256,
            source: documentNotes.source,
            text: documentNotes.text,
            author: users.name,
            extractor: documentNotes.extractor,
            updatedAt: documentNotes.updatedAt,
          })
          .from(documentNotes)
          .leftJoin(users, eq(users.id, documentNotes.userId))
          .where(inArray(documentNotes.contentSha256, shas))
      : [];
    const noteOf = (sha: string, source: "user" | "model") => {
      const note = notes.find((entry) => entry.contentSha256 === sha && entry.source === source);
      return note
        ? {
            text: note.text,
            author: source === "user" ? note.author : note.extractor,
            updatedAt: note.updatedAt,
          }
        : null;
    };
    const attachmentList = files.map(({ contentSha256, ...file }) => ({
      ...file,
      note: noteOf(contentSha256, "user"),
      autoNote: noteOf(contentSha256, "model"),
    }));

    const [draft] = message.messageIdHeader
      ? await db
          .select({ id: outboundMessages.id })
          .from(outboundMessages)
          .where(
            and(
              eq(outboundMessages.messageIdHeader, message.messageIdHeader),
              eq(outboundMessages.userId, user.id),
              eq(outboundMessages.state, "draft"),
            ),
          )
      : [];

    // Queda anotado en el propio correo quién lo ha abierto: en un buzón compartido
    // es la forma de saber si alguien lo ha visto ya.
    await addFact(
      db,
      {
        accountId: message.accountId,
        messageId: id,
        extractor: "sistema:lectura",
        method: "system",
      },
      { kind: "revisado_por", value: user.name, detail: { userId: user.id } },
      user.id,
    );

    await audit(db, {
      userId: user.id,
      accountId: message.accountId,
      action: "message.read",
      target: message.id,
    });

    return {
      message: {
        id: message.id,
        accountId: message.accountId,
        threadId: message.threadId,
        subject: message.subject,
        from: { name: message.fromName, address: message.fromAddress },
        to: message.to,
        cc: message.cc,
        date: message.date,
        internalDate: message.internalDate,
        bodyText: message.bodyText,
        /** Lo que este correo aporta de nuevo, sin historial citado ni firma. */
        bodyClean: message.bodyClean,
        /** El cuerpo aún no se ha descargado del servidor. */
        bodyPending: message.rawSha256 === null,
        hasAttachments: message.hasAttachments,
        replyTo: message.replyTo,
        bcc: message.bcc,
        direction: message.direction,
        autoReply: message.autoReply,
        priority: message.priority,
        /** Ya no está en el buzón del servidor, pero se conserva en nuestro archivo. */
        removedFromServerAt: message.removedFromServerAt,
        locations,
        attachments: attachmentList,
        /** Es un borrador escrito aquí por este usuario: se puede seguir editando. */
        draftId: draft?.id ?? null,
      },
    };
  });
};
