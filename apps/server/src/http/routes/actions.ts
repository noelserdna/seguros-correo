import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ActionError,
  findAction,
  queueAction,
  SETTABLE_FLAGS,
  undoAction,
  type ActionRequest,
  type MailAction,
} from "../../actions/queue.ts";
import { eq } from "drizzle-orm";
import { messages } from "../../db/schema.ts";
import { assertAccess } from "../access.ts";
import { HttpError, notFound, requireSession, type RouteOptions } from "../app.ts";

const idParams = z.object({ id: z.uuid() });
const flag = z.enum(SETTABLE_FLAGS);
const flagsBody = z.object({
  folderId: z.uuid(),
  add: z.array(flag).max(2).default([]),
  remove: z.array(flag).max(2).default([]),
});
const moveBody = z.object({ folderId: z.uuid(), targetFolderId: z.uuid() });
const deleteBody = z.object({ folderId: z.uuid(), permanent: z.boolean().default(false) });

const publicAction = (action: MailAction | null) =>
  action && {
    id: action.id,
    type: action.type,
    state: action.state,
    /** Se puede deshacer: los movimientos, también el borrado a la Papelera. */
    undoable: action.type === "move" && !action.undoOf,
    targetFolderId: action.payload.targetFolderId ?? null,
  };

/** Acciones sobre correos. Todas pasan por la cola del buzón y se reflejan en el servidor de correo. */
export const actionRoutes: FastifyPluginAsync<RouteOptions> = async (app, { context }) => {
  const { db } = context;

  async function run(userId: string, messageId: string, folderId: string, request: ActionRequest) {
    const [message] = await db
      .select({ accountId: messages.accountId })
      .from(messages)
      .where(eq(messages.id, messageId));
    if (!message) throw notFound();
    await assertAccess(db, userId, message.accountId);
    try {
      const action = await queueAction(db, { userId, messageId, folderId, request });
      if (action) context.onActionQueued?.(message.accountId);
      return { action: publicAction(action) };
    } catch (error) {
      if (error instanceof ActionError) throw new HttpError(409, error.code, error.message);
      throw error;
    }
  }

  app.post("/messages/:id/flags", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { folderId, add, remove } = flagsBody.parse(request.body);
    return run(user.id, id, folderId, { kind: "flags", add, remove });
  });

  app.post("/messages/:id/move", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { folderId, targetFolderId } = moveBody.parse(request.body);
    return run(user.id, id, folderId, { kind: "move", targetFolderId });
  });

  // A la Papelera. Si ya está en ella, se borra del buzón: hay que confirmarlo con `permanent`.
  app.post("/messages/:id/delete", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { folderId, permanent } = deleteBody.parse(request.body);
    return run(user.id, id, folderId, { kind: "delete", confirmPermanent: permanent });
  });

  app.post("/actions/:id/undo", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const original = await findAction(db, id);
    if (!original) throw notFound();
    await assertAccess(db, user.id, original.accountId);
    try {
      const action = await undoAction(db, user.id, id);
      context.onActionQueued?.(original.accountId);
      return { action: publicAction(action) };
    } catch (error) {
      if (error instanceof ActionError) throw new HttpError(409, error.code, error.message);
      throw error;
    }
  });
};
