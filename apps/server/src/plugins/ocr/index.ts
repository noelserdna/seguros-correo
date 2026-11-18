import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { loadDocument, saveRecognizedText } from "../../documents/store.ts";
import { requireSession } from "../../http/app.ts";
import type { PluginServices, ServerPlugin } from "../host.ts";
import { closeEngine, ENGINE, recognize } from "./engine.ts";
import { renderForOcr } from "./render.ts";

/** Por debajo de esto, lo «leído» es ruido: una foto sin texto da letras sueltas. */
const MIN_CHARS = 12;
const MIN_CONFIDENCE = 0.35;

const clean = (text: string) =>
  text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

type Pending = { sha: string; hasPages: boolean };

/**
 * Reconocimiento de texto en fotos y escaneados. Es un módulo opcional: sin él, esos
 * adjuntos se quedan como «sin procesar» y todo lo demás funciona igual.
 *
 * No depende de los avisos del correo: mira qué documentos siguen sin texto y los va
 * leyendo de uno en uno, sin frenar la sincronización ni al resto de módulos. De cada
 * documento apunta en su propia tabla si lo ha intentado, para no repetirlo.
 */
export class OcrWorker {
  readonly #services: PluginServices;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  constructor(services: PluginServices) {
    this.#services = services;
  }

  /** Lee hasta `limit` documentos pendientes. Devuelve cuántos ha atendido. */
  async drain(limit = 5): Promise<number> {
    const { db } = this.#services;
    const pending = await db.execute<Pending>(sql`
      select d.content_sha256 as sha, d.pages > 0 as "hasPages"
        from document_texts d
        left join ocr_jobs j on j.content_sha256 = d.content_sha256
       where (d.status = 'needs_ocr' or d.pages_needing_ocr > 0) and j.content_sha256 is null
       order by d.created_at
       limit ${limit}`);
    for (const row of pending.rows) await this.#read(row);
    return pending.rows.length;
  }

  async #read({ sha, hasPages }: Pending): Promise<void> {
    const { db, rawStore } = this.#services;
    const started = Date.now();
    let state = "done";
    let detail: string | null = null;
    let pages = 0;
    try {
      const document = await loadDocument(db, rawStore, sha);
      if (!document) throw new Error("No se encuentra el correo que traía este adjunto.");
      // En un PDF con parte del texto ya leído, solo hacen falta las páginas escaneadas.
      const wanted = hasPages
        ? (
            await db.execute<{ page: number }>(sql`
              select page from document_pages
               where content_sha256 = ${sha} and method = 'sin_texto' order by page`)
          ).rows.map((row) => row.page)
        : null;
      const rendered = await renderForOcr(document, wanted);
      if (rendered.kind === "unsupported") {
        state = "unsupported";
        detail = rendered.reason;
      } else {
        const recognized = [];
        for (const { page, image } of rendered.pages) {
          const result = await recognize(image);
          const text = clean(result.text);
          const useful = text.length >= MIN_CHARS && result.confidence >= MIN_CONFIDENCE;
          recognized.push({ page, text: useful ? text : "", confidence: result.confidence });
        }
        pages = recognized.length;
        await saveRecognizedText(db, sha, { engine: ENGINE, pages: recognized });
        if (rendered.skipped > 0) {
          detail = `Se han dejado sin leer ${rendered.skipped} páginas: el documento es muy largo.`;
        }
      }
    } catch (error) {
      state = "failed";
      detail = error instanceof Error ? error.message : String(error);
    }
    await db.execute(sql`
      insert into ocr_jobs (content_sha256, state, engine, pages, ms, detail)
      values (${sha}, ${state}, ${ENGINE}, ${pages}, ${Date.now() - started}, ${detail})
      on conflict (content_sha256) do update
        set state = excluded.state, pages = excluded.pages, ms = excluded.ms,
            detail = excluded.detail, finished_at = now()`);
  }

  start(intervalMs = 4000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#busy) return;
      this.#busy = true;
      void this.drain()
        .catch((error: unknown) => console.error("OCR: fallo al reconocer texto", error))
        .finally(() => {
          this.#busy = false;
        });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await closeEngine();
  }
}

export async function setupOcr(db: Db): Promise<void> {
  await db.execute(sql`
    create table if not exists ocr_jobs (
      content_sha256 text primary key,
      state text not null,
      engine text not null,
      pages integer not null default 0,
      ms integer not null default 0,
      detail text,
      finished_at timestamptz not null default now()
    )`);
}

let worker: OcrWorker | null = null;

export const ocrPlugin: ServerPlugin = {
  id: "ocr",
  setup: setupOcr,
  start(services) {
    worker = new OcrWorker(services);
    worker.start();
  },
  async stop() {
    await worker?.stop();
    worker = null;
  },
  // Cómo va la cola, para enseñarlo en Configuración.
  routes: async (app, { context }) => {
    app.get("/status", async (request) => {
      requireSession(request);
      const jobs = await context.db.execute<{ state: string; documents: number; ms: number }>(sql`
        select state, count(*)::int as documents, coalesce(sum(ms), 0)::int as ms
          from ocr_jobs group by state`);
      const waiting = await context.db.execute<{ documents: number }>(sql`
        select count(*)::int as documents
          from document_texts d
          left join ocr_jobs j on j.content_sha256 = d.content_sha256
         where (d.status = 'needs_ocr' or d.pages_needing_ocr > 0) and j.content_sha256 is null`);
      return { engine: ENGINE, waiting: waiting.rows[0]?.documents ?? 0, jobs: jobs.rows };
    });
  },
};
