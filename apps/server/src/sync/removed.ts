import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { events } from "../db/schema.ts";

/**
 * Marca como retirados del buzón los correos que llevan más que el periodo de gracia
 * sin ninguna copia viva en el servidor. La espera evita tomar por retirado un correo
 * que alguien está moviendo: desaparece de una carpeta antes de que veamos la otra.
 *
 * No borra nada de nuestro archivo: el original y su texto se conservan. La purga
 * por plazo de conservación es un proceso aparte (`purge_after`, `legal_hold`).
 */
export async function markRemoved(db: Db, accountId: string, graceMs: number): Promise<number> {
  return db.transaction(async (tx) => {
    const cutoff = new Date(Date.now() - graceMs);
    const reaped = await tx.execute<{ id: string }>(sql`
      update messages m
         set removed_from_server_at = now()
       where m.account_id = ${accountId}
         and m.removed_from_server_at is null
         and not exists (
               select 1 from folder_messages fm
                where fm.message_id = m.id and fm.gone_at is null)
         and (select max(fm.gone_at) from folder_messages fm
               where fm.message_id = m.id) <= ${cutoff.toISOString()}::timestamptz
      returning m.id
    `);
    if (reaped.rows.length > 0) {
      await tx.insert(events).values(
        reaped.rows.map((row) => ({
          accountId,
          type: "message.removed" as const,
          messageId: row.id,
        })),
      );
    }
    return reaped.rows.length;
  });
}
