import sanitizeHtml from "sanitize-html";
import { renderEmailHtml } from "../mail/render.ts";

export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Texto sin formato a HTML, conservando los saltos de línea. */
export const textToHtml = (text: string) => escapeHtml(text).replace(/\r?\n/g, "<br>");

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Versión de solo texto de un correo HTML, para los programas que no muestran HTML. */
export function htmlToText(html: string): string {
  const spaced = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n");
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Lo que sale hacia fuera pasa por el mismo filtro que lo que entra: el editor es del
 * navegador y no hay que fiarse de lo que mande.
 */
export const cleanOutgoingHtml = (html: string) =>
  renderEmailHtml(html, { allowRemoteImages: true }).html;
