import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://correo:correo@127.0.0.1:54329/correo"),

  // Servidor de correo de pruebas (pnpm dev:up). Solo lo usan las pruebas de integración.
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
