CREATE TABLE "account_access" (
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_access_user_id_account_id_pk" PRIMARY KEY("user_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_secure" boolean DEFAULT true NOT NULL,
	"tls_insecure" boolean DEFAULT false NOT NULL,
	"auth_type" text DEFAULT 'password' NOT NULL,
	"username" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"max_connections" integer DEFAULT 2 NOT NULL,
	"server_saves_sent" boolean,
	"state" text DEFAULT 'new' NOT NULL,
	"last_error" text,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"filename" text,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"content_id" text,
	"inline" boolean DEFAULT false NOT NULL,
	"content_sha256" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"account_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_cursors" (
	"consumer" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"uid_validity" bigint NOT NULL,
	"uid" bigint NOT NULL,
	"message_id" uuid NOT NULL,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"modseq" bigint,
	"email_id" text,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"path" text NOT NULL,
	"delimiter" text DEFAULT '/' NOT NULL,
	"special_use" text,
	"subscribed" boolean DEFAULT true NOT NULL,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"uid_validity" bigint,
	"uid_next_synced" bigint,
	"backfill_below" bigint,
	"highest_modseq" bigint,
	"exists_count" integer,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"message_id_header" text,
	"thread_id" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"from_address" text DEFAULT '' NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"date" timestamp with time zone,
	"internal_date" timestamp with time zone NOT NULL,
	"size" integer NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"raw_sha256" text,
	"body_text" text,
	"snippet" text,
	"has_attachments" boolean,
	"deleted_on_server_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "account_access" ADD CONSTRAINT "account_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_access" ADD CONSTRAINT "account_access_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_messages" ADD CONSTRAINT "folder_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_messages" ADD CONSTRAINT "folder_messages_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_messages" ADD CONSTRAINT "folder_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_message" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "events_account" ON "events" USING btree ("account_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "folder_messages_position" ON "folder_messages" USING btree ("folder_id","uid_validity","uid");--> statement-breakpoint
CREATE INDEX "folder_messages_message" ON "folder_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "folder_messages_live" ON "folder_messages" USING btree ("folder_id","uid") WHERE gone_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_account_path" ON "folders" USING btree ("account_id","path");--> statement-breakpoint
CREATE INDEX "messages_account_fingerprint" ON "messages" USING btree ("account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "messages_account_message_id" ON "messages" USING btree ("account_id","message_id_header");--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_account_date" ON "messages" USING btree ("account_id","internal_date");