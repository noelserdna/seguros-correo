import pg from "pg";
import { loadConfig } from "../src/config.ts";
import { openDb, runMigrations } from "../src/db/client.ts";

/** Crea (si falta) la base de datos de pruebas y la deja con el esquema al día. */
export default async function setup(): Promise<void> {
  const config = loadConfig();
  const name = new URL(config.TEST_DATABASE_URL).pathname.slice(1);

  const admin = new pg.Client({ connectionString: config.DATABASE_URL });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount === 0) await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const { db, close } = openDb(config.TEST_DATABASE_URL);
  try {
    await runMigrations(db);
  } finally {
    await close();
  }
}
