import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { FetchMessageObject, FetchQueryObject, MessageAddressObject } from "imapflow";
import type { Db, Tx } from "../db/client.ts";
import { events, folderMessages, messages, threads, type Address } from "../db/schema.ts";
import { fingerprint, parseMessageIds } from "./fingerprint.ts";
import type { Folder } from "./types.ts";

/** Lo que se pide al servidor para dar de alta un correo sin bajar su cuerpo. */
export const ENVELOPE_QUERY: FetchQueryObject = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  headers: ["references"],
};

export type RemoteMessage = {
  uid: number;
  flags: string[];
  modseq: bigint | null;
  emailId: string | null;
  internalDate: Date;
  size: number;
  messageIdHeader: string | null;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  date: Date | null;
  inReplyTo: string | null;
  references: string[];
};

/**
 * Marcas tal como se guardan: ordenadas y sin `\Recent`, que no es una marca del
 * correo sino del estado de cada sesión (cambia sola y generaría eventos falsos).
 */
export const normalizeFlags = (flags: Iterable<string> | undefined): string[] =>
  [...new Set(flags ?? [])].filter((flag) => flag.toLowerCase() !== "\\recent").sort();

const toAddresses = (list: MessageAddressObject[] | undefined): Address[] =>
  (list ?? []).map((entry) => ({ name: entry.name ?? "", address: entry.address ?? "" }));

export function toRemoteMessage(message: FetchMessageObject): RemoteMessage {
  const envelope = message.envelope;
  const headerText = message.headers?.toString("utf8") ?? "";
  const referencesHeader = /^references:([\s\S]*)/i.exec(headerText)?.[1];
  const inReplyTo = parseMessageIds(envelope?.inReplyTo)[0] ?? null;
  return {
    uid: message.uid,
    flags: normalizeFlags(message.flags),
    modseq: message.modseq ?? null,
    emailId: message.emailId ?? null,
    internalDate: new Date(message.internalDate ?? envelope?.date ?? Date.now()),
    size: message.size ?? 0,
    messageIdHeader: envelope?.messageId?.trim() || null,
    subject: envelope?.subject ?? "",
    from: toAddresses(envelope?.from)[0] ?? { name: "", address: "" },
    to: toAddresses(envelope?.to),
    cc: toAddresses(envelope?.cc),
    date: envelope?.date ? new Date(envelope.date) : null,
    inReplyTo,
    references: parseMessageIds(referencesHeader),
  };
}

/**
 * Busca el hilo al que pertenece un correo por sus cabeceras; si enlaza varios
 * hilos que ya existían, los une. Siempre dentro del mismo buzón, y nunca por asunto.
 */
async function resolveThread(tx: Tx, accountId: string, remote: RemoteMessage): Promise<string> {
  const related = [
    ...new Set([...remote.references, ...(remote.inReplyTo ? [remote.inReplyTo] : [])]),
  ];
  const conditions = [];
  if (related.length > 0) conditions.push(inArray(messages.messageIdHeader, related));
  if (remote.messageIdHeader) {
    conditions.push(eq(messages.inReplyTo, remote.messageIdHeader));
    conditions.push(sql`${remote.messageIdHeader} = any(${messages.references})`);
  }

  const found =
    conditions.length === 0
      ? []
      : await tx
          .selectDistinct({ threadId: messages.threadId })
          .from(messages)
          .where(and(eq(messages.accountId, accountId), or(...conditions)));
  const [keep, ...merge] = found.map((row) => row.threadId).sort();

  if (!keep) {
    const [thread] = await tx.insert(threads).values({ accountId }).returning({ id: threads.id });
    return thread!.id;
  }
  if (merge.length > 0) {
    await tx.update(messages).set({ threadId: keep }).where(inArray(messages.threadId, merge));
    await tx.delete(threads).where(inArray(threads.id, merge));
  }
  return keep;
}

export type IngestResult = { created: number; attached: number };

/**
 * Da de alta en la base los correos vistos en una carpeta.
 *
 * Si la huella coincide con un correo ya conocido, se enlaza a él: es el mismo
 * correo movido o copiado, y conserva su identificador. Si no, es un correo nuevo.
 */
export async function ingestMessages(
  db: Db,
  folder: Folder,
  uidValidity: number,
  remoteMessages: RemoteMessage[],
  { emitEvents }: { emitEvents: boolean },
): Promise<IngestResult> {
  const result: IngestResult = { created: 0, attached: 0 };
  const accountId = folder.accountId;

  for (let offset = 0; offset < remoteMessages.length; offset += 100) {
    const chunk = remoteMessages.slice(offset, offset + 100);
    await db.transaction(async (tx) => {
      for (const remote of chunk) {
        const [known] = await tx
          .select({ id: folderMessages.id })
          .from(folderMessages)
          .where(
            and(
              eq(folderMessages.folderId, folder.id),
              eq(folderMessages.uidValidity, uidValidity),
              eq(folderMessages.uid, remote.uid),
            ),
          );
        if (known) continue;

        const print = fingerprint({
          messageIdHeader: remote.messageIdHeader,
          internalDate: remote.internalDate,
          size: remote.size,
          subject: remote.subject,
          fromAddress: remote.from.address,
        });
        const [existing] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.accountId, accountId), eq(messages.fingerprint, print)))
          .limit(1);

        let messageId: string;
        if (existing) {
          messageId = existing.id;
          const elsewhere = await tx
            .selectDistinct({ folderId: folderMessages.folderId })
            .from(folderMessages)
            .where(eq(folderMessages.messageId, messageId));
          const fromFolderIds = elsewhere
            .map((row) => row.folderId)
            .filter((id) => id !== folder.id);
          await tx
            .update(messages)
            .set({ removedFromServerAt: null })
            .where(eq(messages.id, messageId));
          result.attached++;
          if (emitEvents && fromFolderIds.length > 0) {
            await tx.insert(events).values({
              accountId,
              type: "message.moved",
              messageId,
              payload: { toFolderId: folder.id, toFolder: folder.path, fromFolderIds },
            });
          }
        } else {
          const threadId = await resolveThread(tx, accountId, remote);
          const [created] = await tx
            .insert(messages)
            .values({
              accountId,
              fingerprint: print,
              messageIdHeader: remote.messageIdHeader,
              threadId,
              subject: remote.subject,
              fromName: remote.from.name,
              fromAddress: remote.from.address,
              to: remote.to,
              cc: remote.cc,
              date: remote.date,
              internalDate: remote.internalDate,
              size: remote.size,
              inReplyTo: remote.inReplyTo,
              references: remote.references,
            })
            .returning({ id: messages.id });
          messageId = created!.id;
          result.created++;
          if (emitEvents) {
            await tx.insert(events).values({
              accountId,
              type: "message.received",
              messageId,
              payload: { folderId: folder.id, folder: folder.path, specialUse: folder.specialUse },
            });
          }
        }

        await tx.insert(folderMessages).values({
          accountId,
          folderId: folder.id,
          uidValidity,
          uid: remote.uid,
          messageId,
          flags: remote.flags,
          modseq: remote.modseq,
          emailId: remote.emailId,
        });
      }
    });
  }
  return result;
}
