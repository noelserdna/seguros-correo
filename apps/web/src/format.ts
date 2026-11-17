/** Fechas, tamaños y nombres tal como se muestran en pantalla. */

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DAY_MS = 24 * 60 * 60_000;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const two = (value: number) => String(value).padStart(2, "0");
const time = (date: Date) => `${date.getHours()}:${two(date.getMinutes())}`;

/** Días naturales entre dos fechas (0 = hoy, 1 = ayer…). */
function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY_MS);
}

/** Fecha corta para la lista: «10:42», «lun 17:20», «14 nov» o «14/11/2025». */
export function formatListDate(value: string | Date, now = new Date()): string {
  const date = new Date(value);
  const days = daysAgo(date, now);
  if (days === 0) return time(date);
  if (days > 0 && days < 7) return `${WEEKDAYS[date.getDay()]} ${time(date)}`;
  if (date.getFullYear() === now.getFullYear())
    return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** Fecha completa para el correo abierto: «Hoy, 10:42» o «18 dic 2024, 12:10». */
export function formatFullDate(value: string | Date, now = new Date()): string {
  const date = new Date(value);
  const days = daysAgo(date, now);
  if (days === 0) return `Hoy, ${time(date)}`;
  if (days === 1) return `Ayer, ${time(date)}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${time(date)}`;
}

/** Fecha sin hora: «3 de marzo de 2025». */
export function formatLongDay(value: string | Date): string {
  return new Date(value).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export type DateGroup = "Hoy" | "Ayer" | "Esta semana" | "Este mes" | "Anteriores";

/** Grupo de la lista al que pertenece una fecha. */
export function dateGroup(value: string | Date, now = new Date()): DateGroup {
  const date = new Date(value);
  const days = daysAgo(date, now);
  if (days <= 0) return "Hoy";
  if (days === 1) return "Ayer";
  if (days < 7) return "Esta semana";
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return "Este mes";
  }
  return "Anteriores";
}

/** Tiempo transcurrido, para el estado de la barra: «ahora mismo», «hace 3 min», «hace 2 h». */
export function formatAgo(value: string | Date, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "ahora mismo";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/** Tamaño de fichero con coma decimal: «248 KB», «1,2 MB». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/** Tipo de fichero en palabras, por su nombre. */
export function fileKind(filename: string | null, contentType: string): string {
  const extension = filename?.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf" || contentType === "application/pdf") return "PDF";
  if (contentType.startsWith("image/")) return "Imagen";
  if (["doc", "docx", "odt"].includes(extension)) return "Documento";
  if (["xls", "xlsx", "ods", "csv"].includes(extension)) return "Hoja de cálculo";
  if (["zip", "rar", "7z"].includes(extension)) return "Comprimido";
  if (extension === "eml" || extension === "msg") return "Correo";
  return extension ? extension.toUpperCase() : "Fichero";
}

/** Nombre para mostrar de un remitente: el nombre si lo hay; si no, la dirección. */
export const displayName = (name: string, address: string) =>
  name.trim() || address || "(sin remitente)";

/** Iniciales para el círculo del remitente. */
export function initials(name: string, address: string): string {
  const words = displayName(name, address)
    .replace(/[^\p{L}\p{N}\s@.]/gu, " ")
    .split(/[\s@.]+/)
    .filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

export const isUnread = (flags: string[]) => !flags.includes("\\Seen");
export const isFlagged = (flags: string[]) => flags.includes("\\Flagged");
