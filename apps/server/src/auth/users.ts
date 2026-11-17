import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { users } from "../db/schema.ts";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./passwords.ts";
import type { User } from "./sessions.ts";

export const MIN_PASSWORD_LENGTH = 10;

export type NewUser = { email: string; name: string; password: string; role?: "admin" | "user" };

export class UserError extends Error {}

/** El usuario sin la huella de su contraseña. */
function toPublicUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt,
  };
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function createUser(db: Db, input: NewUser): Promise<User> {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new UserError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  const email = normalizeEmail(input.email);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw new UserError("Ya existe un usuario con ese correo.");

  const [created] = await db
    .insert(users)
    .values({
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
      role: input.role ?? "user",
    })
    .returning();
  if (!created) throw new Error("No se pudo crear el usuario.");
  return toPublicUser(created);
}

/** Devuelve el usuario si la contraseña es correcta. Tarda lo mismo exista o no el usuario. */
export async function authenticate(db: Db, email: string, password: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)));
  const ok = await verifyPassword(password, row?.passwordHash ?? DUMMY_HASH);
  if (!row || !ok) return null;
  return toPublicUser(row);
}
