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

/**
 * Un adjunto cuenta como leído si se tiene su texto, o si se sabe que no trae ninguno.
 * Una foto en la que el reconocimiento no encuentra texto no cuenta: sigue sin saberse
 * qué contiene hasta que alguien lo anote.
 */
export const READ = sql.raw(
  "(d.status = 'ok' or (d.status = 'empty' and coalesce(d.method, '') not like 'ocr:%' and coalesce(d.method, '') not like 'vision:%'))",
);
/** El estado que se enseña: distingue la foto sin texto del documento vacío. */
export const SHOWN_STATUS = sql.raw(
  "case when d.status = 'empty' and (d.method like 'ocr:%' or d.method like 'vision:%') then 'no_text_image' else d.status end",
);

export const processingOf: SQL<Processing> = sql<Processing>`(
  select json_build_object(
           'bodyPending', ${messages.rawSha256} is null,
           'files', count(a.id)::int,
           'read', (count(a.id) filter (where ${READ}))::int,
           'pending', (count(a.id) filter (where d.status is null or d.status = 'pending'))::int,
           'noted', (count(a.id) filter (
             where d.status is not null and d.status <> 'pending' and not ${READ}
               and exists (select 1 from document_notes n
                            where n.content_sha256 = a.content_sha256)))::int)
    from (select 1) one
    left join attachments a on a.message_id = ${messages.id} and not a.inline
    left join document_texts d on d.content_sha256 = a.content_sha256
)`;
