import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  accountAccess,
  accounts,
  attachments,
  folderMessages,
  folders,
  messages,
  outboundMessages,
} from "../../db/schema.ts";
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
      })
      .from(attachments)
      .where(eq(attachments.messageId, id))
      .orderBy(attachments.position);

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
        attachments: files,
        /** Es un borrador escrito aquí por este usuario: se puede seguir editando. */
        draftId: draft?.id ?? null,
      },
    };
  });
};
