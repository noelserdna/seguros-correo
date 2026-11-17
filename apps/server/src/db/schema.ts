import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();

export type Address = { name: string; address: string };

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<"admin" | "user">().notNull().default("user"),
  createdAt: createdAt(),
});

/** Sesiones de la interfaz web. Se guarda la huella del identificador, no el identificador. */
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("sessions_user").on(table.userId)],
);

export type AuthType = "password" | "oauth_microsoft" | "oauth_google";
export type AccountState = "new" | "ok" | "auth_error" | "offline";

/** Un buzón de correo. */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull(),
  imapSecure: boolean("imap_secure").notNull().default(true),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  smtpSecure: boolean("smtp_secure").notNull().default(true),
  /** Aceptar certificados autofirmados. Solo para servidores de pruebas. */
  tlsInsecure: boolean("tls_insecure").notNull().default(false),
  authType: text("auth_type").$type<AuthType>().notNull().default("password"),
  username: text("username").notNull(),
  /** Contraseña o tokens, cifrados con la clave maestra (AES-256-GCM). */
  secretEncrypted: text("secret_encrypted").notNull(),
  capabilities: text("capabilities")
    .array()
    .notNull()
    .default(sql`'{}'`),
  maxConnections: integer("max_connections").notNull().default(2),
  /** Si el servidor guarda solo la copia en Enviados. Se detecta al enviar. */
  serverSavesSent: boolean("server_saves_sent"),
  state: text("state").$type<AccountState>().notNull().default("new"),
  lastError: text("last_error"),
  lastSyncAt: timestamptz("last_sync_at"),
  createdAt: createdAt(),
});

/** Qué usuario ve qué buzón (permite buzones compartidos). */
export const accountAccess = pgTable(
  "account_access",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.accountId] })],
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    delimiter: text("delimiter").notNull().default("/"),
    specialUse: text("special_use"),
    subscribed: boolean("subscribed").notNull().default(true),
    /** Falso en carpetas contenedoras y en las virtuales de Gmail. */
    syncEnabled: boolean("sync_enabled").notNull().default(true),
    uidValidity: bigint("uid_validity", { mode: "number" }),
    /** Siguiente uid por descubrir: todo uid >= este es correo nuevo. */
    uidNextSynced: bigint("uid_next_synced", { mode: "number" }),
    /** Uid más bajo ya cargado; el histórico por debajo sigue pendiente. 1 = completo. */
    backfillBelow: bigint("backfill_below", { mode: "number" }),
    highestModseq: bigint("highest_modseq", { mode: "bigint" }),
    existsCount: integer("exists_count"),
    /** La carpeta ya no existe en el servidor. */
    goneAt: timestamptz("gone_at"),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("folders_account_path").on(table.accountId, table.path)],
);

export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

/**
 * El correo como contenido, siempre dentro de un buzón. Su `id` es el ancla estable
 * que usan los plugins: no cambia aunque el correo se mueva de carpeta.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /**
     * Huella para reconocer el mismo correo en otra carpeta (movido o copiado):
     * Message-ID + fecha de llegada al servidor + tamaño + asunto + remitente.
     * El Message-ID solo no vale: no es único.
     */
    fingerprint: text("fingerprint").notNull(),
    /** Solo para agrupar hilos. No es único. */
    messageIdHeader: text("message_id_header"),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id),
    subject: text("subject").notNull().default(""),
    fromName: text("from_name").notNull().default(""),
    fromAddress: text("from_address").notNull().default(""),
    to: jsonb("to").$type<Address[]>().notNull().default([]),
    cc: jsonb("cc").$type<Address[]>().notNull().default([]),
    date: timestamptz("date"),
    internalDate: timestamptz("internal_date").notNull(),
    size: integer("size").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Huella del original; se rellena al descargar el cuerpo. Localiza el .eml en disco. */
    rawSha256: text("raw_sha256"),
    bodyText: text("body_text"),
    snippet: text("snippet"),
    hasAttachments: boolean("has_attachments"),
    /**
     * Ya no está en el buzón del servidor (lo borraron o lo vaciaron para liberar espacio).
     * No implica borrarlo aquí: nuestro archivo se conserva según su propia política.
     */
    removedFromServerAt: timestamptz("removed_from_server_at"),
    purgeAfter: timestamptz("purge_after"),
    legalHold: boolean("legal_hold").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    index("messages_account_fingerprint").on(table.accountId, table.fingerprint),
    index("messages_account_message_id").on(table.accountId, table.messageIdHeader),
    index("messages_thread").on(table.threadId),
    index("messages_account_date").on(table.accountId, table.internalDate),
  ],
);

/**
 * La presencia física de un correo en una carpeta del servidor. Es la entidad
 * principal de la sincronización: (carpeta, uidvalidity, uid) no cambia nunca.
 */
export const folderMessages = pgTable(
  "folder_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    uidValidity: bigint("uid_validity", { mode: "number" }).notNull(),
    uid: bigint("uid", { mode: "number" }).notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** Todas las marcas, incluidas las palabras clave propias de cada cliente. */
    flags: text("flags")
      .array()
      .notNull()
      .default(sql`'{}'`),
    modseq: bigint("modseq", { mode: "bigint" }),
    emailId: text("email_id"),
    /** Ya no está en la carpeta. Se conserva para no perder el vínculo si reaparece en otra. */
    goneAt: timestamptz("gone_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("folder_messages_position").on(table.folderId, table.uidValidity, table.uid),
    index("folder_messages_message").on(table.messageId),
    index("folder_messages_live")
      .on(table.folderId, table.uid)
      .where(sql`gone_at is null`),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    filename: text("filename"),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    contentId: text("content_id"),
    inline: boolean("inline").notNull().default(false),
    contentSha256: text("content_sha256").notNull(),
  },
  (table) => [index("attachments_message").on(table.messageId)],
);

export type EventType =
  "message.received" | "message.moved" | "message.flagsChanged" | "message.removed";

/** Eventos para plugins, escritos en la misma transacción que el cambio que describen. */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    type: text("type").$type<EventType>().notNull(),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [index("events_account").on(table.accountId, table.id)],
);

/** Hasta dónde ha leído cada consumidor de eventos. */
export const eventCursors = pgTable("event_cursors", {
  consumer: text("consumer").primaryKey(),
  lastEventId: bigint("last_event_id", { mode: "number" }).notNull().default(0),
});

/** Registro de auditoría. Solo inserción (lo impide un disparador en la base). */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id"),
  accountId: uuid("account_id"),
  action: text("action").notNull(),
  target: text("target"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});
