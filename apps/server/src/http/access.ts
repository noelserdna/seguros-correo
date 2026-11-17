import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accountAccess } from "../db/schema.ts";
import { notFound } from "./app.ts";

/** Comprueba que el usuario tiene concedido el buzón; si no, como si no existiera. */
export async function assertAccess(db: Db, userId: string, accountId: string): Promise<void> {
  const [row] = await db
    .select({ accountId: accountAccess.accountId })
    .from(accountAccess)
    .where(and(eq(accountAccess.userId, userId), eq(accountAccess.accountId, accountId)));
  if (!row) throw notFound();
}

/** Identificadores de los buzones que el usuario tiene concedidos. */
export async function accessibleAccountIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ accountId: accountAccess.accountId })
    .from(accountAccess)
    .where(eq(accountAccess.userId, userId));
  return rows.map((row) => row.accountId);
}
