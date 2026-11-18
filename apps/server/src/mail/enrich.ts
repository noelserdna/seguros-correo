import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { Db } from "../db/client.ts";
import {
  attachments,
  events,
  messageAddresses,
  messages,
  type Address,
  type AddressRole,
} from "../db/schema.ts";
import type { RawStore } from "../storage/raw-store.ts";

const SNIPPET_LENGTH = 200;
const MAX_HEADER_VALUE = 2000;

export type Structured = {
  bodyText: string;
  snippet: string;
  hasAttachments: boolean;
  replyTo: Address[];
  bcc: Address[];
  direction: "in" | "out";
  autoReply: boolean;
  priority: "high" | "low" | null;
  headers: Record<string, string[]>;
  searchExtra: string;
  addresses: { role: AddressRole; address: string; domain: string; name: string }[];
};

function list(field: AddressObject | AddressObject[] | undefined): Address[] {
  const groups = field ? (Array.isArray(field) ? field : [field]) : [];
  return groups
    .flatMap((group) => group.value)
    .filter((entry) => entry.address)
    .map((entry) => ({ name: entry.name, address: entry.address! }));
}

const firstHeader = (headers: Record<string, string[]>, name: string) =>
  (headers[name]?.[0] ?? "").trim().toLowerCase();

/** Prioridad que marcó quien lo envió, según las cabeceras que usan Outlook y el resto. */
function priorityOf(headers: Record<string, string[]>): "high" | "low" | null {
  const importance =
    firstHeader(headers, "importance") || firstHeader(headers, "x-msmail-priority");
  if (importance === "high") return "high";
  if (importance === "low") return "low";
  const level = Number.parseInt(firstHeader(headers, "x-priority"), 10);
  if (level === 1 || level === 2) return "high";
  if (level === 4 || level === 5) return "low";
  return null;
}

/**
 * Saca de un correo ya analizado todo lo que tiene forma fija: participantes y su papel,
 * sentido, prioridad, si es una respuesta automática y las cabeceras completas.
 * No interpreta el contenido: eso es cosa de quien escriba los datos de negocio.
 */
export function extractStructured(parsed: ParsedMail, accountEmail: string): Structured {
  const headers: Record<string, string[]> = {};
  for (const { key, line } of parsed.headerLines) {
    const value = line
      .slice(line.indexOf(":") + 1)
      .replace(/\s+/g, " ")
      .trim();
    (headers[key] ??= []).push(value.slice(0, MAX_HEADER_VALUE));
  }

  const roles: [AddressRole, Address[]][] = [
    ["from", list(parsed.from)],
    ["to", list(parsed.to)],
    ["cc", list(parsed.cc)],
    ["bcc", list(parsed.bcc)],
    ["reply_to", list(parsed.replyTo)],
  ];
  const seen = new Set<string>();
  const addresses: Structured["addresses"] = [];
  for (const [role, entries] of roles) {
    for (const entry of entries) {
      const address = entry.address.trim().toLowerCase();
      const key = `${role} ${address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push({ role, address, domain: address.split("@")[1] ?? "", name: entry.name });
    }
  }

  const from = addresses.find((entry) => entry.role === "from")?.address ?? "";
  const autoSubmitted = firstHeader(headers, "auto-submitted");
  const autoReply =
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    "x-autoreply" in headers ||
    "x-autorespond" in headers ||
    firstHeader(headers, "precedence") === "auto_reply";

  const text = parsed.text ?? "";
  const files = parsed.attachments.filter((part) => !part.related);
  const recipients = addresses
    .filter((entry) => entry.role !== "from")
    .map((entry) => `${entry.name} ${entry.address}`);
  const fileNames = files.flatMap((part) => (part.filename ? [part.filename] : []));

  return {
    bodyText: text,
    snippet: text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH),
    hasAttachments: files.length > 0,
    replyTo: list(parsed.replyTo),
    bcc: list(parsed.bcc),
    direction: from === accountEmail.trim().toLowerCase() ? "out" : "in",
    autoReply,
    priority: priorityOf(headers),
    headers,
    searchExtra: [...recipients, ...fileNames].join(" "),
    addresses,
  };
}

/**
 * Procesa el original de un correo y deja en la base sus datos estructurados. Se puede
 * repetir las veces que haga falta: sustituye lo anterior. Al terminar avisa con el
 * evento `message.enriched`, que es donde se engancha quien extraiga datos de negocio.
 */
export async function enrichMessage(
  db: Db,
  rawStore: RawStore,
  input: { messageId: string; accountId: string; accountEmail: string; rawSha256: string },
): Promise<void> {
  const parsed = await simpleParser(rawStore.open(input.rawSha256));
  const data = extractStructured(parsed, input.accountEmail);
  const { addresses, ...columns } = data;

  await db.transaction(async (tx) => {
    await tx
      .update(messages)
      .set({ ...columns, rawSha256: input.rawSha256, enrichedAt: new Date() })
      .where(eq(messages.id, input.messageId));

    await tx.delete(attachments).where(eq(attachments.messageId, input.messageId));
    if (parsed.attachments.length > 0) {
      await tx.insert(attachments).values(
        parsed.attachments.map((part, position) => ({
          messageId: input.messageId,
          position,
          filename: part.filename ?? null,
          contentType: part.contentType,
          size: part.size,
          contentId: part.cid ?? null,
          inline: part.related === true,
          contentSha256: createHash("sha256").update(part.content).digest("hex"),
        })),
      );
    }

    await tx.delete(messageAddresses).where(eq(messageAddresses.messageId, input.messageId));
    if (addresses.length > 0) {
      await tx.insert(messageAddresses).values(
        addresses.map((entry) => ({
          ...entry,
          accountId: input.accountId,
          messageId: input.messageId,
        })),
      );
    }

    await tx.insert(events).values({
      accountId: input.accountId,
      type: "message.enriched",
      messageId: input.messageId,
    });
  });
}
