/**
 * Vuelve a extraer los datos estructurados de los correos a partir de sus originales.
 * Sirve cuando cambia lo que se extrae: no hace falta volver a descargar nada.
 *
 *   pnpm reprocesar            Solo los que aún no se han procesado
 *   pnpm reprocesar --todos    Todos
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { accounts, messages } from "../src/db/schema.ts";
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
  console.log(`Procesados: ${done}. Con error: ${failed}. Total revisado: ${pending.length}.`);
} finally {
  await runtime.close();
}
