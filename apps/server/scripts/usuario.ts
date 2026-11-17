/**
 * Gestión de usuarios desde la consola (para crear el primer administrador).
 *
 *   pnpm usuario crear <correo> <nombre> [--admin]    Pide la contraseña por teclado
 *   pnpm usuario acceso <correo-usuario> <correo-buzón>
 *   pnpm usuario lista
 *
 * La contraseña también puede venir en la variable USUARIO_PASS.
 */
import { createInterface } from "node:readline";
import { eq } from "drizzle-orm";
import { createUser, UserError } from "../src/auth/users.ts";
import { accountAccess, accounts, auditLog, users } from "../src/db/schema.ts";
import { openRuntime, type Runtime } from "../src/runtime.ts";

/** Pide un texto sin mostrarlo en pantalla. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(question);
    const output = terminal as unknown as { _writeToOutput: (text: string) => void };
    output._writeToOutput = () => undefined;
    terminal.question("", (answer) => {
      terminal.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function crear({ db }: Runtime, args: string[]): Promise<void> {
  const admin = args.includes("--admin");
  const [email, ...nameParts] = args.filter((arg) => arg !== "--admin");
  const name = nameParts.join(" ");
  if (!email || !name) throw new UserError("Uso: pnpm usuario crear <correo> <nombre> [--admin]");
  const password = process.env.USUARIO_PASS ?? (await askHidden("Contraseña: "));
  const user = await createUser(db, { email, name, password, role: admin ? "admin" : "user" });
  await db.insert(auditLog).values({ action: "user.created", target: user.email });
  console.log(`Usuario ${user.email} creado${admin ? " como administrador" : ""}.`);
}

async function acceso({ db }: Runtime, [userEmail, accountEmail]: string[]): Promise<void> {
  if (!userEmail || !accountEmail) {
    throw new UserError("Uso: pnpm usuario acceso <correo-usuario> <correo-buzón>");
  }
  const [user] = await db.select().from(users).where(eq(users.email, userEmail.toLowerCase()));
  const [account] = await db.select().from(accounts).where(eq(accounts.email, accountEmail));
  if (!user) throw new UserError(`No existe el usuario ${userEmail}.`);
  if (!account) throw new UserError(`No existe el buzón ${accountEmail}.`);
  await db
    .insert(accountAccess)
    .values({ userId: user.id, accountId: account.id })
    .onConflictDoNothing();
  await db.insert(auditLog).values({
    accountId: account.id,
    action: "account.access_granted",
    target: user.id,
  });
  console.log(`${user.email} ya puede ver el buzón ${account.email}.`);
}

async function lista({ db }: Runtime): Promise<void> {
  const rows = await db.select().from(users).orderBy(users.email);
  const access = await db
    .select({ userId: accountAccess.userId, email: accounts.email })
    .from(accountAccess)
    .innerJoin(accounts, eq(accounts.id, accountAccess.accountId));
  for (const user of rows) {
    const mailboxes = access.filter((row) => row.userId === user.id).map((row) => row.email);
    console.log(
      `${user.email.padEnd(32)} ${user.role.padEnd(6)} buzones: ${mailboxes.join(", ") || "ninguno"}`,
    );
  }
  if (rows.length === 0) console.log("No hay usuarios.");
}

const commands: Record<string, (runtime: Runtime, args: string[]) => Promise<void>> = {
  crear,
  acceso,
  lista,
};
const [name = "", ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.log("Uso: pnpm usuario <crear|acceso|lista>");
  process.exit(1);
}

const runtime = await openRuntime();
try {
  await command(runtime, args);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await runtime.close();
}
