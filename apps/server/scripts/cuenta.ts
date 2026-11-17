/**
 * Gestión de buzones desde la consola (hasta que exista la interfaz).
 *
 *   pnpm cuenta alta      Da de alta el buzón descrito en .env.reflejo (o el de Docker)
 *   pnpm cuenta sync      Sincroniza todos los buzones hasta ponerlos al día
 *   pnpm cuenta estado    Resumen de buzones, carpetas y correos
 */
import { count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AccountConnectionError, createAccount } from "../src/accounts/accounts.ts";
import { accounts, events, folderMessages, folders, messages } from "../src/db/schema.ts";
import { openRuntime, type Runtime } from "../src/runtime.ts";
import { runSyncCycle } from "../src/sync/cycle.ts";

try {
  process.loadEnvFile(".env.reflejo");
} catch {
  // Sin .env.reflejo se usa el buzón de pruebas de Docker.
}

const mailbox = z
  .object({
    REFLEJO_IMAP_HOST: z.string().default("127.0.0.1"),
    REFLEJO_IMAP_PORT: z.coerce.number().default(1993),
    REFLEJO_SMTP_HOST: z.string().default("127.0.0.1"),
    REFLEJO_SMTP_PORT: z.coerce.number().default(1587),
    REFLEJO_USER: z.string().default("ana@correo.test"),
    REFLEJO_PASS: z.string().default("prueba-1234"),
  })
  .parse(process.env);

async function alta(runtime: Runtime): Promise<void> {
  const isDocker = !process.env.REFLEJO_IMAP_HOST;
  const account = await createAccount(runtime.db, runtime.secrets, {
    name: mailbox.REFLEJO_USER,
    email: mailbox.REFLEJO_USER,
    imapHost: mailbox.REFLEJO_IMAP_HOST,
    imapPort: mailbox.REFLEJO_IMAP_PORT,
    smtpHost: mailbox.REFLEJO_SMTP_HOST,
    smtpPort: mailbox.REFLEJO_SMTP_PORT,
    tlsInsecure: isDocker,
    username: mailbox.REFLEJO_USER,
    password: mailbox.REFLEJO_PASS,
  });
  console.log(`Buzón ${account.email} dado de alta (${account.capabilities.length} capacidades).`);
}

async function sync(runtime: Runtime): Promise<void> {
  for (const account of await runtime.db.select().from(accounts)) {
    const started = Date.now();
    const total = { created: 0, attached: 0, flagsChanged: 0, gone: 0, bodies: 0, removed: 0 };
    let cycles = 0;
    for (;;) {
      const result = await runSyncCycle(runtime, account);
      cycles++;
      for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += result[key];
      if (!result.pending) break;
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${account.email}: ${cycles} ciclo(s) en ${seconds} s`, total);
  }
}

async function estado(runtime: Runtime): Promise<void> {
  const { db } = runtime;
  for (const account of await db.select().from(accounts)) {
    console.log(
      `\n${account.email}  estado: ${account.state}` +
        (account.lastError ? `  (${account.lastError})` : "") +
        `  última sincronización: ${account.lastSyncAt?.toLocaleString("es-ES") ?? "nunca"}`,
    );
    const rows = await db
      .select({
        path: folders.path,
        specialUse: folders.specialUse,
        backfillBelow: folders.backfillBelow,
        live: sql<number>`count(${folderMessages.id}) filter (where ${folderMessages.goneAt} is null)::int`,
        gone: sql<number>`count(${folderMessages.id}) filter (where ${folderMessages.goneAt} is not null)::int`,
      })
      .from(folders)
      .leftJoin(folderMessages, eq(folderMessages.folderId, folders.id))
      .where(eq(folders.accountId, account.id))
      .groupBy(folders.id)
      .orderBy(folders.path);
    for (const row of rows) {
      console.log(
        `  ${row.path.padEnd(28)} ${(row.specialUse ?? "-").padEnd(8)} correos: ${String(row.live).padStart(5)}` +
          (row.gone ? `  (ya no están: ${row.gone})` : "") +
          ((row.backfillBelow ?? 1) > 1 ? "  histórico pendiente" : ""),
      );
    }
    const one = async (where: ReturnType<typeof eq> | undefined) =>
      (await db.select({ n: count() }).from(messages).where(where))[0]?.n ?? 0;
    console.log(
      `  Correos distintos: ${await one(eq(messages.accountId, account.id))}` +
        `  con cuerpo descargado: ${await one(isNotNull(messages.rawSha256))}` +
        `  sin descargar: ${await one(isNull(messages.rawSha256))}`,
    );
    const eventCounts = await db
      .select({ type: events.type, n: count() })
      .from(events)
      .where(eq(events.accountId, account.id))
      .groupBy(events.type);
    console.log(
      `  Eventos: ${eventCounts.map((row) => `${row.type}=${row.n}`).join("  ") || "ninguno"}`,
    );
  }
}

const commands: Record<string, (runtime: Runtime) => Promise<void>> = { alta, sync, estado };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.log("Uso: pnpm cuenta <alta|sync|estado>");
  process.exit(1);
}

const runtime = await openRuntime();
try {
  await command(runtime);
} catch (error) {
  console.error(
    `Error: ${error instanceof AccountConnectionError || error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await runtime.close();
}
