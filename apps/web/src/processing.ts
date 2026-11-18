import type { Processing } from "./api.ts";

export type ProcessingState = {
  /** `ok`: todo leído. `working`: aún en ello. `partial`: hay adjuntos que no se han podido leer. */
  tone: "ok" | "working" | "partial";
  text: string;
};

const files = (count: number) => (count === 1 ? "1 adjunto" : `${count} adjuntos`);

/** El estado de procesado de un correo, en una frase. */
export function processingState(processing: Processing | undefined): ProcessingState {
  if (!processing) return { tone: "ok", text: "" };
  if (processing.bodyPending) {
    return { tone: "working", text: "Trayendo el contenido del correo" };
  }
  if (processing.pending > 0) {
    return { tone: "working", text: `Leyendo ${files(processing.pending)}` };
  }
  const unread = processing.files - processing.read;
  if (unread > 0) {
    const noted =
      processing.noted === 0
        ? ""
        : processing.noted >= unread
          ? unread === 1
            ? ", pero está anotado"
            : ", pero están anotados"
          : ` (${processing.noted} con anotación)`;
    return {
      tone: "partial",
      text:
        unread === processing.files
          ? `${files(unread)} sin procesar${noted}`
          : `${unread} de ${files(processing.files)} sin procesar${noted}`,
    };
  }
  return {
    tone: "ok",
    text: processing.files > 0 ? `${files(processing.files)}, todo leído` : "Procesado",
  };
}
