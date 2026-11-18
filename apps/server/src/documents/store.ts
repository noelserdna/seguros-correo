import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { documentPages, documentTexts, events } from "../db/schema.ts";
import { parseMail } from "../mail/parse.ts";
import type { RawStore } from "../storage/raw-store.ts";

export type StoredDocument = { filename: string | null; contentType: string; content: Buffer };

/**
 * El contenido de un documento. No se guarda aparte: se saca del original de cualquier
 * correo que lo lleve como adjunto.
 */
export async function loadDocument(
  db: Db,
  rawStore: RawStore,
  sha: string,
): Promise<StoredDocument | null> {
  const source = await db.execute<{
    rawSha256: string;
    position: number;
    filename: string | null;
    contentType: string;
  }>(sql`
    select m.raw_sha256 as "rawSha256", a.position, a.filename, a.content_type as "contentType"
      from attachments a join messages m on m.id = a.message_id
     where a.content_sha256 = ${sha} and m.raw_sha256 is not null
     limit 1`);
  const origin = source.rows[0];
  if (!origin) return null;
  const parsed = await parseMail(rawStore.open(origin.rawSha256));
  const part =
    parsed.attachments.find(
      (candidate) => createHash("sha256").update(candidate.content).digest("hex") === sha,
    ) ?? parsed.attachments[origin.position];
  return part
    ? { filename: origin.filename, contentType: origin.contentType, content: part.content }
    : null;
}

export type RecognizedPage = { page: number; text: string; confidence?: number | null };

/**
 * Guarda el texto que alguien ha reconocido en un documento que no lo traía (una foto, un
 * escaneado). Es la puerta por la que escriben el reconocimiento de texto u otros
 * analizadores: el documento pasa a estar leído y se avisa a quien lo esté esperando.
 *
 * Solo se tocan las páginas que se pasan; las que ya tenían texto propio se conservan.
 */
export async function saveRecognizedText(
  db: Db,
  sha: string,
  input: { engine: string; pages: RecognizedPage[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const page of input.pages) {
      const row = {
        text: page.text,
        method: input.engine,
        confidence: page.confidence ?? null,
        chars: page.text.length,
      };
      await tx
        .insert(documentPages)
        .values({ contentSha256: sha, page: page.page, ...row })
        .onConflictDoUpdate({
          target: [documentPages.contentSha256, documentPages.page],
          set: row,
        });
    }
    // Las páginas sin nada reconocido no se guardan como hueco pendiente.
    await tx
      .delete(documentPages)
      .where(and(eq(documentPages.contentSha256, sha), eq(documentPages.chars, 0)));
    const totals = await tx.execute<{ pages: number; chars: number }>(sql`
      select count(*)::int as pages, coalesce(sum(chars), 0)::int as chars
        from document_pages where content_sha256 = ${sha}`);
    const { pages, chars } = totals.rows[0]!;
    const status = chars > 0 ? "ok" : "empty";
    await tx
      .update(documentTexts)
      .set({
        status,
        pages,
        chars,
        pagesNeedingOcr: 0,
        error: null,
        extractedAt: new Date(),
        // Si no traía texto propio, queda anotado quién lo ha mirado: una foto en la que
        // no se reconoce nada no es lo mismo que un documento vacío.
        method: sql`case when ${documentTexts.method} is null or ${chars} = 0
                         then ${input.engine} else ${documentTexts.method} end`,
      })
      .where(eq(documentTexts.contentSha256, sha));
    const holders = await tx.execute<{ messageId: string; accountId: string }>(sql`
      select distinct m.id as "messageId", m.account_id as "accountId"
        from attachments a join messages m on m.id = a.message_id
       where a.content_sha256 = ${sha}`);
    if (holders.rows.length > 0) {
      await tx.insert(events).values(
        holders.rows.map((holder) => ({
          accountId: holder.accountId,
          type: "document.extracted" as const,
          messageId: holder.messageId,
          payload: { contentSha256: sha, status, engine: input.engine },
        })),
      );
    }
  });
}
