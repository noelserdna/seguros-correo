import { parseMail } from "../mail/parse.ts";
import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { documentPages, documentTexts, events } from "../db/schema.ts";
import type { RawStore } from "../storage/raw-store.ts";
import { extractDocument } from "./extract.ts";

/** Anota los adjuntos de un correo como documentos pendientes de leer (una vez por contenido). */
export async function queueDocuments(
  tx: Tx,
  files: { contentSha256: string; filename: string | null; contentType: string; size: number }[],
): Promise<void> {
  if (files.length === 0) return;
  await tx.insert(documentTexts).values(files).onConflictDoNothing();
}

/**
 * Lee el texto de los documentos pendientes. Va aparte de la sincronización porque
 * puede ser lento: un correo se puede leer en cuanto llega, y el texto de sus adjuntos
 * aparece unos segundos después.
 */
export class ExtractionWorker {
  readonly #db: Db;
  readonly #rawStore: RawStore;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  constructor(db: Db, rawStore: RawStore) {
    this.#db = db;
    this.#rawStore = rawStore;
  }

  /** Procesa hasta `limit` documentos pendientes. Devuelve cuántos ha atendido. */
  async drain(limit = 20): Promise<number> {
    const pending = await this.#db
      .select({ sha: documentTexts.contentSha256 })
      .from(documentTexts)
      .where(eq(documentTexts.status, "pending"))
      .orderBy(asc(documentTexts.createdAt))
      .limit(limit);
    for (const { sha } of pending) await this.#extract(sha);
    return pending.length;
  }

  async #extract(sha: string): Promise<void> {
    // El contenido no se guarda aparte: se saca del original de cualquier correo que lo lleve.
    const source = await this.#db.execute<{
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
    let result: Awaited<ReturnType<typeof extractDocument>>;
    if (!origin) {
      result = {
        status: "failed",
        method: null,
        pages: [],
        pagesNeedingOcr: 0,
        error: "No se encuentra el correo que traía este adjunto.",
      };
    } else {
      const parsed = await parseMail(this.#rawStore.open(origin.rawSha256));
      const part =
        parsed.attachments.find(
          (candidate) => createHash("sha256").update(candidate.content).digest("hex") === sha,
        ) ?? parsed.attachments[origin.position];
      result = part
        ? await extractDocument({
            filename: origin.filename,
            contentType: origin.contentType,
            content: part.content,
          })
        : {
            status: "failed",
            method: null,
            pages: [],
            pagesNeedingOcr: 0,
            error: "Adjunto no encontrado.",
          };
    }

    await this.#db.transaction(async (tx) => {
      await tx.delete(documentPages).where(eq(documentPages.contentSha256, sha));
      if (result.pages.length > 0) {
        await tx.insert(documentPages).values(
          result.pages.map((page) => ({
            contentSha256: sha,
            page: page.page,
            label: page.label ?? null,
            text: page.text,
            method: page.method,
            chars: page.text.length,
          })),
        );
      }
      await tx
        .update(documentTexts)
        .set({
          status: result.status,
          method: result.method,
          pages: result.pages.length,
          chars: result.pages.reduce((sum, page) => sum + page.text.length, 0),
          pagesNeedingOcr: result.pagesNeedingOcr,
          error: result.error ?? null,
          extractedAt: new Date(),
        })
        .where(eq(documentTexts.contentSha256, sha));
      // Aviso por cada correo que lleva este documento: aquí se engancha quien lo analice.
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
            payload: { contentSha256: sha, status: result.status },
          })),
        );
      }
    });
  }

  start(intervalMs = 3000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#busy) return;
      this.#busy = true;
      void this.drain()
        .catch((error: unknown) => console.error("Documentos: fallo al extraer texto", error))
        .finally(() => {
          this.#busy = false;
        });
    }, intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
