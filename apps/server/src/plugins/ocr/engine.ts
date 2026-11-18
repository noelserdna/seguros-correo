import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Worker } from "tesseract.js";

export const ENGINE = "ocr:tesseract-spa";

/** Los datos del idioma van instalados con la aplicación: no se descarga nada en marcha. */
const languageDir = join(
  dirname(createRequire(import.meta.url).resolve("@tesseract.js-data/spa/package.json")),
  "4.0.0_best_int",
);

let worker: Promise<Worker> | null = null;

async function engine(): Promise<Worker> {
  worker ??= import("tesseract.js").then(({ createWorker }) =>
    createWorker("spa", 1, { langPath: languageDir, gzip: true, cacheMethod: "none" }),
  );
  return worker;
}

/** Texto impreso que se ve en una imagen (PNG, JPEG, BMP o WebP), y con qué seguridad. */
export async function recognize(image: Buffer): Promise<{ text: string; confidence: number }> {
  const { data } = await (await engine()).recognize(image);
  return { text: data.text, confidence: data.confidence / 100 };
}

export async function closeEngine(): Promise<void> {
  const current = worker;
  worker = null;
  if (current) await (await current).terminate().catch(() => undefined);
}
