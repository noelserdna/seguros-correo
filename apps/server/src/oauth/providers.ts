import { createHash, randomBytes } from "node:crypto";

export type ProviderId = "google" | "microsoft";

export type Provider = {
  id: ProviderId;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Parámetros propios de cada proveedor en la petición de permiso. */
  authParams: Record<string, string>;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** El servidor guarda por su cuenta la copia de lo enviado. */
  savesSent: boolean;
};

export const PROVIDERS: Record<ProviderId, Provider> = {
  google: {
    id: "google",
    label: "Google",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://mail.google.com/", "openid", "email"],
    // Sin esto Google no entrega el permiso duradero la segunda vez que se conecta.
    authParams: { access_type: "offline", prompt: "consent" },
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    savesSent: true,
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft 365",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
      "offline_access",
      "openid",
      "email",
    ],
    authParams: { prompt: "select_account" },
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
    savesSent: true,
  },
};

export type ClientCredentials = { clientId: string; clientSecret: string };

/** Qué proveedores están configurados y a dónde vuelve el navegador tras dar permiso. */
export type OAuthSettings = {
  redirectUri: string;
  clients: Partial<Record<ProviderId, ClientCredentials>>;
  /** Solo para pruebas: sustituye direcciones del proveedor. */
  overrides?: Partial<Record<ProviderId, Partial<Provider>>>;
};

export function providerFor(settings: OAuthSettings, id: ProviderId): Provider {
  return { ...PROVIDERS[id], ...settings.overrides?.[id] };
}

/** Permisos de un buzón tal como se guardan, cifrados. */
export type TokenSet = {
  accessToken: string;
  /** Milisegundos desde 1970. */
  expiresAt: number;
  refreshToken: string;
};

/** El proveedor ha rechazado la petición. `revoked`: hay que volver a dar permiso. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly revoked = false,
  ) {
    super(message);
  }
  /** Para la sincronización es un fallo de credenciales: reintentar no sirve. */
  get authenticationFailed(): boolean {
    return this.revoked;
  }
}

const base64url = (data: Buffer) => data.toString("base64url");

/** Par de valores PKCE: el servidor de permisos comprueba que quien canjea es quien pidió. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizationUrl(
  settings: OAuthSettings,
  id: ProviderId,
  state: string,
  challenge: string,
): string {
  const provider = providerFor(settings, id);
  const client = settings.clients[id];
  if (!client) throw new OAuthError(`${provider.label} no está configurado en este servidor.`);
  const url = new URL(provider.authUrl);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: settings.redirectUri,
    response_type: "code",
    scope: provider.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...provider.authParams,
  }).toString();
  return url.toString();
}

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(
  settings: OAuthSettings,
  id: ProviderId,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const provider = providerFor(settings, id);
  const client = settings.clients[id];
  if (!client) throw new OAuthError(`${provider.label} no está configurado en este servidor.`);
  let response: Response;
  try {
    response = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        ...params,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new OAuthError(`No se pudo hablar con ${provider.label}.`);
  }
  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || body.error || !body.access_token) {
    // «invalid_grant»: el permiso se retiró o caducó; solo se arregla volviendo a conectarlo.
    throw new OAuthError(
      `${provider.label} ha rechazado la petición: ${body.error_description ?? body.error ?? response.status}`,
      body.error === "invalid_grant",
    );
  }
  return body;
}

const expiry = (seconds: number | undefined) => Date.now() + (seconds ?? 3600) * 1000;

/** La dirección del buzón viene en el identificador que acompaña a los permisos. */
function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      preferred_username?: string;
    };
    return claims.email ?? claims.preferred_username ?? null;
  } catch {
    return null;
  }
}

/** Canjea el código que trae el navegador por los permisos del buzón. */
export async function exchangeCode(
  settings: OAuthSettings,
  id: ProviderId,
  code: string,
  verifier: string,
): Promise<{ tokens: TokenSet; email: string }> {
  const body = await tokenRequest(settings, id, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: settings.redirectUri,
  });
  const email = emailFromIdToken(body.id_token);
  if (!body.refresh_token || !email) {
    throw new OAuthError(
      "El proveedor no ha entregado un permiso duradero o no ha dicho de qué buzón se trata.",
    );
  }
  return {
    email,
    tokens: {
      accessToken: body.access_token!,
      expiresAt: expiry(body.expires_in),
      refreshToken: body.refresh_token,
    },
  };
}

/** Pide un permiso nuevo cuando el actual va a caducar. */
export async function refreshTokens(
  settings: OAuthSettings,
  id: ProviderId,
  current: TokenSet,
): Promise<TokenSet> {
  const body = await tokenRequest(settings, id, {
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  });
  return {
    accessToken: body.access_token!,
    expiresAt: expiry(body.expires_in),
    // Microsoft entrega uno nuevo cada vez; Google conserva el mismo.
    refreshToken: body.refresh_token ?? current.refreshToken,
  };
}
