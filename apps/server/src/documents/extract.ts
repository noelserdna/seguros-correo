import { simpleParser } from "mailparser";
import type { DocumentStatus } from "../db/schema.ts";
import { htmlToText } from "../outbound/html.ts";

export type ExtractedPage = { page: number; label?: string; text: string; method: string };
export type Extracted = {
  status: DocumentStatus;
  method: string | null;
  pages: ExtractedPage[];
  /** Páginas sin texto que necesitan reconocimiento. */
  pagesNeedingOcr: number;
  error?: string;
};

/** Por encima de este tamaño no se intenta: un adjunto así no es un documento de texto corriente. */
const MAX_BYTES = 40 * 1024 * 1024;
/** Una página de PDF con menos texto que esto se considera escaneada. */
const MIN_PAGE_CHARS = 40;
/** Tope por página u hoja, para que un fichero desmesurado no llene la base. */
const MAX_PAGE_CHARS = 400_000;
const TIMEOUT_MS = 90_000;

const tidy = (text: string) =>
  text
    .replaceAll("\u0000", "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_PAGE_CHARS);

const single = (text: string, method: string): Extracted => {
  const clean = tidy(text);
  return clean
    ? { status: "ok", method, pages: [{ page: 1, text: clean, method }], pagesNeedingOcr: 0 }
    : { status: "empty", method, pages: [], pagesNeedingOcr: 0 };
};

type Kind = "pdf" | "docx" | "xlsx" | "msg" | "eml" | "text" | "html" | "image" | "unknown";

/** Qué es el fichero: manda su contenido; el nombre y el tipo declarado solo desempatan. */
export function detectKind(filename: string | null, contentType: string, content: Buffer): Kind {
  const extension = (filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  const type = contentType.toLowerCase();
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const isZip = content[0] === 0x50 && content[1] === 0x4b;
  if (isZip && (extension === "docx" || type.includes("wordprocessingml"))) return "docx";
  if (isZip && (extension === "xlsx" || type.includes("spreadsheetml"))) return "xlsx";
  const isOle = content.readUInt32BE(0) === 0xd0cf11e0;
  if (isOle && (extension === "msg" || type.includes("ms-outlook"))) return "msg";
  if (extension === "eml" || type === "message/rfc822") return "eml";
  if (
    type.startsWith("image/") ||
    ["jpg", "jpeg", "png", "tif", "tiff", "heic", "webp", "bmp"].includes(extension)
  ) {
    return "image";
  }
  if (type === "text/html" || extension === "html" || extension === "htm") return "html";
  if (type.startsWith("text/") || ["txt", "csv", "log", "md", "xml", "json"].includes(extension)) {
    return "text";
  }
  return "unknown";
}

async function fromPdf(content: Buffer): Promise<Extracted> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(content));
  const { text } = await extractText(pdf, { mergePages: false });
  let pagesNeedingOcr = 0;
  const pages = text.map((raw, index) => {
    const clean = tidy(raw);
    const scanned = clean.length < MIN_PAGE_CHARS;
    if (scanned) pagesNeedingOcr++;
    return { page: index + 1, text: clean, method: scanned ? "sin_texto" : "capa_texto" };
  });
  const withText = pages.filter((page) => page.method === "capa_texto");
  return {
    status: withText.length > 0 ? "ok" : pages.length > 0 ? "needs_ocr" : "empty",
    method: "pdf_texto",
    // Las páginas escaneadas se guardan vacías: marcan el hueco que rellenará el reconocimiento.
    pages: pages.filter((page) => page.method === "capa_texto" || withText.length > 0),
    pagesNeedingOcr,
  };
}

async function fromDocx(content: Buffer): Promise<Extracted> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: content });
  return single(value, "docx");
}

async function fromXlsx(content: Buffer): Promise<Extracted> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content as unknown as ArrayBuffer);
  const pages: ExtractedPage[] = [];
  workbook.eachSheet((sheet) => {
    const lines: string[] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => cells.push(cell.text.trim()));
      if (cells.some(Boolean)) lines.push(cells.join("\t"));
    });
    const text = tidy(lines.join("\n"));
    if (text) pages.push({ page: pages.length + 1, label: sheet.name, text, method: "xlsx" });
  });
  return { status: pages.length > 0 ? "ok" : "empty", method: "xlsx", pages, pagesNeedingOcr: 0 };
}

type MsgData = { subject?: string; senderName?: string; senderEmail?: string; body?: string };
type MsgReaderClass = new (data: ArrayBuffer) => { getFileData(): MsgData };

async function fromMsg(content: Buffer): Promise<Extracted> {
  // El paquete se publica de forma que, según cómo se cargue, la clase viene un nivel más adentro.
  const loaded = (await import("@kenjiuno/msgreader")) as unknown as {
    default: MsgReaderClass | { default: MsgReaderClass };
  };
  const Reader = "default" in loaded.default ? loaded.default.default : loaded.default;
  const data = new Reader(
    content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer,
  ).getFileData();
  const header = [
    data.subject && `Asunto: ${data.subject}`,
    (data.senderName || data.senderEmail) &&
      `De: ${[data.senderName, data.senderEmail].filter(Boolean).join(" ")}`,
  ].filter(Boolean);
  return single([...header, "", data.body ?? ""].join("\n"), "msg");
}

async function fromEml(content: Buffer): Promise<Extracted> {
  const parsed = await simpleParser(content);
  const header = [
    parsed.subject && `Asunto: ${parsed.subject}`,
    parsed.from?.text && `De: ${parsed.from.text}`,
    parsed.date && `Fecha: ${parsed.date.toISOString()}`,
  ].filter(Boolean);
  const body = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "");
  return single([...header, "", body].join("\n"), "eml");
}

/**
 * Saca el texto de un documento adjunto, página a página cuando el formato las tiene.
 * No reconoce texto en imágenes: los escaneados y las fotos quedan marcados como
 * pendientes de reconocimiento. Nunca lanza: un fichero roto se anota como fallido.
 */
export async function extractDocument(file: {
  filename: string | null;
  contentType: string;
  content: Buffer;
}): Promise<Extracted> {
  const none = { method: null, pages: [], pagesNeedingOcr: 0 };
  if (file.content.length === 0) return { ...none, status: "empty" };
  if (file.content.length > MAX_BYTES) {
    return { ...none, status: "failed", error: "El fichero es demasiado grande para leerlo." };
  }
  const kind =
    file.content.length >= 4
      ? detectKind(file.filename, file.contentType, file.content)
      : "unknown";
  const run = async (): Promise<Extracted> => {
    switch (kind) {
      case "pdf":
        return fromPdf(file.content);
      case "docx":
        return fromDocx(file.content);
      case "xlsx":
        return fromXlsx(file.content);
      case "msg":
        return fromMsg(file.content);
      case "eml":
        return fromEml(file.content);
      case "html":
        return single(htmlToText(file.content.toString("utf8")), "html");
      case "text":
        return single(file.content.toString("utf8"), "texto");
      case "image":
        return { ...none, status: "needs_ocr", pagesNeedingOcr: 1 };
      default:
        return { ...none, status: "unsupported" };
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<Extracted>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Ha tardado demasiado.")), TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return {
      ...none,
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 300) : "Error desconocido.",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
