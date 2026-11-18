/**
 * Vuelve a extraer los datos estructurados de los correos a partir de sus originales.
 * Sirve cuando cambia lo que se extrae: no hace falta volver a descargar nada.
 *
 *   pnpm reprocesar            Solo los que aún no se han procesado
 *   pnpm reprocesar --todos         Todos los correos
 *   pnpm reprocesar --documentos    Además, vuelve a leer el texto de todos los adjuntos
 */
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { accounts, documentTexts, messages } from "../src/db/schema.ts";
import { ExtractionWorker } from "../src/documents/worker.ts";
import { enrichMessage } from "../src/mail/enrich.ts";
import { openRuntime } from "../src/runtime.ts";

const all = process.argv.includes("--todos");
const runtime = await openRuntime();
try {
  const pending = await runtime.db
    .select({
      messageId: messages.id,
      accountId: messages.accountId,
      rawSha256: messages.rawSha256,
      accountEmail: accounts.email,
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(and(isNotNull(messages.rawSha256), all ? undefined : isNull(messages.enrichedAt)));

  let done = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      await enrichMessage(runtime.db, runtime.rawStore, { ...row, rawSha256: row.rawSha256! });
      done++;
    } catch (error) {
      failed++;
      console.error(`No se pudo procesar ${row.messageId}:`, error);
    }
  }
  console.log(
    `Correos procesados: ${done}. Con error: ${failed}. Total revisado: ${pending.length}.`,
  );

  if (process.argv.includes("--documentos")) {
    await runtime.db.update(documentTexts).set({ status: "pending" });
  }
  const worker = new ExtractionWorker(runtime.db, runtime.rawStore);
  let documents = 0;
  for (;;) {
    const handled = await worker.drain(50);
    if (handled === 0) break;
    documents += handled;
  }
  const summary = await runtime.db
    .select({ status: documentTexts.status, total: count() })
    .from(documentTexts)
    .groupBy(documentTexts.status);
  console.log(
    `Documentos leídos ahora: ${documents}. Estado: ${summary.map((row) => `${row.status}=${row.total}`).join(", ") || "ninguno"}.`,
  );
} finally {
  await runtime.close();
}
