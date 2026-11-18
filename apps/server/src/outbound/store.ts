import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, asc, eq, inArray } from "drizzle-orm";
import { simpleParser } from "mailparser";
import type { User } from "../auth/sessions.ts";
import type { Db } from "../db/client.ts";
import {
  events,
  identities,
  messages,
  outboundAttachments,
  outboundMessages,
  type Address,
  type OutboundKind,
} from "../db/schema.ts";
import type { Account } from "../imap/connection.ts";
import { renderEmailHtml, renderEmailText, type InlineImage } from "../mail/render.ts";
import type { RawStore } from "../storage/raw-store.ts";
import { cleanOutgoingHtml, escapeHtml, textToHtml } from "./html.ts";
import type { Outbound, OutboundAttachment } from "./mime.ts";

export type OutboundErrorCode = "not_editable" | "no_recipients" | "too_big" | "not_queued";

/** Lo pedido no se puede hacer con el correo en su estado actual. El mensaje se enseña al usuario. */
export class OutboundError extends Error {
  constructor(
    readonly code: OutboundErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Deps = { db: Db; rawStore: RawStore };

/** Tope del total de adjuntos de un correo. */
export const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
/** Margen para deshacer un envío. */
export const UNDO_SEND_MS = 10_000;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function unique(list: Address[], except: string[] = []): Address[] {
  const seen = new Set(except.map((address) => address.toLowerCase()));
  return list.filter((entry) => {
    const key = entry.address.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const show = (entry: Address) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address);

const longDate = (date: Date) =>
  date.toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" });

export async function getSignature(db: Db, accountId: string, userId: string): Promise<string> {
  const [row] = await db
    .select({ signature: identities.signature })
    .from(identities)
    .where(and(eq(identities.accountId, accountId), eq(identities.userId, userId)));
  return row?.signature ?? "";
}

export async function setSignature(
  db: Db,
  accountId: string,
  userId: string,
  signature: string,
): Promise<void> {
  await db
    .insert(identities)
    .values({ accountId, userId, signature })
    .onConflictDoUpdate({
      target: [identities.accountId, identities.userId],
      set: { signature },
    });
}

const signatureBlock = (signature: string) =>
  signature.trim() ? `<div data-firma="1">--<br>${textToHtml(signature.trim())}</div>` : "";

/**
 * Crea un borrador. Si responde o reenvía, llega ya con destinatarios, asunto y el
 * correo original citado; al reenviar se copian también sus adjuntos.
 */
export async function createOutbound(
  deps: Deps,
  input: { account: Account; user: User; kind: OutboundKind; sourceMessageId?: string },
): Promise<Outbound> {
  const { db, rawStore } = deps;
  const { account, user, kind } = input;
  const signature = signatureBlock(await getSignature(db, account.id, user.id));
  const domain = account.email.split("@")[1] ?? "localhost";
  const base = {
    accountId: account.id,
    userId: user.id,
    kind,
    messageIdHeader: `<${randomUUID()}@${domain}>`,
  };

  if (kind === "new" || !input.sourceMessageId) {
    const [created] = await db
      .insert(outboundMessages)
      .values({ ...base, kind: "new", bodyHtml: `<div><br></div>${signature}` })
      .returning();
    return created!;
  }

  const [source] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, input.sourceMessageId), eq(messages.accountId, account.id)));
  if (!source) throw new OutboundError("not_editable", "El correo original ya no está disponible.");

  const parsed = source.rawSha256 ? await simpleParser(rawStore.open(source.rawSha256)) : null;
  const inlineImages = new Map<string, InlineImage>();
  for (const part of parsed?.attachments ?? []) {
    if (part.cid)
      inlineImages.set(part.cid, { contentType: part.contentType, content: part.content });
  }
  const original = parsed?.html
    ? renderEmailHtml(parsed.html, { inlineImages }).html
    : renderEmailText(parsed?.text ?? source.bodyText ?? "").html;

  const from: Address = { name: source.fromName, address: source.fromAddress };
  const replyTo = (parsed?.replyTo?.value ?? [])
    .filter((entry) => entry.address)
    .map((entry) => ({ name: entry.name, address: entry.address! }));
  const prefixed = (prefix: string) =>
    /^\s*(re|rv|fw|fwd)\s*:/i.test(source.subject) && prefix === "RE"
      ? source.subject
      : `${prefix}: ${source.subject.replace(/^\s*(rv|fw|fwd)\s*:\s*/i, "")}`;

  let to: Address[] = [];
  let cc: Address[] = [];
  let bodyHtml: string;
  if (kind === "forward") {
    const header = [
      `<b>De:</b> ${escapeHtml(show(from))}`,
      `<b>Enviado:</b> ${escapeHtml(longDate(source.internalDate))}`,
      `<b>Para:</b> ${escapeHtml(source.to.map(show).join("; "))}`,
      ...(source.cc.length > 0 ? [`<b>CC:</b> ${escapeHtml(source.cc.map(show).join("; "))}`] : []),
      `<b>Asunto:</b> ${escapeHtml(source.subject)}`,
    ].join("<br>");
    bodyHtml = `<div><br></div>${signature}<div><br></div><div>---------- Mensaje reenviado ----------<br>${header}</div><div><br></div>${original}`;
  } else {
    // Si el original lo enviamos nosotros (se responde desde Enviados), va a quien se le escribió.
    const sentByUs = same(source.fromAddress, account.email);
    to = unique(sentByUs ? source.to : replyTo.length > 0 ? replyTo : [from]);
    if (kind === "replyAll") {
      cc = unique(sentByUs ? source.cc : [...source.to, ...source.cc], [
        account.email,
        ...to.map((entry) => entry.address),
      ]);
    }
    const who = escapeHtml(from.name || from.address);
    bodyHtml = `<div><br></div>${signature}<div><br></div><div>El ${escapeHtml(longDate(source.internalDate))}, ${who} escribió:</div><blockquote style="margin: 8px 0; padding-left: 12px; border-left: 2px solid #c9d1dc">${original}</blockquote>`;
  }

  const references = [
    ...source.references,
    ...(source.messageIdHeader ? [source.messageIdHeader] : []),
  ];
  const [created] = await db
    .insert(outboundMessages)
    .values({
      ...base,
      sourceMessageId: source.id,
      inReplyTo: kind === "forward" ? null : source.messageIdHeader,
      references: kind === "forward" ? [] : references,
      to,
      cc,
      subject: prefixed(kind === "forward" ? "RV" : "RE"),
      bodyHtml,
    })
    .returning();

  if (kind === "forward") {
    for (const part of parsed?.attachments ?? []) {
      if (part.related) continue;
      const saved = await rawStore.save(Readable.from(part.content));
      await db.insert(outboundAttachments).values({
        outboundId: created!.id,
        filename: part.filename ?? "adjunto",
        contentType: part.contentType,
        size: saved.size,
        sha256: saved.sha256,
      });
    }
  }
  return created!;
}

/** El correo y sus adjuntos, solo para quien lo escribió. */
export async function findOutbound(
  db: Db,
  id: string,
  userId: string,
): Promise<{ outbound: Outbound; files: OutboundAttachment[] } | null> {
  const [outbound] = await db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.userId, userId)));
  if (!outbound || outbound.state === "discarded") return null;
  const files = await db
    .select()
    .from(outboundAttachments)
    .where(eq(outboundAttachments.outboundId, id))
    .orderBy(asc(outboundAttachments.createdAt));
  return { outbound, files };
}

