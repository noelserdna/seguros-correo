import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { accounts } from "../../db/schema.ts";
import type { Outbound, OutboundAttachment } from "../../outbound/mime.ts";
import {
  addAttachment,
  cancelSend,
  createOutbound,
  discardOutbound,
  findOutbound,
  getSignature,
  listOutbox,
  MAX_ATTACHMENTS_BYTES,
  OutboundError,
  queueSend,
  removeAttachment,
  saveOutbound,
  setSignature,
  UNDO_SEND_MS,
} from "../../outbound/store.ts";
import { assertAccess } from "../access.ts";
import { audit, HttpError, notFound, requireSession, type RouteOptions } from "../app.ts";

/** Tras guardar un borrador se espera un poco antes de llevarlo al servidor de correo. */
const DRAFT_PUSH_MS = 15_000;

const idParams = z.object({ id: z.uuid() });
const address = z.object({
  name: z.string().trim().max(200).default(""),
  address: z.email().max(320),
});
const recipients = z.array(address).max(100);
const createBody = z.object({
  accountId: z.uuid(),
  kind: z.enum(["new", "reply", "replyAll", "forward"]).default("new"),
  sourceMessageId: z.uuid().optional(),
});
const saveBody = z.object({
  to: recipients,
  cc: recipients,
  bcc: recipients,
  subject: z.string().max(998),
  bodyHtml: z.string().max(2_000_000),
});
const fileQuery = z.object({ filename: z.string().min(1).max(300) });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const signatureBody = z.object({ signature: z.string().max(2000) });

const publicOutbound = (outbound: Outbound, files: OutboundAttachment[]) => ({
  id: outbound.id,
  accountId: outbound.accountId,
  kind: outbound.kind,
  to: outbound.to,
  cc: outbound.cc,
  bcc: outbound.bcc,
  subject: outbound.subject,
  bodyHtml: outbound.bodyHtml,
  state: outbound.state,
  error: outbound.error,
  sendAfter: outbound.sendAfter,
  draftSavedAt: outbound.draftSavedAt,
  updatedAt: outbound.updatedAt,
  attachments: files.map((file) => ({
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
  })),
});

/** Redactar, guardar borradores y enviar. Cada usuario solo ve lo que escribe él. */
export const outboundRoutes: FastifyPluginAsync<RouteOptions> = async (app, { context }) => {
  const { db, rawStore } = context;
  const deps = { db, rawStore };

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_ATTACHMENTS_BYTES },
    (_request, body, done) => done(null, body),
  );

  /** Convierte los rechazos previstos en una respuesta que la interfaz puede enseñar. */
  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof OutboundError) {
        throw new HttpError(error.code === "too_big" ? 413 : 409, error.code, error.message);
      }
      throw error;
    }
  }

  async function load(id: string, userId: string) {
    const found = await findOutbound(db, id, userId);
    if (!found) throw notFound();
    await assertAccess(db, userId, found.outbound.accountId);
    return found;
  }

  app.post("/outbound", async (request) => {
    const { user } = requireSession(request);
    const body = createBody.parse(request.body);
    await assertAccess(db, user.id, body.accountId);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, body.accountId));
    if (!account) throw notFound();
    const outbound = await guarded(() => createOutbound(deps, { account, user, ...body }));
    return { outbound: publicOutbound(outbound, (await load(outbound.id, user.id)).files) };
  });

  app.get("/outbound/:id", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { outbound, files } = await load(id, user.id);
    return { outbound: publicOutbound(outbound, files) };
  });

  app.put("/outbound/:id", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const fields = saveBody.parse(request.body);
    const { files } = await load(id, user.id);
    const outbound = await guarded(() => saveOutbound(db, id, user.id, fields));
    context.onOutboundChanged?.(outbound.accountId, DRAFT_PUSH_MS);
    return { outbound: publicOutbound(outbound, files) };
  });

  app.delete("/outbound/:id", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { outbound } = await load(id, user.id);
    await guarded(() => discardOutbound(db, id, user.id));
    context.onOutboundChanged?.(outbound.accountId, 0);
    return { ok: true };
  });

  app.post("/outbound/:id/attachments", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { filename } = fileQuery.parse(request.query);
    if (!Buffer.isBuffer(request.body)) throw new HttpError(400, "invalid", "Falta el fichero.");
    const content = request.body;
    const { outbound } = await load(id, user.id);
    const file = await guarded(() =>
      addAttachment(deps, id, user.id, {
        filename,
        contentType: String(request.headers["x-file-type"] ?? "") || "application/octet-stream",
        content,
      }),
    );
    context.onOutboundChanged?.(outbound.accountId, DRAFT_PUSH_MS);
    return {
      attachment: {
        id: file.id,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
      },
    };
  });

  app.delete("/outbound/:id/attachments/:fileId", async (request) => {
    const { user } = requireSession(request);
    const { id, fileId } = fileParams.parse(request.params);
    const { outbound } = await load(id, user.id);
    await guarded(() => removeAttachment(db, id, user.id, fileId));
    context.onOutboundChanged?.(outbound.accountId, DRAFT_PUSH_MS);
    return { ok: true };
  });

  app.post("/outbound/:id/send", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { files } = await load(id, user.id);
    const outbound = await guarded(() => queueSend(db, id, user.id));
    await audit(db, {
      userId: user.id,
      accountId: outbound.accountId,
      action: "message.send",
      target: outbound.id,
      detail: {
        to: outbound.to.map((entry) => entry.address),
        cc: outbound.cc.map((entry) => entry.address),
        bcc: outbound.bcc.map((entry) => entry.address),
        subject: outbound.subject,
        attachments: files.map((file) => file.filename),
      },
    });
    context.onOutboundChanged?.(outbound.accountId, UNDO_SEND_MS + 200);
    return { outbound: publicOutbound(outbound, files), undoMs: UNDO_SEND_MS };
  });

  app.post("/outbound/:id/cancel", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { files } = await load(id, user.id);
    const outbound = await guarded(() => cancelSend(db, id, user.id));
    await audit(db, {
      userId: user.id,
      accountId: outbound.accountId,
      action: "message.send_cancelled",
      target: outbound.id,
    });
    return { outbound: publicOutbound(outbound, files) };
  });

  app.get("/accounts/:id/outbox", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    await assertAccess(db, user.id, id);
    return { items: await listOutbox(db, id, user.id) };
  });

  app.get("/accounts/:id/identity", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    await assertAccess(db, user.id, id);
    return { signature: await getSignature(db, id, user.id) };
  });

  app.put("/accounts/:id/identity", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const { signature } = signatureBody.parse(request.body);
    await assertAccess(db, user.id, id);
    await setSignature(db, id, user.id, signature);
    return { signature };
  });
};
