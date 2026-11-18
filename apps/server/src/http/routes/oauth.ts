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
import { HttpError, requireAdmin, requireSession, type RouteOptions } from "../app.ts";

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

  // El navegador vuelve aquí desde la página del proveedor.
  app.get("/oauth/callback", async (request, reply) => {
    const back = (params: Record<string, string>) =>
      reply.redirect(`/?${new URLSearchParams(params).toString()}`);
    const { user } = requireSession(request);
    const query = callbackQuery.parse(request.query);
    const entry = query.state ? pending.get(query.state) : undefined;
    if (query.state) pending.delete(query.state);

    // El «state» ata la vuelta a quien la empezó: sin él, otra página podría colar un buzón ajeno.
    if (!entry || entry.expiresAt < Date.now() || entry.userId !== user.id || !oauth) {
      return back({ buzon_error: "La petición ha caducado. Vuelve a pulsar «Conectar»." });
    }
    if (query.error || !query.code) {
      return back({
        buzon_error:
          query.error === "access_denied"
            ? "No se ha dado el permiso, así que el buzón no se ha conectado."
            : "El proveedor no ha completado la conexión.",
      });
    }
    try {
      const { tokens, email } = await exchangeCode(
        oauth,
        entry.provider,
        query.code,
        entry.verifier,
      );
      const { account } = await connectOAuthAccount(
        db,
        secrets,
        { provider: providerFor(oauth, entry.provider), email, tokens, userId: user.id },
        context.verifyOAuthConnection,
      );
      context.onAccountCreated?.(account);
      return back({ buzon_conectado: account.email });
    } catch (error) {
      if (error instanceof OAuthError || error instanceof AccountConnectionError) {
        return back({ buzon_error: error.message });
      }
      throw error;
    }
  });
};
