import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createAccount } from "../../accounts/accounts.ts";
import { createUser } from "../../auth/users.ts";
import { accountAccess, accounts, users } from "../../db/schema.ts";
import { audit, notFound, requireAdmin, type RouteOptions } from "../app.ts";

const userBody = z.object({
  email: z.email().max(320),
  name: z.string().min(1).max(200),
  password: z.string().max(500),
  role: z.enum(["admin", "user"]).default("user"),
});

const port = z.number().int().min(1).max(65535);
const accountBody = z.object({
  name: z.string().min(1).max(200),
  email: z.email().max(320),
  imapHost: z.string().min(1).max(255),
  imapPort: port,
  imapSecure: z.boolean().optional(),
  smtpHost: z.string().min(1).max(255),
  smtpPort: port,
  smtpSecure: z.boolean().optional(),
  tlsInsecure: z.boolean().optional(),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(500),
});

const accessParams = z.object({ id: z.uuid(), userId: z.uuid() });

/** Lo que se puede enseñar de un buzón: nunca las credenciales. */
export const publicAccount = {
  id: accounts.id,
  name: accounts.name,
  email: accounts.email,
  state: accounts.state,
  lastError: accounts.lastError,
  lastSyncAt: accounts.lastSyncAt,
  authType: accounts.authType,
};

export const adminRoutes: FastifyPluginAsync<RouteOptions> = async (app, { context }) => {
  const { db, secrets } = context;

  // Administrar no da acceso al contenido: para leer un buzón hace falta que
  // alguien conceda ese acceso expresamente, también al administrador.
  app.addHook("preHandler", async (request) => {
    requireAdmin(request);
  });

  app.get("/users", async () => {
    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .orderBy(users.email);
    return { users: rows };
  });

  app.post("/users", async (request, reply) => {
    const admin = requireAdmin(request);
    const user = await createUser(db, userBody.parse(request.body));
    await audit(db, { userId: admin.user.id, action: "user.created", target: user.email });
    return reply.status(201).send({ user });
  });

  app.get("/accounts", async () => {
    const rows = await db.select(publicAccount).from(accounts).orderBy(accounts.email);
    const access = await db.select().from(accountAccess);
    return {
      accounts: rows.map((account) => ({
        ...account,
        userIds: access.filter((row) => row.accountId === account.id).map((row) => row.userId),
      })),
    };
  });

  app.post("/accounts", async (request, reply) => {
    const admin = requireAdmin(request);
    const account = await createAccount(db, secrets, accountBody.parse(request.body));
    await audit(db, {
      userId: admin.user.id,
      accountId: account.id,
      action: "account.created_by",
      target: account.email,
    });
    context.onAccountCreated?.(account);
    const { id, name, email, state, lastError, lastSyncAt, authType } = account;
    // Quien lo da de alta lo ve desde el primer momento.
    await db
      .insert(accountAccess)
      .values({ accountId: id, userId: admin.user.id })
      .onConflictDoNothing();
    return reply
      .status(201)
      .send({ account: { id, name, email, state, lastError, lastSyncAt, authType } });
  });

  app.put("/accounts/:id/access/:userId", async (request) => {
    const admin = requireAdmin(request);
    const { id, userId } = accessParams.parse(request.params);
    const [account] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, id));
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!account || !user) throw notFound();
    await db.insert(accountAccess).values({ accountId: id, userId }).onConflictDoNothing();
    await audit(db, {
      userId: admin.user.id,
      accountId: id,
      action: "account.access_granted",
      target: userId,
    });
    return { ok: true };
  });

  app.delete("/accounts/:id/access/:userId", async (request) => {
    const admin = requireAdmin(request);
    const { id, userId } = accessParams.parse(request.params);
    await db
      .delete(accountAccess)
      .where(and(eq(accountAccess.accountId, id), eq(accountAccess.userId, userId)));
    await audit(db, {
      userId: admin.user.id,
      accountId: id,
      action: "account.access_revoked",
      target: userId,
    });
    return { ok: true };
  });
};
