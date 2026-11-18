CREATE TABLE "document_notes" (
	"content_sha256" text NOT NULL,
	"source" text NOT NULL,
	"text" text NOT NULL,
	"user_id" uuid,
	"extractor" text,
	"confidence" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_notes_content_sha256_source_pk" PRIMARY KEY("content_sha256","source")
);
--> statement-breakpoint
ALTER TABLE "document_notes" ADD CONSTRAINT "document_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Las notas también se buscan, con la misma configuración que los correos.
ALTER TABLE "document_notes" ADD COLUMN "search" tsvector;
--> statement-breakpoint
CREATE FUNCTION document_notes_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search := to_tsvector('es_sin_acentos', left(NEW.text, 200000));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER document_notes_search_trigger
  BEFORE INSERT OR UPDATE OF text ON "document_notes"
  FOR EACH ROW EXECUTE FUNCTION document_notes_search_update();
--> statement-breakpoint
CREATE INDEX "document_notes_search" ON "document_notes" USING gin ("search");
