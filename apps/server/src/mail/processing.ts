import { sql, type SQL } from "drizzle-orm";
import { messages } from "../db/schema.ts";

/**
 * Estado de procesado de un correo, para enseñarlo en las listas: si ya se ha traído su
 * contenido y cuántos de sus adjuntos se han podido leer.
 */
export type Processing = {
  /** El contenido del correo aún no se ha descargado del servidor. */
  bodyPending: boolean;
  /** Adjuntos de verdad (no las imágenes incrustadas en el texto). */
  files: number;
  /** Con su texto leído, o comprobado que no traen texto. */
  read: number;
  /** En cola, todavía sin intentar. */
  pending: number;
  /** De los que no se han podido leer, cuántos tienen anotado qué contienen. */
  noted: number;
};

export const processingOf: SQL<Processing> = sql<Processing>`(
  select json_build_object(
           'bodyPending', ${messages.rawSha256} is null,
           'files', count(a.id)::int,
           'read', (count(a.id) filter (where d.status in ('ok', 'empty')))::int,
           'pending', (count(a.id) filter (where d.status is null or d.status = 'pending'))::int,
           'noted', (count(a.id) filter (
             where d.status not in ('ok', 'empty', 'pending')
               and exists (select 1 from document_notes n
                            where n.content_sha256 = a.content_sha256)))::int)
    from (select 1) one
    left join attachments a on a.message_id = ${messages.id} and not a.inline
    left join document_texts d on d.content_sha256 = a.content_sha256
)`;
