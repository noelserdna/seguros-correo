import { sql } from "drizzle-orm";
import { loadConfig } from "../../config.ts";
import type { Db } from "../../db/client.ts";
import { renderForOcr } from "../../documents/render.ts";
import { loadDocument, saveModelNote, saveRecognizedText } from "../../documents/store.ts";
import { HttpError, requireSession } from "../../http/app.ts";
import type { PluginServices, ServerPlugin } from "../host.ts";
import { parseAnswer, PROMPT } from "./answer.ts";
import { askModel, TransientError, type VisionSettings } from "./client.ts";

type Job = { sha: string; attempts: number };

const mimeOf = (image: Buffer): string | null => {
  if (image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (image.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (image.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
};

/** Pasa a PNG lo que la API no admite tal cual (BMP, por ejemplo). */
async function forApi(image: Buffer): Promise<{ data: Buffer; mime: string }> {
  const mime = mimeOf(image);
  if (mime) return { data: image, mime };
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const picture = await loadImage(image);
  const canvas = createCanvas(picture.width, picture.height);
  canvas.getContext("2d").drawImage(picture, 0, 0);
  return { data: canvas.toBuffer("image/png"), mime: "image/png" };
}

/**
 * Lee fotos, planos y escaneados con un modelo de visión: su texto y una descripción de
 * qué contienen. Trabaja con una cola en la base de datos: cada documento pasa por
 * «en cola», «leyendo» y «hecho» (o «fallido» tras varios intentos), así que si el
 * servidor se para, al volver sigue donde lo dejó.
 */
export class VisionWorker {
  readonly #db: Db;
  readonly #services: PluginServices;
  readonly #settings: VisionSettings;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  constructor(services: PluginServices, settings: VisionSettings) {
    this.#services = services;
    this.#db = services.db;
    this.#settings = settings;
  }

  get engine(): string {
    return `vision:${this.#settings.model}`;
  }

  /** Pone en cola los documentos que no traen texto propio: imágenes y escaneados. */
  async enqueue(): Promise<number> {
    const result = await this.#db.execute(sql`
      insert into vision_jobs (content_sha256, model)
      select d.content_sha256, ${this.#settings.model}
        from document_texts d
       where d.status = 'needs_ocr' or d.pages_needing_ocr > 0 or d.method like 'ocr:%'
          -- Un PDF escaneado conserva su método aunque el reconocimiento haya leído sus páginas.
          or exists (select 1 from document_pages p
                      where p.content_sha256 = d.content_sha256 and p.method like 'ocr:%')
      on conflict do nothing`);
    return result.rowCount ?? 0;
  }

  /** Atiende lo que hay en cola, varios a la vez. Devuelve cuántos ha atendido. */
  async drain(): Promise<number> {
    await this.enqueue();
    let handled = 0;
    for (;;) {
      const claimed = await this.#db.execute<Job>(sql`
        update vision_jobs
           set state = 'running', started_at = now(), attempts = attempts + 1
         where content_sha256 in (
           select content_sha256 from vision_jobs
            where state = 'queued' and not_before <= now()
            order by queued_at
            limit ${this.#settings.concurrency}
            for update skip locked)
        returning content_sha256 as sha, attempts`);
      if (claimed.rows.length === 0) return handled;
      await Promise.all(claimed.rows.map((job) => this.#process(job)));
      handled += claimed.rows.length;
    }
  }

  async #process({ sha, attempts }: Job): Promise<void> {
    const started = Date.now();
    let cost = 0;
    let tokens = 0;
    const finish = (
      state: string,
      detail: string | null,
      extra: { pages?: number; kind?: string } = {},
    ) =>
      this.#db.execute(sql`
        update vision_jobs
           set state = ${state}, detail = ${detail}, ms = ${Date.now() - started},
               cost = ${cost}, tokens = ${tokens}, pages = ${extra.pages ?? 0},
               kind = ${extra.kind ?? null}, finished_at = now()
         where content_sha256 = ${sha}`);
    try {
      const document = await loadDocument(this.#db, this.#services.rawStore, sha);
      if (!document)
        return void (await finish("failed", "No se encuentra el correo que traía este adjunto."));

      // En un PDF con parte del texto en el propio fichero, solo se leen las páginas escaneadas.
      const pages = await this.#db.execute<{ page: number; method: string }>(sql`
        select page, method from document_pages where content_sha256 = ${sha} order by page`);
      const wanted =
        pages.rows.length === 0
          ? null
          : pages.rows
              .filter((row) => row.method === "sin_texto" || row.method.startsWith("ocr:"))
              .map((row) => row.page);
      if (wanted && wanted.length === 0)
        return void (await finish("done", "No hay páginas escaneadas que leer."));

      const rendered = await renderForOcr(document, wanted);
      if (rendered.kind === "unsupported") return void (await finish("skipped", rendered.reason));
      const images = rendered.pages.slice(0, this.#settings.maxPages);
      const left = rendered.skipped + rendered.pages.length - images.length;

      const read: { page: number; text: string; description: string; kind: string }[] = [];
      for (const { page, image } of images) {
        const reply = await askModel(this.#settings, PROMPT, await forApi(image));
        cost += reply.cost;
        tokens += reply.tokensIn + reply.tokensOut;
        read.push({ page, ...parseAnswer(reply.output) });
      }

      await saveRecognizedText(this.#db, sha, {
        engine: this.engine,
        pages: read.map(({ page, text }) => ({ page, text })),
      });
      const descriptions = read.filter((entry) => entry.description);
      if (descriptions.length > 0) {
        await saveModelNote(this.#db, sha, {
          extractor: this.engine,
          text:
            descriptions.length === 1
              ? descriptions[0]!.description
              : descriptions.map((entry) => `Pág. ${entry.page}: ${entry.description}`).join("\n"),
        });
      }
      await finish(
        "done",
        left > 0 ? `Se han dejado sin leer ${left} páginas: el documento es muy largo.` : null,
        { pages: read.length, kind: read[0]?.kind },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TransientError && attempts < this.#settings.maxAttempts) {
        // Vuelve a la cola, con una espera que crece con cada intento.
        await this.#db.execute(sql`
          update vision_jobs
             set state = 'queued', detail = ${message},
                 not_before = now() + ${`${this.#settings.retryDelayMs * attempts} milliseconds`}::interval
           where content_sha256 = ${sha}`);
        return;
      }
      await finish("failed", message);
    }
  }

  async start(intervalMs = 3000): Promise<void> {
    if (this.#timer) return;
    // Lo que se quedó a medias al parar el servidor vuelve a la cola.
    await this.#db.execute(sql`update vision_jobs set state = 'queued' where state = 'running'`);
    this.#timer = setInterval(() => {
      if (this.#busy) return;
      this.#busy = true;
      void this.drain()
        .catch((error: unknown) => console.error("Visión: fallo en la cola", error))
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

export async function setupVision(db: Db): Promise<void> {
  await db.execute(sql`
    create table if not exists vision_jobs (
      content_sha256 text primary key,
      model text not null,
      state text not null default 'queued',
      attempts integer not null default 0,
      not_before timestamptz not null default now(),
      pages integer not null default 0,
      kind text,
      ms integer not null default 0,
      cost double precision not null default 0,
      tokens integer not null default 0,
      detail text,
      queued_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz
    )`);
  await db.execute(sql`
    create index if not exists vision_jobs_queue on vision_jobs (state, not_before, queued_at)`);
}

export function visionSettings(env: {
  VISION_API_URL: string;
  VISION_API_KEY?: string | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  VISION_MODEL: string;
  VISION_CONCURRENCY: number;
  VISION_MAX_PAGES: number;
}): VisionSettings {
  return {
    apiUrl: env.VISION_API_URL,
    apiKey: env.VISION_API_KEY ?? env.OPENROUTER_API_KEY,
    model: env.VISION_MODEL,
    concurrency: env.VISION_CONCURRENCY,
    maxPages: env.VISION_MAX_PAGES,
    retryDelayMs: 15_000,
    maxAttempts: 3,
  };
}

let worker: VisionWorker | null = null;

export const visionPlugin: ServerPlugin = {
  id: "vision",
  name: "Lectura con modelo de visión",
  description:
    "Transcribe fotos, planos y escaneados y describe qué contienen, con un modelo de visión. Trabaja en cola.",
  setup: setupVision,
  start(services) {
    const settings = visionSettings(services.config);
    if (!settings.apiKey && settings.apiUrl.includes("openrouter.ai")) {
      console.error("Visión: falta la clave del servicio (VISION_API_KEY u OPENROUTER_API_KEY).");
      return;
    }
    worker = new VisionWorker(services, settings);
    void worker.start();
  },
  stop() {
    worker?.stop();
    worker = null;
  },
  routes: async (app, { context }) => {
    const { db } = context;
    // Estado de la cola, para verla trabajar desde Configuración.
    app.get("/status", async (request) => {
      requireSession(request);
      const counts = await db.execute<{
        state: string;
        documents: number;
        cost: number;
        ms: number;
      }>(sql`
        select state, count(*)::int as documents,
               coalesce(sum(cost), 0)::float as cost,
               coalesce(avg(nullif(ms, 0)), 0)::int as ms
          from vision_jobs group by state`);
      const recent = await db.execute(sql`
        select j.content_sha256 as sha, d.filename, j.state, j.kind, j.pages, j.attempts,
               j.ms, j.cost, j.detail,
               coalesce(j.finished_at, j.started_at, j.queued_at) as "at"
          from vision_jobs j join document_texts d using (content_sha256)
         order by (j.state = 'running') desc, coalesce(j.finished_at, j.started_at, j.queued_at) desc
         limit 25`);
      const settings = visionSettings(context.config ?? loadConfig());
      return {
        running: worker !== null,
        model: settings.model,
        service: new URL(settings.apiUrl).host,
        concurrency: settings.concurrency,
        counts: counts.rows,
        recent: recent.rows,
      };
    });
    // Devuelve a la cola lo que falló, para volver a intentarlo.
    app.post("/retry", async (request) => {
      const { user } = requireSession(request);
      if (user.role !== "admin") {
        throw new HttpError(403, "forbidden", "Solo un administrador puede reintentar.");
      }
      const result = await db.execute(sql`
        update vision_jobs set state = 'queued', attempts = 0, not_before = now(), detail = null
         where state = 'failed'`);
      return { queued: result.rowCount ?? 0 };
    });
  },
};
