import type { StoredDocument } from "../../documents/store.ts";

export type PageImage = { page: number; image: Buffer };
export type Rendered =
  { kind: "pages"; pages: PageImage[]; skipped: number } | { kind: "unsupported"; reason: string };

/** Tope de páginas por documento: un escaneado de 300 páginas no debe parar la cola. */
export const MAX_PAGES = 40;

const starts = (content: Buffer, bytes: number[]) =>
  content.subarray(0, bytes.length).equals(Buffer.from(bytes));

/**
 * Convierte un documento en las imágenes que hay que leer: la propia foto, o cada página
 * de un PDF. `wanted` limita las páginas de un PDF a las que no traían texto.
 */
export async function renderForOcr(
  document: StoredDocument,
  wanted: number[] | null,
): Promise<Rendered> {
  const { content } = document;
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") {
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(content));
    const all = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
    const numbers = (wanted ?? all).filter((page) => page >= 1 && page <= pdf.numPages);
    const pages: PageImage[] = [];
    for (const page of numbers.slice(0, MAX_PAGES)) {
      const image = await renderPageAsImage(pdf, page, {
        canvasImport: () => import("@napi-rs/canvas"),
        // Unos 150 puntos por pulgada: suficiente para texto impreso sin tardar de más.
        scale: 2,
      });
      pages.push({ page, image: Buffer.from(image) });
    }
    return { kind: "pages", pages, skipped: Math.max(0, numbers.length - MAX_PAGES) };
  }

  const jpeg = starts(content, [0xff, 0xd8, 0xff]);
  const png = starts(content, [0x89, 0x50, 0x4e, 0x47]);
  const bmp = starts(content, [0x42, 0x4d]);
  const webp =
    content.subarray(0, 4).toString("latin1") === "RIFF" &&
    content.subarray(8, 12).toString("latin1") === "WEBP";
  if (jpeg || png || bmp || webp) {
    return { kind: "pages", pages: [{ page: 1, image: content }], skipped: 0 };
  }
  if (content.subarray(0, 3).toString("latin1") === "GIF") {
    // El motor no lee GIF: se pasa a PNG.
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const picture = await loadImage(content);
    const canvas = createCanvas(picture.width, picture.height);
    canvas.getContext("2d").drawImage(picture, 0, 0);
    return { kind: "pages", pages: [{ page: 1, image: canvas.toBuffer("image/png") }], skipped: 0 };
  }
  return { kind: "unsupported", reason: "Formato de imagen que el reconocimiento no sabe abrir." };
}
