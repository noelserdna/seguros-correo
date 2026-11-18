import { eq } from "drizzle-orm";
import type { SecretBox } from "../crypto/secrets.ts";
import type { Db } from "../db/client.ts";
import { accounts, type AuthType } from "../db/schema.ts";
import type { Account } from "../imap/connection.ts";
import {
  OAuthError,
  refreshTokens,
  type OAuthSettings,
  type ProviderId,
  type TokenSet,
} from "../oauth/providers.ts";

/** Con qué se entra al servidor de correo: contraseña o permiso temporal. */
export type MailAuth = { user: string; pass: string } | { user: string; accessToken: string };

export type AuthDeps = { db: Db; secrets: SecretBox; oauth?: OAuthSettings };

const PROVIDER_OF: Partial<Record<AuthType, ProviderId>> = {
  oauth_google: "google",
  oauth_microsoft: "microsoft",
};

/** Se renueva con este margen, para que no caduque a mitad de un ciclo. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Credenciales vigentes de un buzón. En los buzones conectados con Google o Microsoft
 * renueva el permiso si está a punto de caducar y lo guarda, cifrado.
 */
export async function resolveAuth(deps: AuthDeps, account: Account): Promise<MailAuth> {
  const provider = PROVIDER_OF[account.authType];
  if (!provider) {
    return { user: account.username, pass: deps.secrets.decrypt(account.secretEncrypted) };
  }
  if (!deps.oauth?.clients[provider]) {
    throw new OAuthError("Este servidor no tiene configurado el acceso a ese proveedor.", true);
  }
  // Se lee de la base y no de la copia en memoria: otro ciclo puede haberlo renovado ya.
  const [row] = await deps.db
    .select({ secret: accounts.secretEncrypted })
    .from(accounts)
    .where(eq(accounts.id, account.id));
  let tokens = JSON.parse(deps.secrets.decrypt(row?.secret ?? account.secretEncrypted)) as TokenSet;
  if (tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    tokens = await refreshTokens(deps.oauth, provider, tokens);
    await deps.db
      .update(accounts)
      .set({ secretEncrypted: deps.secrets.encrypt(JSON.stringify(tokens)) })
      .where(eq(accounts.id, account.id));
  }
  return { user: account.username, accessToken: tokens.accessToken };
}
