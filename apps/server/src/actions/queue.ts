import { and, eq, isNull } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import {
  auditLog,
  events,
  folderMessages,
  folders,
  mailActions,
  type MailActionPayload,
  type MailActionType,
} from "../db/schema.ts";
import { normalizeFlags } from "../sync/ingest.ts";

export type MailAction = typeof mailActions.$inferSelect;

export type ActionErrorCode = "not_there" | "bad_target" | "confirm_permanent" | "not_undoable";

/** La acción no se puede pedir tal como está el buzón. El mensaje se enseña al usuario. */
export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Marcas que se pueden cambiar desde la interfaz. */
export const SETTABLE_FLAGS = ["\\Seen", "\\Flagged"] as const;

export type ActionRequest =
  | { kind: "flags"; add: string[]; remove: string[] }
  | { kind: "move"; targetFolderId: string }
  /** Borrar: a la Papelera; si ya está en ella (o no hay), del buzón, previa confirmación. */
  | { kind: "delete"; confirmPermanent: boolean };

export type QueueInput = {
  userId: string;
  messageId: string;
  /** Carpeta en la que el usuario está viendo el correo. */
  folderId: string;
  request: ActionRequest;
};

const notThere = () =>
  new ActionError("not_there", "Este correo ya no está en esa carpeta. Puede que se haya movido.");

async function insertAction(
  tx: Tx,
  values: {
    accountId: string;
    userId: string;
    messageId: string;
    folderId: string;
    type: MailActionType;
    payload: MailActionPayload;
    undoOf?: string;
  },
): Promise<MailAction> {
  const [action] = await tx.insert(mailActions).values(values).returning();
  await tx.insert(events).values({
    accountId: values.accountId,
    type: "action.queued",
    messageId: values.messageId,
    payload: { actionId: action!.id, type: values.type, folderId: values.folderId },
  });
  await tx.insert(auditLog).values({
    userId: values.userId,
    accountId: values.accountId,
    action: values.undoOf ? "message.undo" : `message.${values.type}`,
    target: values.messageId,
    detail: {
      actionId: action!.id,
      folderId: values.folderId,
      add: values.payload.add,
      remove: values.payload.remove,
      targetFolderId: values.payload.targetFolderId,
    },
  });
  return action!;
}

/**
 * Pide una acción sobre un correo. El cambio se aplica ya en nuestra base, para que la
 * pantalla lo refleje al instante, y queda en cola hasta que el servidor de correo lo
 * reciba. Devuelve `null` si no hay nada que cambiar.
 */
