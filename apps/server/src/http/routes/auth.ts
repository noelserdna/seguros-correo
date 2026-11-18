import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createSession, deleteSession, SESSION_TTL_MS } from "../../auth/sessions.ts";
import { authenticate } from "../../auth/users.ts";
import { audit, HttpError, requireSession, SESSION_COOKIE, type RouteOptions } from "../app.ts";

const loginBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(500),
});

export const authRoutes: FastifyPluginAsync<RouteOptions> = async (app, { context }) => {
  const { db, limiter } = context;

  app.post("/login", async (request, reply) => {
    const { email, password } = loginBody.parse(request.body);
    const key = `${request.ip}|${email.trim().toLowerCase()}`;
    if (limiter.isBlocked(key)) {
      throw new HttpError(429, "too_many_attempts", "Demasiados intentos. Espera unos minutos.");
    }

    const user = await authenticate(db, email, password);
    if (!user) {
      limiter.recordFailure(key);
      await audit(db, { action: "auth.login_failed", target: email.trim().toLowerCase() });
      // El mismo mensaje exista o no el usuario.
      throw new HttpError(401, "bad_credentials", "Correo o contraseña incorrectos.");
    }

    limiter.reset(key);
    const { token, csrfToken } = await createSession(db, user.id);
    await audit(db, { userId: user.id, action: "auth.login" });
    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: context.cookieSecure ?? false,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { user, csrfToken, plugins: (context.plugins ?? []).map((plugin) => plugin.id) };
  });

  app.post("/logout", async (request, reply) => {
    const session = requireSession(request);
    await deleteSession(db, session.tokenHash);
    await audit(db, { userId: session.user.id, action: "auth.logout" });
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/session", (request) => {
    const session = requireSession(request);
    return {
      user: session.user,
      csrfToken: session.csrfToken,
      plugins: (context.plugins ?? []).map((plugin) => plugin.id),
    };
  });
};
