import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;
/** Una conexión o una transacción abierta: lo que aceptan las funciones que escriben. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function openDb(connectionString: string): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
