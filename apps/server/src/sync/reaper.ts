import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { events } from "../db/schema.ts";

/**
 * Da por borrados los correos que llevan más que el periodo de gracia sin ninguna
 * copia viva en el servidor. La espera evita tomar por borrado un correo que alguien
 * está moviendo: desaparece de una carpeta antes de que veamos la otra.
 */
export async function reapDeleted(db: Db, accountId: string, graceMs: number): Promise<number> {
  return db.transaction(async (tx) => {
    const cutoff = new Date(Date.now() - graceMs);
    const reaped = await tx.execute<{ id: string }>(sql`
      update messages m
         set deleted_on_server_at = now()
       where m.account_id = ${accountId}
         and m.deleted_on_server_at is null
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
          type: "message.deleted" as const,
          messageId: row.id,
        })),
      );
    }
    return reaped.rows.length;
  });
}
