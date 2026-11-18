import { and, asc, eq, inArray } from "drizzle-orm";
import { events, folderMessages, folders, mailActions } from "../db/schema.ts";
import { errorMessage } from "../imap/connection.ts";
import type { SyncContext } from "../sync/types.ts";
import type { MailAction } from "./queue.ts";

/** La acción no se puede aplicar tal como está el buzón. No tiene sentido reintentarla. */
class Rejected extends Error {}

const GONE = "El correo ya no estaba en esa carpeta: puede que se haya movido desde otro programa.";

type Outcome = { uid?: number; uidValidity?: number };

async function apply(ctx: SyncContext, action: MailAction): Promise<Outcome> {
  const { db, client } = ctx;
  const { uid, uidValidity, add = [], remove = [], targetFolderId } = action.payload;
  const involved = await db
    .select()
    .from(folders)
    .where(inArray(folders.id, [action.folderId, ...(targetFolderId ? [targetFolderId] : [])]));
  const source = involved.find((folder) => folder.id === action.folderId);
  const target = involved.find((folder) => folder.id === targetFolderId);
  if (!source || source.goneAt) throw new Rejected("La carpeta ya no existe.");
  if (action.type === "move" && (!target || target.goneAt)) {
    throw new Rejected("La carpeta de destino ya no existe.");
  }

  const lock = await client.getMailboxLock(source.path);
  try {
    if (!client.mailbox || Number(client.mailbox.uidValidity) !== uidValidity) {
      throw new Rejected("La carpeta ha cambiado en el servidor de correo.");
    }
    const range = String(uid);
    const found = (await client.search({ uid: range }, { uid: true })) || [];
    if (!found.includes(uid)) throw new Rejected(GONE);

    if (action.type === "flags") {
      if (add.length > 0) await client.messageFlagsAdd(range, add, { uid: true });
      if (remove.length > 0) await client.messageFlagsRemove(range, remove, { uid: true });
      return {};
    }
    if (action.type === "expunge") {
      await client.messageDelete(range, { uid: true });
      return {};
    }
    const moved = await client.messageMove(range, target!.path, { uid: true });
    if (!moved) throw new Rejected(GONE);
    const newUid = moved.uidMap?.get(uid);
    return newUid && moved.uidValidity
      ? { uid: newUid, uidValidity: Number(moved.uidValidity) }
      : {};
  } finally {
    lock.release();
  }
}

/** La acción no se ha hecho: se deshace lo adelantado y la carpeta se vuelve a leer entera. */
async function fail(ctx: SyncContext, action: MailAction, message: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(mailActions)
      .set({ state: "failed", error: message, finishedAt: new Date() })
      .where(eq(mailActions.id, action.id));
    if (action.type !== "flags" && action.payload.folderMessageId) {
      await tx
        .update(folderMessages)
        .set({ goneAt: null })
        .where(eq(folderMessages.id, action.payload.folderMessageId));
    }
    // Sin esto, la sincronización podría dar la carpeta por no cambiada y dejar a la
    // vista un estado que el servidor no tiene.
    await tx.update(folders).set({ highestModseq: null }).where(eq(folders.id, action.folderId));
    await tx.insert(events).values({
      accountId: action.accountId,
      type: "action.failed",
      messageId: action.messageId,
      payload: { actionId: action.id, type: action.type, userId: action.userId, message },
    });
  });
}

/**
 * Aplica en el servidor de correo las acciones en cola del buzón, en el orden en que
 * se pidieron. Se llama al principio de cada ciclo, antes de sincronizar, de modo que
 * la sincronización que sigue ya ve el resultado. Devuelve cuántas ha atendido.
 */
export async function runPendingActions(ctx: SyncContext): Promise<number> {
  const { db, client, account } = ctx;
  // Si el proceso se cortó a media acción, se retoma. Repetir una acción ya hecha no
  // hace daño: el correo no estará donde se esperaba y se dará por fallida.
  await db
    .update(mailActions)
    .set({ state: "pending" })
    .where(and(eq(mailActions.accountId, account.id), eq(mailActions.state, "running")));

  let handled = 0;
  for (;;) {
    const [next] = await db
      .select({ id: mailActions.id })
      .from(mailActions)
      .where(and(eq(mailActions.accountId, account.id), eq(mailActions.state, "pending")))
      .orderBy(asc(mailActions.createdAt))
      .limit(1);
    if (!next) return handled;
    // Se reserva: si el usuario la canceló justo ahora, ya no está pendiente.
    const [action] = await db
      .update(mailActions)
      .set({ state: "running" })
      .where(and(eq(mailActions.id, next.id), eq(mailActions.state, "pending")))
      .returning();
    if (!action) continue;

    try {
      const outcome = await apply(ctx, action);
      await db.transaction(async (tx) => {
        await tx
          .update(mailActions)
          .set({ state: "done", result: outcome, finishedAt: new Date() })
          .where(eq(mailActions.id, action.id));
        if (action.type === "flags") {
          await tx.insert(events).values({
            accountId: account.id,
            type: "message.flagsChanged",
            messageId: action.messageId,
            payload: {
              folderId: action.folderId,
              added: action.payload.add ?? [],
              removed: action.payload.remove ?? [],
              byUserId: action.userId,
            },
          });
        }
      });
    } catch (error) {
      if (!(error instanceof Rejected) && !client.usable) {
        // Corte de conexión: la acción sigue en cola y se reintenta en el próximo ciclo.
        await db.update(mailActions).set({ state: "pending" }).where(eq(mailActions.id, action.id));
        throw error;
      }
      await fail(
        ctx,
        action,
        error instanceof Rejected
          ? error.message
          : `El servidor de correo la ha rechazado: ${errorMessage(error)}`,
      );
    }
    handled++;
  }
}
