import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AccountConnectionError, connectOAuthAccount } from "../../accounts/accounts.ts";
import {
  authorizationUrl,
  exchangeCode,
  newPkce,
  OAuthError,
  PROVIDERS,
  providerFor,
  type ProviderId,
} from "../../oauth/providers.ts";
import { HttpError, requireAdmin, type RouteOptions } from "../app.ts";

const STATE_TTL_MS = 10 * 60_000;
const providerParams = z.object({ provider: z.enum(["google", "microsoft"]) });
const callbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(4000).optional(),
  error: z.string().max(200).optional(),
});

type Pending = { provider: ProviderId; userId: string; verifier: string; expiresAt: number };

/**
 * Conexión de buzones con cuenta de Google o de Microsoft 365. El administrador pide
 * el permiso en la página del proveedor y vuelve aquí con un código de un solo uso;
 * la contraseña del buzón nunca pasa por este servidor.
 */
export const oauthRoutes: FastifyPluginAsync<RouteOptions> = async (app, { context }) => {
  const { db, secrets, oauth } = context;
  // Peticiones de permiso en curso. Viven poco y solo en memoria: si el servidor se
  // reinicia a medias, basta con volver a pulsar «Conectar».
  const pending = new Map<string, Pending>();

  app.get("/admin/oauth/providers", async (request) => {
    requireAdmin(request);
    return {
      providers: (Object.keys(PROVIDERS) as ProviderId[])
        .filter((id) => oauth?.clients[id])
        .map((id) => ({ id, label: PROVIDERS[id].label })),
    };
  });

  app.post("/admin/oauth/:provider/start", async (request) => {
    const { user } = requireAdmin(request);
    const { provider } = providerParams.parse(request.params);
    if (!oauth?.clients[provider]) {
      throw new HttpError(409, "not_configured", "Ese proveedor no está configurado.");
    }
    for (const [key, entry] of pending) if (entry.expiresAt < Date.now()) pending.delete(key);
    const state = randomBytes(24).toString("base64url");
    const pkce = newPkce();
    pending.set(state, {
      provider,
      userId: user.id,
      verifier: pkce.verifier,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    return { url: authorizationUrl(oauth, provider, state, pkce.challenge) };
  });

  // El navegador vuelve aquí desde la página del proveedor. Llega sin sesión: la cookie
  // es estricta y no viaja en una navegación que empieza en otro sitio. Por eso aquí solo
  // se devuelve a nuestra página, y es ella la que completa la conexión, ya con sesión.
  app.get("/oauth/callback", async (request, reply) => {
    const query = callbackQuery.parse(request.query);
    const params = new URLSearchParams();
    if (query.state) params.set("oauth_state", query.state);
    if (query.code) params.set("oauth_code", query.code);
    if (query.error) params.set("oauth_error", query.error);
    return reply.redirect(`/?${params.toString()}`);
  });

  app.post("/admin/oauth/complete", async (request) => {
    const { user } = requireAdmin(request);
    const body = callbackQuery.parse(request.body);
    const entry = body.state ? pending.get(body.state) : undefined;
    if (body.state) pending.delete(body.state);
    const refuse = (message: string) => new HttpError(409, "oauth_failed", message);

    // El «state» ata la vuelta a quien la empezó: sin él, otra página podría colar un buzón ajeno.
    if (!entry || entry.expiresAt < Date.now() || entry.userId !== user.id || !oauth) {
      throw refuse("La petición ha caducado. Vuelve a pulsar «Conectar».");
    }
    if (body.error || !body.code) {
      throw refuse(
        body.error === "access_denied"
          ? "No se ha dado el permiso, así que el buzón no se ha conectado."
          : "El proveedor no ha completado la conexión.",
      );
    }
    try {
      const { tokens, email } = await exchangeCode(
        oauth,
        entry.provider,
        body.code,
        entry.verifier,
      );
      const { account } = await connectOAuthAccount(
        db,
        secrets,
        { provider: providerFor(oauth, entry.provider), email, tokens, userId: user.id },
        context.verifyOAuthConnection,
      );
      context.onAccountCreated?.(account);
      return { email: account.email };
    } catch (error) {
      if (error instanceof OAuthError || error instanceof AccountConnectionError) {
        throw refuse(error.message);
      }
      throw error;
    }
  });
};
