import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { attachments, folderMessages, folders, messages } from "../db/schema.ts";
import type { SyncContext } from "./types.ts";

const SNIPPET_LENGTH = 200;

/**
 * Descarga el original de los correos que aún no lo tienen, de más reciente a más
 * antiguo: lo guarda en disco, extrae el texto y da de alta los adjuntos.
 * Devuelve cuántos ha descargado.
 */
export async function downloadBodies(ctx: SyncContext): Promise<number> {
  const { db, client, account, rawStore, options } = ctx;

  const pending = await db
    .select({
      messageId: messages.id,
      uid: folderMessages.uid,
      uidValidity: folderMessages.uidValidity,
      path: folders.path,
    })
    .from(messages)
    .innerJoin(folderMessages, eq(folderMessages.messageId, messages.id))
    .innerJoin(folders, eq(folders.id, folderMessages.folderId))
    .where(
      and(
        eq(messages.accountId, account.id),
        isNull(messages.rawSha256),
        isNull(folderMessages.goneAt),
        isNull(folders.goneAt),
      ),
    )
    .orderBy(desc(messages.internalDate))
    .limit(options.bodyBatch * 2);

  // Un correo puede estar en varias carpetas; basta con bajarlo de una.
  const seen = new Set<string>();
  const byFolder = new Map<string, typeof pending>();
  for (const row of pending) {
    if (seen.has(row.messageId) || seen.size >= options.bodyBatch) continue;
    seen.add(row.messageId);
    byFolder.set(row.path, [...(byFolder.get(row.path) ?? []), row]);
  }

  let downloaded = 0;
  for (const [path, rows] of byFolder) {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      for (const row of rows) {
        if (!client.mailbox || Number(client.mailbox.uidValidity) !== row.uidValidity) break;
        const download = await client.download(String(row.uid), undefined, { uid: true });
        // Si ya no está (lo movieron mientras tanto), se reintentará desde su nueva carpeta.
        if (!download.content) continue;
        const { sha256 } = await rawStore.save(download.content);
        const parsed = await simpleParser(rawStore.open(sha256));
        const text = parsed.text ?? "";

        await db.transaction(async (tx) => {
          await tx
            .update(messages)
            .set({
              rawSha256: sha256,
              bodyText: text,
              snippet: text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH),
              hasAttachments: parsed.attachments.some((part) => !part.related),
            })
            .where(eq(messages.id, row.messageId));
          await tx.delete(attachments).where(eq(attachments.messageId, row.messageId));
          if (parsed.attachments.length > 0) {
            await tx.insert(attachments).values(
              parsed.attachments.map((part, position) => ({
                messageId: row.messageId,
                position,
                filename: part.filename ?? null,
                contentType: part.contentType,
                size: part.size,
                contentId: part.cid ?? null,
                inline: part.related === true,
                contentSha256: createHash("sha256").update(part.content).digest("hex"),
              })),
            );
          }
        });
        downloaded++;
      }
    } finally {
      lock.release();
    }
  }
  return downloaded;
}
