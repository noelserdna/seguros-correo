import { simpleParser, type ParsedMail, type SimpleParserOptions, type Source } from "mailparser";

/**
 * Analiza un correo. Un correo adjunto dentro de otro se trata siempre como adjunto: así se
 * puede abrir y se lee su texto aparte. Si no, la librería lo funde con el cuerpo cuando
 * viene marcado como «en línea», y deja de verse como adjunto.
 *
 * Todo el servidor debe analizar igual: los adjuntos se localizan por su posición.
 */
export function parseMail(source: Source): Promise<ParsedMail> {
  return simpleParser(source, { ignoreEmbedded: true } as SimpleParserOptions);
}
