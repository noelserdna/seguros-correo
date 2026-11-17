import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { createAccount, type NewAccount } from "../src/accounts/accounts.ts";
import { loadConfig } from "../src/config.ts";
import { SecretBox } from "../src/crypto/secrets.ts";
import { openDb, type Db } from "../src/db/client.ts";
import type { Account } from "../src/imap/connection.ts";
import { RawStore } from "../src/storage/raw-store.ts";
import { runSyncCycle, type CycleResult, type SyncDeps } from "../src/sync/cycle.ts";
import type { SyncOptions } from "../src/sync/types.ts";

export const config = loadConfig();
export const ANA = "ana@correo.test";
export const LUIS = "luis@correo.test";
const TEST_MASTER_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const DEFAULT_FOLDERS = new Set(["INBOX", "Sent", "Drafts", "Junk", "Trash"]);

export type TestEnv = SyncDeps & { db: Db; close: () => Promise<void> };

export async function openTestEnv(): Promise<TestEnv> {
  const { db, close } = openDb(config.TEST_DATABASE_URL);
  const dataDir = await mkdtemp(path.join(tmpdir(), "correo-test-"));
  return {
    db,
    secrets: new SecretBox(TEST_MASTER_KEY),
    rawStore: new RawStore(dataDir),
    close: async () => {
      await close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table accounts, users, threads, event_cursors cascade`);
}

export function accountInput(user: string, overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    name: user,
    email: user,
    imapHost: config.TEST_IMAP_HOST,
    imapPort: config.TEST_IMAP_PORT,
    smtpHost: config.TEST_SMTP_HOST,
    smtpPort: config.TEST_SMTP_PORT,
    smtpSecure: false,
    tlsInsecure: true,
    username: user,
    password: config.TEST_MAIL_PASSWORD,
    ...overrides,
  };
}

export const createTestAccount = (env: TestEnv, user = ANA): Promise<Account> =>
  createAccount(env.db, env.secrets, accountInput(user));

/** Repite ciclos hasta que no quede histórico ni cuerpos por bajar. */
export async function syncAll(
  env: TestEnv,
  account: Account,
  options: Partial<SyncOptions> = {},
): Promise<CycleResult[]> {
  const results: CycleResult[] = [];
  for (let round = 0; round < 50; round++) {
    const result = await runSyncCycle(env, account, options);
    results.push(result);
    if (!result.pending) return results;
  }
  throw new Error("La sincronización no termina.");
}

/** Otro cliente sobre el mismo buzón: hace el papel de Outlook. */
export async function otherClient(user = ANA): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: config.TEST_IMAP_HOST,
    port: config.TEST_IMAP_PORT,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user, pass: config.TEST_MAIL_PASSWORD },
    logger: false,
  });
  await client.connect();
  return client;
}

/** Ejecuta algo con una carpeta abierta en el «otro cliente». */
export async function inFolder<T>(
  client: ImapFlow,
  folder: string,
  run: () => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(folder);
  try {
    return await run();
  } finally {
    lock.release();
  }
}

/** Deja el buzón como recién creado: carpetas de serie vacías y nada más. */
export async function resetMailbox(user = ANA): Promise<void> {
  const client = await otherClient(user);
  try {
    for (const folder of await client.list()) {
      if (!DEFAULT_FOLDERS.has(folder.path)) {
        await client.mailboxDelete(folder.path);
        continue;
      }
      await inFolder(client, folder.path, async () => {
        if (client.mailbox && client.mailbox.exists > 0) await client.messageDelete("1:*");
      });
    }
  } finally {
    await client.logout();
  }
}

let counter = 0;

export async function buildRaw(options: Mail.Options = {}): Promise<Buffer> {
  counter++;
  return new MailComposer({
    from: LUIS,
    to: ANA,
    subject: `Correo de prueba ${counter}`,
    text: `Cuerpo del correo de prueba ${counter}.`,
    messageId: `<prueba-${Date.now()}-${counter}@correo.test>`,
    ...options,
  })
    .compile()
    .build();
}

/** Coloca un correo directamente en una carpeta. Devuelve su uid. */
export async function appendMail(
  client: ImapFlow,
  options: Mail.Options = {},
  folder = "INBOX",
  flags: string[] = [],
): Promise<number> {
  const result = await client.append(folder, await buildRaw(options), flags);
  if (!result || !result.uid) throw new Error("El servidor no devolvió el uid del correo.");
  return result.uid;
}

/** Envía un correo de verdad por SMTP (tarda un instante en llegar al buzón). */
export async function sendMail(from: string, options: Mail.Options): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.TEST_SMTP_HOST,
    port: config.TEST_SMTP_PORT,
    secure: false,
    requireTLS: true,
    tls: { rejectUnauthorized: false },
    auth: { user: from, pass: config.TEST_MAIL_PASSWORD },
  });
  try {
    await transport.sendMail({ from, ...options });
  } finally {
    transport.close();
  }
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("No se cumplió la condición a tiempo.");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