const EDITABLE = ["draft", "failed"] as const;
const notEditable = () =>
  new OutboundError(
    "not_editable",
    "Este correo ya está saliendo o ya se envió: no se puede cambiar.",
  );

export type OutboundFields = {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyHtml: string;
};

async function touch(db: Db, id: string, userId: string, fields: Partial<OutboundFields> = {}) {
  const [updated] = await db
    .update(outboundMessages)
    .set({ ...fields, state: "draft", error: null, draftDirty: true, updatedAt: new Date() })
    .where(
      and(
        eq(outboundMessages.id, id),
        eq(outboundMessages.userId, userId),
        inArray(outboundMessages.state, [...EDITABLE]),
      ),
    )
    .returning();
  if (!updated) throw notEditable();
  return updated;
}

/** Guarda el borrador. Queda pendiente de llevarlo a Borradores en el servidor de correo. */
export const saveOutbound = (db: Db, id: string, userId: string, fields: OutboundFields) =>
  touch(db, id, userId, { ...fields, bodyHtml: cleanOutgoingHtml(fields.bodyHtml) });

export async function addAttachment(
  deps: Deps,
  id: string,
  userId: string,
  file: { filename: string; contentType: string; content: Buffer },
): Promise<OutboundAttachment> {
  const found = await findOutbound(deps.db, id, userId);
  if (!found) throw notEditable();
  const total = found.files.reduce((sum, entry) => sum + entry.size, 0) + file.content.length;
  if (total > MAX_ATTACHMENTS_BYTES) {
    throw new OutboundError(
      "too_big",
      "Los adjuntos de un correo no pueden pasar de 20 MB en total.",
    );
  }
  await touch(deps.db, id, userId);
  const saved = await deps.rawStore.save(Readable.from(file.content));
  const [created] = await deps.db
    .insert(outboundAttachments)
    .values({
      outboundId: id,
      filename: file.filename.replace(/[\r\n\\/]/g, "_").slice(0, 200) || "adjunto",
      contentType: file.contentType,
      size: saved.size,
      sha256: saved.sha256,
    })
    .returning();
  return created!;
}

