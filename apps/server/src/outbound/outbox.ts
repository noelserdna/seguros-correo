import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { queueAction } from "../actions/queue.ts";
import type { SecretBox } from "../crypto/secrets.ts";
import {
  events,
  folderMessages,
  folders,
  outboundAttachments,
  outboundMessages,
} from "../db/schema.ts";
import { errorMessage } from "../imap/connection.ts";
import type { SyncContext } from "../sync/types.ts";
import { buildRaw, mailOptions, smtpTransportFor, type Outbound } from "./mime.ts";

export type OutboxResult = { sent: number; failed: number; drafts: number };

/** Posiciones en una carpeta de los correos con esa cabecera Message-ID. */
async function findByMessageId(client: ImapFlow, messageId: string): Promise<number[]> {
  if (!client.mailbox || client.mailbox.exists === 0) return [];
  return (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
}

/** Quita de Borradores todas las versiones del correo. Devuelve si la carpeta existe. */
async function clearDraft(ctx: SyncContext, outbound: Outbound, draftsPath: string | undefined) {
  if (!draftsPath) return;
  const lock = await ctx.client.getMailboxLock(draftsPath);
  try {
    const stale = await findByMessageId(ctx.client, outbound.messageIdHeader);
    if (stale.length > 0) await ctx.client.messageDelete(stale.join(","), { uid: true });
  } finally {
    lock.release();
  }
}

async function fail(ctx: SyncContext, outbound: Outbound, message: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(outboundMessages)
      .set({ state: "failed", error: message, updatedAt: new Date() })
      .where(eq(outboundMessages.id, outbound.id));
    await tx.insert(events).values({
      accountId: outbound.accountId,
      type: "outbound.failed",
      payload: { outboundId: outbound.id, userId: outbound.userId, message },
    });
  });
}

/**
 * Bandeja de salida y borradores de un buzón. Se llama al principio de cada ciclo.
 *
 * Un correo se entrega una sola vez: en cuanto el servidor de salida lo acepta, queda
 * anotado, y si el proceso se corta después solo falta dejar la copia en Enviados. La
 * copia tampoco se duplica: antes de guardarla se mira si ya está, por su Message-ID.
 */
