import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Guarda en disco el original de cada correo (.eml), una sola vez, localizado
 * por la huella SHA-256 de su contenido.
 */
export class RawStore {
  readonly #dir: string;

  constructor(dataDir: string) {
    this.#dir = path.resolve(dataDir, "raw");
  }

  pathFor(sha256: string): string {
    return path.join(this.#dir, sha256.slice(0, 2), `${sha256}.eml`);
  }

  /** Vuelca el flujo a disco sin cargarlo en memoria y devuelve su huella. */
  async save(content: Readable): Promise<{ sha256: string; size: number }> {
    const tmpDir = path.join(this.#dir, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, randomUUID());

    const hash = createHash("sha256");
    let size = 0;
    content.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });
    try {
      await pipeline(content, createWriteStream(tmpPath));
      const sha256 = hash.digest("hex");
      const finalPath = this.pathFor(sha256);
      await mkdir(path.dirname(finalPath), { recursive: true });
      await rename(tmpPath, finalPath);
      return { sha256, size };
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }

  open(sha256: string): Readable {
    return createReadStream(this.pathFor(sha256));
  }

  async has(sha256: string): Promise<boolean> {
    return access(this.pathFor(sha256)).then(
      () => true,
      () => false,
    );
  }
}