export async function removeAttachment(db: Db, id: string, userId: string, attachmentId: string) {
  await touch(db, id, userId);
  await db
    .delete(outboundAttachments)
    .where(and(eq(outboundAttachments.id, attachmentId), eq(outboundAttachments.outboundId, id)));
}

/** Descarta el borrador. Si ya estaba en Borradores en el servidor, se quitará de allí. */
export async function discardOutbound(db: Db, id: string, userId: string): Promise<void> {
  const [updated] = await db
    .update(outboundMessages)
    .set({ state: "discarded", draftDirty: true, updatedAt: new Date() })
    .where(
      and(
        eq(outboundMessages.id, id),
        eq(outboundMessages.userId, userId),
        inArray(outboundMessages.state, [...EDITABLE]),
      ),
    )
    .returning({ id: outboundMessages.id });
  if (!updated) throw notEditable();
}

/** Pone el correo en la Bandeja de salida. Sale pasado el margen para deshacer. */
export async function queueSend(
  db: Db,
  id: string,
  userId: string,
  delayMs = UNDO_SEND_MS,
): Promise<Outbound> {
  return db.transaction(async (tx) => {
    const [outbound] = await tx
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.userId, userId)))
      .for("update");
    if (!outbound || !EDITABLE.some((state) => state === outbound.state)) throw notEditable();
    if (outbound.to.length + outbound.cc.length + outbound.bcc.length === 0) {
      throw new OutboundError("no_recipients", "Falta al menos un destinatario.");
    }
    const [queued] = await tx
      .update(outboundMessages)
      .set({
        state: "queued",
        error: null,
        sendAfter: new Date(Date.now() + delayMs),
        updatedAt: new Date(),
      })
      .where(eq(outboundMessages.id, id))
      .returning();
    await tx.insert(events).values({
      accountId: outbound.accountId,
      type: "outbound.changed",
      payload: { outboundId: id, state: "queued", userId },
    });
    return queued!;
  });
}

/** Deshace un envío que aún no ha salido: vuelve a ser un borrador. */
export async function cancelSend(db: Db, id: string, userId: string): Promise<Outbound> {
  const [updated] = await db
    .update(outboundMessages)
    .set({ state: "draft", sendAfter: null, updatedAt: new Date() })
    .where(
      and(
        eq(outboundMessages.id, id),
        eq(outboundMessages.userId, userId),
        eq(outboundMessages.state, "queued"),
      ),
    )
    .returning();
  if (!updated) {
    throw new OutboundError("not_queued", "El correo ya ha salido: no se puede deshacer el envío.");
  }
  await db.insert(events).values({
    accountId: updated.accountId,
    type: "outbound.changed",
    payload: { outboundId: id, state: "draft", userId },
  });
  return updated;
}

/** Lo que este usuario tiene esperando o atascado en la Bandeja de salida de un buzón. */
export const listOutbox = (db: Db, accountId: string, userId: string) =>
  db
    .select({
      id: outboundMessages.id,
      subject: outboundMessages.subject,
      to: outboundMessages.to,
      state: outboundMessages.state,
      error: outboundMessages.error,
      sendAfter: outboundMessages.sendAfter,
      updatedAt: outboundMessages.updatedAt,
    })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.accountId, accountId),
        eq(outboundMessages.userId, userId),
        inArray(outboundMessages.state, ["queued", "sending", "failed"]),
      ),
    )
    .orderBy(asc(outboundMessages.updatedAt));
