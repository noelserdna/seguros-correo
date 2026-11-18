import { existsSync } from "node:fs";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
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
import type { OAuthAccountInput } from "../accounts/accounts.ts";
import type { OAuthSettings } from "../oauth/providers.ts";
import type { ServerPlugin } from "../plugins/host.ts";
import type { RawStore } from "../storage/raw-store.ts";
import { adminRoutes } from "./routes/admin.ts";
import { actionRoutes } from "./routes/actions.ts";
import { authRoutes } from "./routes/auth.ts";
import { contentRoutes } from "./routes/content.ts";
import { factRoutes } from "./routes/facts.ts";
import { oauthRoutes } from "./routes/oauth.ts";
import { outboundRoutes } from "./routes/outbound.ts";
import { mailRoutes } from "./routes/mail.ts";

const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: http: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SESSION_COOKIE = "correo_sesion";
export const CSRF_HEADER = "x-csrf-token";

export type AppDeps = {
  db: Db;
  secrets: SecretBox;
  rawStore: RawStore;
  /** Acceso con Google y Microsoft 365. Sin él, solo buzones con contraseña. */
  oauth?: OAuthSettings;
  /** Solo para pruebas: sustituye la comprobación de entrada al buzón recién conectado. */
  verifyOAuthConnection?: (input: OAuthAccountInput) => Promise<string[]>;
  /** Marcar la cookie como solo-HTTPS. Activo en producción. */
  cookieSecure?: boolean;
  limiter?: AttemptLimiter;
  /** Carpeta con la interfaz web ya compilada. Si existe, el servidor la sirve. */
  webDir?: string;
  /** Plugins activos. Sus rutas cuelgan de `/api/plugins/<id>`. */
  plugins?: ServerPlugin[];
  /** Todos los módulos que esta instalación podría cargar, activos o no. */
  availablePlugins?: ServerPlugin[];
  /** Se llama al dar de alta un buzón, para empezar a sincronizarlo. */
  onAccountCreated?: (account: Account) => void;
  /** Se llama al encolar una acción, para que el buzón la atienda cuanto antes. */
  onActionQueued?: (accountId: string) => void;
  /** Hay un borrador o un envío nuevo: el buzón debe atenderlo pasado ese tiempo. */
  onOutboundChanged?: (accountId: string, delayMs: number) => void;
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
  // Al cerrar se cortan también las conexiones abiertas (los avisos en vivo no terminan
  // nunca por sí solos); sin esto el servidor no llegaría a apagarse.
  const app = Fastify({ logger: false, forceCloseConnections: true });
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
  await app.register(actionRoutes, { prefix: "/api", context });
  await app.register(factRoutes, { prefix: "/api", context });
  await app.register(outboundRoutes, { prefix: "/api", context });
  await app.register(oauthRoutes, { prefix: "/api", context });
  for (const plugin of deps.plugins ?? []) {
    if (plugin.routes) {
      await app.register(plugin.routes, { prefix: `/api/plugins/${plugin.id}`, context });
    }
  }

  if (deps.webDir && existsSync(deps.webDir)) {
    // Los ficheros se buscan en disco en cada petición: tras recompilar la interfaz no hay que reiniciar.
    await app.register(fastifyStatic, { root: deps.webDir });
    // La interfaz es una sola página: cualquier dirección que no sea de la API la devuelve.
    app.setNotFoundHandler((request, reply) => {
      // Un fichero que no existe (por ejemplo, un script de una versión anterior) es un 404:
      // devolver la página en su lugar deja la pantalla en blanco sin ningún aviso.
      const isFile = /\.[a-z0-9]+$/i.test(request.url.split("?")[0] ?? "");
      if (request.method !== "GET" || request.url.startsWith("/api/") || isFile) {
        return reply.status(404).send({ error: "not_found", message: "No encontrado." });
      }
      return reply.sendFile("index.html");
    });
    app.addHook("onSend", async (_request, reply) => {
      const type = String(reply.getHeader("content-type") ?? "");
      if (!type.startsWith("text/html")) return;
      // Solo código y estilos propios. Las imágenes externas se admiten porque el marco
      // de los correos hereda esta política y las necesita cuando el usuario las pide.
      void reply
        .header("content-security-policy", APP_CSP)
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "no-cache");
    });
  }
  return app;
}

export type RouteContext = AppDeps & { limiter: AttemptLimiter };
export type RouteOptions = { context: RouteContext };
