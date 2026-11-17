import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AccountConnectionError } from "../accounts/accounts.ts";
import { AttemptLimiter } from "../auth/rate-limit.ts";
import { findSession, type Session } from "../auth/sessions.ts";
import { UserError } from "../auth/users.ts";
import type { SecretBox } from "../crypto/secrets.ts";
import type { Db } from "../db/client.ts";
import { auditLog } from "../db/schema.ts";
import type { Account } from "../imap/connection.ts";
import type { RawStore } from "../storage/raw-store.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { contentRoutes } from "./routes/content.ts";
import { mailRoutes } from "./routes/mail.ts";

export const SESSION_COOKIE = "correo_sesion";
export const CSRF_HEADER = "x-csrf-token";

export type AppDeps = {
  db: Db;
  secrets: SecretBox;
  rawStore: RawStore;
  /** Marcar la cookie como solo-HTTPS. Activo en producción. */
  cookieSecure?: boolean;
  limiter?: AttemptLimiter;
  /** Se llama al dar de alta un buzón, para empezar a sincronizarlo. */
  onAccountCreated?: (account: Account) => void;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** No se distingue «no existe» de «no tienes acceso», para no revelar qué hay. */
export const notFound = () => new HttpError(404, "not_found", "No encontrado.");

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
}

export function requireSession(request: FastifyRequest): Session {
  if (!request.session) throw new HttpError(401, "unauthenticated", "Hay que iniciar sesión.");
  return request.session;
}

export function requireAdmin(request: FastifyRequest): Session {
  const session = requireSession(request);
  if (session.user.role !== "admin") {
    throw new HttpError(403, "forbidden", "Solo un administrador puede hacer esto.");
  }
  return session;
}

export type AuditEntry = {
  userId?: string | null;
  accountId?: string | null;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown>;
};

export const audit = (db: Db, entry: AuditEntry) => db.insert(auditLog).values(entry);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const context = { ...deps, limiter: deps.limiter ?? new AttemptLimiter() };

  await app.register(cookie);
  app.decorateRequest("session", null);

  app.addHook("onRequest", async (request) => {
    request.session = await findSession(deps.db, request.cookies[SESSION_COOKIE]);
  });

  // Toda petición que cambia algo con una sesión abierta debe traer el token de la
  // sesión en una cabecera: una página ajena puede provocar la petición, pero no leerlo.
  app.addHook("preHandler", async (request) => {
    if (SAFE_METHODS.has(request.method) || !request.session) return;
    if (request.headers[CSRF_HEADER] !== request.session.csrfToken) {
      throw new HttpError(403, "csrf", "Petición rechazada: falta el token de la sesión.");
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "invalid", message: "Datos no válidos." });
    }
    if (error instanceof UserError) {
      return reply.status(422).send({ error: "invalid", message: error.message });
    }
    if (error instanceof AccountConnectionError) {
      return reply.status(422).send({ error: `connection_${error.kind}`, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: "invalid", message: "Petición no válida." });
    }
    console.error(error);
    return reply.status(500).send({ error: "internal", message: "Error interno." });
  });

  await app.register(authRoutes, { prefix: "/api/auth", context });
  await app.register(adminRoutes, { prefix: "/api/admin", context });
  await app.register(mailRoutes, { prefix: "/api", context });
  await app.register(contentRoutes, { prefix: "/api", context });
  return app;
}

export type RouteContext = AppDeps & { limiter: AttemptLimiter };
export type RouteOptions = { context: RouteContext };
