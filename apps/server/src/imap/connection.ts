import { ImapFlow } from "imapflow";
import type { SecretBox } from "../crypto/secrets.ts";
import type { accounts } from "../db/schema.ts";

export type Account = typeof accounts.$inferSelect;

export type ImapSettings = Pick<
  Account,
  "imapHost" | "imapPort" | "imapSecure" | "tlsInsecure" | "username"
>;

type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

/** Crea (sin conectar) un cliente IMAP para un buzón, con contraseña o con permiso temporal. */
export function imapClient(settings: ImapSettings, secret: string | ImapAuth): ImapFlow {
  return new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapSecure,
    tls: { rejectUnauthorized: !settings.tlsInsecure },
    auth: typeof secret === "string" ? { user: settings.username, pass: secret } : secret,
    // Con QRESYNC el servidor identifica por uid los cambios que notifica.
    qresync: true,
    logger: false,
  });
}

export function imapClientFor(account: Account, secrets: SecretBox): ImapFlow {
  return imapClient(account, secrets.decrypt(account.secretEncrypted));
}

/** Error de credenciales: reintentar no sirve hasta que alguien las cambie. */
export function isAuthError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { authenticationFailed?: boolean }).authenticationFailed === true
  );
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const detail = (error as { responseText?: string }).responseText;
    if (detail) return detail;
  }
  return error instanceof Error ? error.message : String(error);
}