export async function queueAction(db: Db, input: QueueInput): Promise<MailAction | null> {
  const { userId, messageId, folderId, request } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(folderMessages)
      .where(
        and(
          eq(folderMessages.messageId, messageId),
          eq(folderMessages.folderId, folderId),
          isNull(folderMessages.goneAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw notThere();
    const base = { accountId: row.accountId, userId, messageId, folderId };
    const position = { uid: row.uid, uidValidity: row.uidValidity, folderMessageId: row.id };

    if (request.kind === "flags") {
      const remove = new Set(request.remove);
      const flags = normalizeFlags([...row.flags, ...request.add].filter((f) => !remove.has(f)));
      const add = request.add.filter((flag) => !row.flags.includes(flag));
      const removed = request.remove.filter((flag) => row.flags.includes(flag));
      if (add.length === 0 && removed.length === 0) return null;
      await tx.update(folderMessages).set({ flags }).where(eq(folderMessages.id, row.id));
      return insertAction(tx, {
        ...base,
        type: "flags",
        payload: { ...position, add, remove: removed },
      });
    }

    const accountFolders = await tx
      .select()
      .from(folders)
      .where(and(eq(folders.accountId, row.accountId), isNull(folders.goneAt)));

    let targetFolderId: string | null;
    if (request.kind === "move") {
      targetFolderId = request.targetFolderId;
      if (targetFolderId === folderId || !accountFolders.some((f) => f.id === targetFolderId)) {
        throw new ActionError("bad_target", "No se puede mover a esa carpeta.");
      }
    } else {
      const trash = accountFolders.find((folder) => folder.specialUse === "trash");
      targetFolderId = trash && trash.id !== folderId ? trash.id : null;
      if (!targetFolderId && !request.confirmPermanent) {
        throw new ActionError(
          "confirm_permanent",
          "Este correo se borrará del buzón del servidor. Se conservará en el archivo.",
        );
      }
    }

    // Deja de verse en la carpeta desde ya; si la acción falla, vuelve a aparecer.
    await tx
      .update(folderMessages)
      .set({ goneAt: new Date() })
      .where(eq(folderMessages.id, row.id));
    return insertAction(
      tx,
      targetFolderId
        ? { ...base, type: "move", payload: { ...position, targetFolderId } }
        : { ...base, type: "expunge", payload: position },
    );
  });
}

/** Busca una acción por su identificador. */
export async function findAction(db: Db, id: string): Promise<MailAction | undefined> {
  const [action] = await db.select().from(mailActions).where(eq(mailActions.id, id));
  return action;
}

/**
 * Deshace un movimiento (también el borrado a la Papelera). Si aún no ha salido hacia
 * el servidor de correo, se cancela; si ya se hizo, se pide el movimiento contrario.
 */
export async function undoAction(db: Db, userId: string, actionId: string): Promise<MailAction> {
  return db.transaction(async (tx) => {
    const [action] = await tx
      .select()
      .from(mailActions)
      .where(eq(mailActions.id, actionId))
      .for("update");
    const notUndoable = (message: string) => new ActionError("not_undoable", message);
    if (!action || action.type !== "move" || action.undoOf) {
      throw notUndoable("Esta acción no se puede deshacer.");
    }
    const [already] = await tx
      .select({ id: mailActions.id })
      .from(mailActions)
      .where(eq(mailActions.undoOf, actionId));
    if (already) throw notUndoable("Esta acción ya se ha deshecho.");

    if (action.state === "pending") {
      if (action.payload.folderMessageId) {
        await tx
          .update(folderMessages)
          .set({ goneAt: null })
          .where(eq(folderMessages.id, action.payload.folderMessageId));
      }
      const [cancelled] = await tx
        .update(mailActions)
        .set({ state: "cancelled", finishedAt: new Date() })
        .where(eq(mailActions.id, actionId))
        .returning();
      await tx.insert(events).values({
        accountId: action.accountId,
        type: "action.queued",
        messageId: action.messageId,
        payload: { actionId, cancelled: true, folderId: action.folderId },
      });
      await tx.insert(auditLog).values({
        userId,
        accountId: action.accountId,
        action: "message.undo",
        target: action.messageId,
        detail: { actionId, cancelled: true },
      });
      return cancelled!;
    }
    if (action.state !== "done") {
      throw notUndoable(
        action.state === "running"
          ? "La acción se está aplicando ahora mismo. Vuelve a intentarlo en un momento."
          : "Esta acción no llegó a hacerse.",
      );
    }

    // Ya está hecho en el servidor: se pide el movimiento de vuelta.
    const from = action.payload.targetFolderId!;
    const [row] = await tx
      .select()
      .from(folderMessages)
      .where(
        and(
          eq(folderMessages.messageId, action.messageId),
          eq(folderMessages.folderId, from),
          isNull(folderMessages.goneAt),
        ),
      )
      .limit(1)
      .for("update");
    const uid = row?.uid ?? action.result?.uid;
    const uidValidity = row?.uidValidity ?? action.result?.uidValidity;
    if (uid === undefined || uidValidity === undefined) {
      throw notUndoable("No se encuentra el correo en la carpeta a la que se movió.");
    }
    if (row) {
      await tx
        .update(folderMessages)
        .set({ goneAt: new Date() })
        .where(eq(folderMessages.id, row.id));
    }
    return insertAction(tx, {
      accountId: action.accountId,
      userId,
      messageId: action.messageId,
      folderId: from,
      type: "move",
      payload: { uid, uidValidity, folderMessageId: row?.id, targetFolderId: action.folderId },
      undoOf: actionId,
    });
  });
}