export async function runOutbox(ctx: SyncContext, secrets: SecretBox): Promise<OutboxResult> {
  const { db, client, account, rawStore } = ctx;
  const result: OutboxResult = { sent: 0, failed: 0, drafts: 0 };
  const mine = eq(outboundMessages.accountId, account.id);

  const special = await db
    .select({ path: folders.path, specialUse: folders.specialUse })
    .from(folders)
    .where(and(eq(folders.accountId, account.id), isNull(folders.goneAt)));
  const sentPath = special.find((folder) => folder.specialUse === "sent")?.path;
  const draftsPath = special.find((folder) => folder.specialUse === "drafts")?.path;

  const filesOf = (id: string) =>
    db
      .select()
      .from(outboundAttachments)
      .where(eq(outboundAttachments.outboundId, id))
      .orderBy(asc(outboundAttachments.createdAt));

  /** Tras la entrega: copia en Enviados, fuera de Borradores y marca en el original. */
  const finish = async (outbound: Outbound) => {
    const options = mailOptions(
      account,
      outbound,
      await filesOf(outbound.id),
      rawStore,
      outbound.sendAfter ?? new Date(),
    );
    if (sentPath && !account.serverSavesSent) {
      const lock = await client.getMailboxLock(sentPath);
      let present: number[];
      try {
        present = await findByMessageId(client, outbound.messageIdHeader);
      } finally {
        lock.release();
      }
      if (present.length === 0) await client.append(sentPath, await buildRaw(options), ["\\Seen"]);
    }
    await clearDraft(ctx, outbound, draftsPath);

    await db.transaction(async (tx) => {
      await tx
        .update(outboundMessages)
        .set({ state: "sent", sentAt: new Date(), draftDirty: false, updatedAt: new Date() })
        .where(eq(outboundMessages.id, outbound.id));
      await tx.insert(events).values({
        accountId: account.id,
        type: "outbound.sent",
        payload: { outboundId: outbound.id, userId: outbound.userId },
      });
    });

    // El original queda marcado como respondido o reenviado, también en Outlook.
    if (outbound.sourceMessageId && outbound.kind !== "new") {
      const flag = outbound.kind === "forward" ? "$Forwarded" : "\\Answered";
      const places = await db
        .select({ folderId: folderMessages.folderId })
        .from(folderMessages)
        .where(
          and(
            eq(folderMessages.messageId, outbound.sourceMessageId),
            isNull(folderMessages.goneAt),
          ),
        );
      for (const place of places) {
        await queueAction(db, {
          userId: outbound.userId,
          messageId: outbound.sourceMessageId,
          folderId: place.folderId,
          request: { kind: "flags", add: [flag], remove: [] },
        }).catch(() => undefined);
      }
    }
    result.sent++;
  };

  // 1. Envíos que un corte dejó a medias.
  const interrupted = await db
    .select()
    .from(outboundMessages)
    .where(and(mine, eq(outboundMessages.state, "sending")));
  for (const outbound of interrupted) {
    if (outbound.smtpAcceptedAt) {
      await finish(outbound);
    } else {
      // No se sabe si llegó a salir. Reenviarlo a ciegas podría entregarlo dos veces.
      await fail(
        ctx,
        outbound,
        "El envío se interrumpió y no sabemos si llegó a salir. Míralo en Enviados antes de volver a enviarlo.",
      );
      result.failed++;
    }
  }

  // 2. Envíos cuyo margen para deshacer ya ha pasado.
  for (;;) {
    const [claimed] = await db
      .update(outboundMessages)
      .set({ state: "sending", updatedAt: new Date() })
      .where(
        eq(
          outboundMessages.id,
          db
            .select({ id: outboundMessages.id })
            .from(outboundMessages)
            .where(
              and(
                mine,
                eq(outboundMessages.state, "queued"),
                lte(outboundMessages.sendAfter, new Date()),
              ),
            )
            .orderBy(asc(outboundMessages.sendAfter))
            .limit(1),
        ),
      )
      .returning();
    if (!claimed) break;

    const transport = smtpTransportFor(account, secrets);
    try {
      await transport.sendMail(
        mailOptions(account, claimed, await filesOf(claimed.id), rawStore, claimed.sendAfter!),
      );
    } catch (error) {
      await fail(ctx, claimed, `El servidor de salida no lo ha aceptado: ${errorMessage(error)}`);
      result.failed++;
      continue;
    } finally {
      transport.close();
    }
    const [accepted] = await db
      .update(outboundMessages)
      .set({ smtpAcceptedAt: new Date() })
      .where(eq(outboundMessages.id, claimed.id))
      .returning();
    await finish(accepted!);
  }

  // 3. Borradores que han cambiado: en el servidor queda una sola versión, la última.
  const dirty = await db
    .select()
    .from(outboundMessages)
    .where(and(mine, eq(outboundMessages.draftDirty, true)));
  for (const outbound of dirty) {
    if (outbound.state === "discarded") {
      await clearDraft(ctx, outbound, draftsPath);
      await db.delete(outboundMessages).where(eq(outboundMessages.id, outbound.id));
      continue;
    }
    if (outbound.state !== "draft") continue;
    if (draftsPath) {
      await clearDraft(ctx, outbound, draftsPath);
      const options = mailOptions(
        account,
        outbound,
        await filesOf(outbound.id),
        rawStore,
        outbound.updatedAt,
      );
      await client.append(draftsPath, await buildRaw(options), ["\\Draft", "\\Seen"]);
    }
    // Si se ha vuelto a guardar mientras tanto, sigue pendiente para el próximo ciclo.
    await db
      .update(outboundMessages)
      .set({ draftDirty: false, draftSavedAt: new Date() })
      .where(
        and(
          eq(outboundMessages.id, outbound.id),
          eq(outboundMessages.updatedAt, outbound.updatedAt),
        ),
      );
    result.drafts++;
  }
  return result;
}
