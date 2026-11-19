/**
 * Otras vías de entrega además del SMTP. Un módulo puede quedarse con un envío (por ejemplo,
 * si el destinatario es un contacto de WhatsApp) y entregarlo él. El resto del circuito es el
 * de siempre: margen para deshacer, reintentos, marca de respondido y aviso de enviado.
 */
import type { ImapFlow } from "imapflow";
import type { Db } from "../db/client.ts";
import type { Account } from "../imap/connection.ts";
import type { RawStore } from "../storage/raw-store.ts";
import type { Outbound, OutboundAttachment } from "./mime.ts";

export type DeliveryInput = {
  db: Db;
  /** La conexión IMAP del buzón, ya abierta: para dejar la copia donde corresponda. */
  client: ImapFlow;
  account: Account;
  rawStore: RawStore;
  outbound: Outbound;
  files: OutboundAttachment[];
};

export type OutboundTransport = {
  id: string;
  /** Si este envío es suyo. */
  claims: (outbound: Outbound) => boolean;
  /**
   * Lo entrega y deja su copia (la vía decide dónde: no va a Enviados). Si no puede, lanza
   * un Error con el texto que verá quien lo envió.
   */
  deliver: (input: DeliveryInput) => Promise<void>;
};

const transports: OutboundTransport[] = [];

export function registerTransport(transport: OutboundTransport): void {
  const index = transports.findIndex((entry) => entry.id === transport.id);
  if (index >= 0) transports.splice(index, 1, transport);
  else transports.push(transport);
}

export const transportFor = (outbound: Outbound) =>
  transports.find((transport) => transport.claims(outbound));

/** Direcciones de dominio reservado: no existen fuera, nunca salen por SMTP. */
export const undeliverable = (outbound: Outbound) =>
  [...outbound.to, ...outbound.cc, ...outbound.bcc].filter((address) =>
    /\.invalid$/i.test(address.address),
  );
