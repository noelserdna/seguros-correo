import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { messageFacts, type FactMethod } from "../db/schema.ts";

export type Fact = typeof messageFacts.$inferSelect;

export type NewFact = {
  kind: string;
  value: string;
  detail?: Record<string, unknown>;
  source?: string;
  evidence?: string;
  confidence?: number;
};

/** Tipo en minúsculas y sin espacios: `Póliza ` y `poliza` no deben ser dos tipos distintos. */
export const normalizeKind = (kind: string) =>
  kind
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/**
 * Sustituye los datos que un extractor había dejado en un correo por los nuevos. Es la
 * forma de escribir para reglas y modelos: volver a procesar un correo no acumula
 * versiones viejas, y los datos de otros extractores (o de personas) no se tocan.
 */
export async function replaceFacts(
  db: Db,
  target: { accountId: string; messageId: string; extractor: string; method: FactMethod },
  facts: NewFact[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(messageFacts)
      .where(
        and(
          eq(messageFacts.messageId, target.messageId),
          eq(messageFacts.extractor, target.extractor),
        ),
      );
    const rows = facts
      .map((fact) => ({ ...fact, kind: normalizeKind(fact.kind), value: fact.value.trim() }))
      .filter((fact) => fact.kind && fact.value);
    if (rows.length === 0) return;
    await tx
      .insert(messageFacts)
      .values(rows.map((fact) => ({ ...target, ...fact })))
      .onConflictDoNothing();
  });
}

/** Añade un dato suelto (por ejemplo, el que escribe una persona). */
export async function addFact(
  db: Db,
  target: { accountId: string; messageId: string; extractor: string; method: FactMethod },
  fact: NewFact,
  confirmedBy?: string,
): Promise<Fact | null> {
  const kind = normalizeKind(fact.kind);
  const value = fact.value.trim();
  if (!kind || !value) return null;
  const [row] = await db
    .insert(messageFacts)
    .values({
      ...target,
      ...fact,
      kind,
      value,
      confirmedBy: confirmedBy ?? null,
      confirmedAt: confirmedBy ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export const factsOf = (db: Db, messageId: string) =>
  db
    .select()
    .from(messageFacts)
    .where(eq(messageFacts.messageId, messageId))
    .orderBy(asc(messageFacts.kind), asc(messageFacts.value));
