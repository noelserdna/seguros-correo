import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { sessions, users } from "../db/schema.ts";

export const SESSION_TTL_MS = 12 * 60 * 60_000;

export type User = Omit<typeof users.$inferSelect, "passwordHash">;
export type Session = { user: User; csrfToken: string; tokenHash: string };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");

/** Abre una sesión. Devuelve el identificador que va en la cookie; en la base solo queda su huella. */
export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; csrfToken: string }> {
  const token = randomToken();
  const csrfToken = randomToken();
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    csrfToken,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { token, csrfToken };
}

export async function findSession(db: Db, token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({
      csrfToken: sessions.csrfToken,
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())));
  if (!row) return null;
  const { csrfToken, ...user } = row;
  return { user, csrfToken, tokenHash };
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}
