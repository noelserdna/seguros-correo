import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { messageFacts, messages } from "../../db/schema.ts";
import { addFact, factsOf, normalizeKind } from "../../facts/facts.ts";
import { accessibleAccountIds, assertAccess } from "../access.ts";
import { audit, HttpError, notFound, requireSession, type RouteOptions } from "../app.ts";

const idParams = z.object({ id: z.uuid() });
const factParams = z.object({ id: z.uuid(), factId: z.uuid() });
const factBody = z.object({
  kind: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(300),
});
const lookupQuery = z.object({
  kind: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const publicFact = (fact: typeof messageFacts.$inferSelect) => ({
  id: fact.id,
  kind: fact.kind,
  value: fact.value,
  source: fact.source,
  evidence: fact.evidence,
  method: fact.method,
  extractor: fact.extractor,
  confidence: fact.confidence,
  confirmed: fact.confirmedAt !== null,
});

/**
 * Datos de negocio ligados a los correos. Aquí solo se leen, se consultan y se añaden a
 * mano; las reglas y los modelos escriben por su cuenta, desde el servidor.
 */
export const factRoutes: FastifyPluginAsync<RouteOptions> = async (app, { context }) => {
  const { db } = context;

  async function loadMessage(userId: string, id: string) {
    const [message] = await db
      .select({ id: messages.id, accountId: messages.accountId })
      .from(messages)
      .where(eq(messages.id, id));
    if (!message) throw notFound();
    await assertAccess(db, userId, message.accountId);
    return message;
  }

  app.get("/messages/:id/facts", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    await loadMessage(user.id, id);
    return { facts: (await factsOf(db, id)).map(publicFact) };
  });

  // Dato escrito por una persona: queda confirmado desde el principio.
  app.post("/messages/:id/facts", async (request) => {
    const { user } = requireSession(request);
    const { id } = idParams.parse(request.params);
    const body = factBody.parse(request.body);
    const message = await loadMessage(user.id, id);
    const fact = await addFact(
      db,
      { accountId: message.accountId, messageId: id, extractor: "manual", method: "user" },
      body,
      user.id,
    );
    if (!fact) throw new HttpError(409, "duplicate", "Ese dato ya está en este correo.");
    await audit(db, {
      userId: user.id,
      accountId: message.accountId,
      action: "message.fact_added",
      target: id,
      detail: { kind: fact.kind, value: fact.value },
    });
    return { fact: publicFact(fact) };
  });

  app.delete("/messages/:id/facts/:factId", async (request) => {
    const { user } = requireSession(request);
    const { id, factId } = factParams.parse(request.params);
    const message = await loadMessage(user.id, id);
    const [removed] = await db
      .delete(messageFacts)
      .where(and(eq(messageFacts.id, factId), eq(messageFacts.messageId, id)))
      .returning();
    if (!removed) throw notFound();
    await audit(db, {
      userId: user.id,
      accountId: message.accountId,
      action: "message.fact_removed",
      target: id,
      detail: { kind: removed.kind, value: removed.value, extractor: removed.extractor },
    });
    return { ok: true };
  });

  // Todos los correos que llevan un dato: «todo lo del siniestro tal».
  app.get("/facts/messages", async (request) => {
    const { user } = requireSession(request);
    const query = lookupQuery.parse(request.query);
    const accountIds = await accessibleAccountIds(db, user.id);
    if (accountIds.length === 0) return { items: [] };
    const rows = await db
      .selectDistinct({
        id: messages.id,
        accountId: messages.accountId,
        threadId: messages.threadId,
        subject: messages.subject,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        internalDate: messages.internalDate,
        hasAttachments: messages.hasAttachments,
        removedFromServerAt: messages.removedFromServerAt,
        snippet: messages.snippet,
      })
      .from(messageFacts)
      .innerJoin(messages, eq(messages.id, messageFacts.messageId))
      .where(
        and(
          inArray(messageFacts.accountId, accountIds),
          eq(messageFacts.kind, normalizeKind(query.kind)),
          eq(messageFacts.value, query.value),
        ),
      )
      .orderBy(desc(messages.internalDate))
      .limit(query.limit);
    return { items: rows };
  });
};
