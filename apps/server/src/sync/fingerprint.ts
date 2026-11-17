import { createHash } from "node:crypto";

export type FingerprintInput = {
  messageIdHeader: string | null;
  internalDate: Date;
  size: number;
  subject: string;
  fromAddress: string;
};

/**
 * Huella para reconocer el mismo correo cuando aparece en otra carpeta.
 *
 * El servidor conserva la fecha de llegada y el tamaño al mover o copiar un correo,
 * así que con el Message-ID identifican una copia exacta. El Message-ID solo no basta:
 * la copia de Enviados y la recibida en Entrada lo comparten y son correos distintos.
 */
export function fingerprint(input: FingerprintInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.messageIdHeader ?? "",
        input.internalDate.toISOString(),
        input.size,
        input.subject,
        input.fromAddress.toLowerCase(),
      ]),
    )
    .digest("hex");
}

/** Extrae los identificadores `<...>` de una cabecera References o In-Reply-To. */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.match(/<[^<>\s]+>/g) ?? [])];
}
