CREATE TABLE "message_addresses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"role" text NOT NULL,
	"address" text NOT NULL,
	"domain" text NOT NULL,
	"name" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"detail" jsonb,
	"source" text,
	"evidence" text,
	"method" text NOT NULL,
	"extractor" text NOT NULL,
	"confidence" real,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bcc" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "auto_reply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_extra" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "enriched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_addresses" ADD CONSTRAINT "message_addresses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_addresses" ADD CONSTRAINT "message_addresses_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_facts" ADD CONSTRAINT "message_facts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_facts" ADD CONSTRAINT "message_facts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_addresses_message" ON "message_addresses" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_addresses_address" ON "message_addresses" USING btree ("account_id","address");--> statement-breakpoint
CREATE INDEX "message_addresses_domain" ON "message_addresses" USING btree ("account_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "message_facts_unique" ON "message_facts" USING btree ("message_id","kind","value","extractor");--> statement-breakpoint
CREATE INDEX "message_facts_lookup" ON "message_facts" USING btree ("account_id","kind","value");--> statement-breakpoint
-- La búsqueda de texto incluye también destinatarios y nombres de adjuntos.
CREATE OR REPLACE FUNCTION messages_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search :=
    setweight(to_tsvector('es_sin_acentos', coalesce(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('es_sin_acentos',
      coalesce(NEW.from_name, '') || ' ' ||
      translate(coalesce(NEW.from_address, ''), '@._-', '    ')), 'B') ||
    setweight(to_tsvector('es_sin_acentos',
      translate(coalesce(NEW.search_extra, ''), '@._-', '    ')), 'B') ||
    setweight(to_tsvector('es_sin_acentos', coalesce(NEW.body_text, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER messages_search_trigger ON "messages";
--> statement-breakpoint
CREATE TRIGGER messages_search_trigger
  BEFORE INSERT OR UPDATE OF subject, from_name, from_address, body_text, search_extra ON "messages"
  FOR EACH ROW EXECUTE FUNCTION messages_search_update();
