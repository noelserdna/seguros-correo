import nodemailer from "nodemailer";
import type { SecretBox } from "../crypto/secrets.ts";
import type { Db } from "../db/client.ts";
import { accounts, auditLog } from "../db/schema.ts";
import { errorMessage, imapClient, isAuthError, type Account } from "../imap/connection.ts";

export type NewAccount = {
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure?: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure?: boolean;
  tlsInsecure?: boolean;
  username: string;
  password: string;
};

export class AccountConnectionError extends Error {
  constructor(
    readonly kind: "auth" | "imap" | "smtp",
    detail: string,
  ) {
    const what = {
      auth: "El usuario o la contraseña no son correctos",
      imap: "No se pudo conectar con el servidor de entrada",
      smtp: "No se pudo conectar con el servidor de salida",
    }[kind];
    super(`${what}: ${detail}`);
  }
}

/** Comprueba que se puede entrar por IMAP y por SMTP. Devuelve las capacidades del servidor. */
export async function testConnection(input: NewAccount): Promise<string[]> {
  const settings = {
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure ?? true,
    tlsInsecure: input.tlsInsecure ?? false,
    username: input.username,
  };
  const client = imapClient(settings, input.password);
  let capabilities: string[];
  try {
    await client.connect();
    capabilities = [...client.capabilities.keys()].sort();
  } catch (error) {
    throw new AccountConnectionError(isAuthError(error) ? "auth" : "imap", errorMessage(error));
  } finally {
    await client.logout().catch(() => undefined);
  }

  const smtpSecure = input.smtpSecure ?? input.smtpPort === 465;
  const transport = nodemailer.createTransport({
    host: input.smtpHost,
    port: input.smtpPort,
    secure: smtpSecure,
    requireTLS: !smtpSecure,
    tls: { rejectUnauthorized: !settings.tlsInsecure },
    auth: { user: input.username, pass: input.password },
  });
  try {
    await transport.verify();
  } catch (error) {
    throw new AccountConnectionError("smtp", errorMessage(error));
  } finally {
    transport.close();
  }

  return capabilities;
}

/** Da de alta un buzón tras comprobar la conexión. La contraseña se guarda cifrada. */
export async function createAccount(
  db: Db,
  secrets: SecretBox,
  input: NewAccount,
): Promise<Account> {
  const capabilities = await testConnection(input);
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({
        name: input.name,
        email: input.email,
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        imapSecure: input.imapSecure ?? true,
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpSecure: input.smtpSecure ?? input.smtpPort === 465,
        tlsInsecure: input.tlsInsecure ?? false,
        username: input.username,
        secretEncrypted: secrets.encrypt(input.password),
        capabilities,
      })
      .returning();
    if (!account) throw new Error("No se pudo crear el buzón.");
    await tx.insert(auditLog).values({
      accountId: account.id,
      action: "account.created",
      target: account.email,
    });
    return account;
  });
}
