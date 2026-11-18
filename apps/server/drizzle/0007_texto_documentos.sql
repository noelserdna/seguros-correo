CREATE TABLE "document_pages" (
	"content_sha256" text NOT NULL,
	"page" integer NOT NULL,
	"label" text,
	"text" text NOT NULL,
	"method" text NOT NULL,
	"confidence" real,
	"chars" integer NOT NULL,
	CONSTRAINT "document_pages_content_sha256_page_pk" PRIMARY KEY("content_sha256","page")
);
--> statement-breakpoint
CREATE TABLE "document_texts" (
	"content_sha256" text PRIMARY KEY NOT NULL,
	"filename" text,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"pages" integer DEFAULT 0 NOT NULL,
	"chars" integer DEFAULT 0 NOT NULL,
	"pages_needing_ocr" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extracted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "body_clean" text;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_content_sha256_document_texts_content_sha256_fk" FOREIGN KEY ("content_sha256") REFERENCES "public"."document_texts"("content_sha256") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Búsqueda dentro del texto de los adjuntos, con la misma configuración que los correos.
ALTER TABLE "document_pages" ADD COLUMN "search" tsvector;
--> statement-breakpoint
CREATE FUNCTION document_pages_search_update() RETURNS trigger AS $$
BEGIN
  -- Un tsvector no admite más de 1 MB: las páginas enormes se indexan truncadas.
  NEW.search := to_tsvector('es_sin_acentos', left(NEW.text, 200000));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER document_pages_search_trigger
  BEFORE INSERT OR UPDATE OF text ON "document_pages"
  FOR EACH ROW EXECUTE FUNCTION document_pages_search_update();
--> statement-breakpoint
CREATE INDEX "document_pages_search" ON "document_pages" USING gin ("search");
--> statement-breakpoint
CREATE INDEX "attachments_content" ON "attachments" ("content_sha256");
