import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://correo:correo@127.0.0.1:54329/correo"),
  /** Clave maestra para cifrar credenciales: 64 caracteres hexadecimales. Sin valor por defecto. */
  MASTER_KEY: z.string().optional(),
  /** Directorio de datos (correos originales). */
  DATA_DIR: z.string().default("datos"),
  /** Dónde escucha la API. Por defecto solo en este equipo. */
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().default(3000),
  /** Cookie de sesión solo por HTTPS. Activar en cuanto se sirva con HTTPS. */
  COOKIE_SECURE: z
    .enum(["0", "1", "true", "false"])
    .default("0")
    .transform((value) => value === "1" || value === "true"),

  // Servidor de correo de pruebas (pnpm dev:up). Solo lo usan las pruebas de integración.
  TEST_DATABASE_URL: z.string().default("postgres://correo:correo@127.0.0.1:54329/correo_test"),
  TEST_IMAP_HOST: z.string().default("127.0.0.1"),
  TEST_IMAP_PORT: z.coerce.number().default(1993),
  TEST_SMTP_HOST: z.string().default("127.0.0.1"),
  TEST_SMTP_PORT: z.coerce.number().default(1587),
  TEST_MAIL_PASSWORD: z.string().default("prueba-1234"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

export function requireMasterKey(config: Config): string {
  if (!config.MASTER_KEY) {
    throw new Error(
      "Falta MASTER_KEY. Genera una con `openssl rand -hex 32` y ponla en el fichero .env.",
    );
  }
  return config.MASTER_KEY;
}
