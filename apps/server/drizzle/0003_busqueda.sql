-- Búsqueda de texto en español, sin distinguir acentos, sobre asunto, remitente y cuerpo.
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
-- Configuración propia: quita los acentos y después reduce cada palabra a su raíz.
-- Así «peritacion» encuentra «peritación» y el resaltado funciona sobre el texto original.
CREATE TEXT SEARCH CONFIGURATION es_sin_acentos (COPY = spanish);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION es_sin_acentos
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, spanish_stem;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search" tsvector;
--> statement-breakpoint
CREATE FUNCTION messages_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search :=
    setweight(to_tsvector('es_sin_acentos', coalesce(NEW.subject, '')), 'A') ||
    setweight(to_tsvector('es_sin_acentos',
      coalesce(NEW.from_name, '') || ' ' ||
      -- La dirección, troceada: «tramitacion@albor.example» se encuentra buscando «albor».
      translate(coalesce(NEW.from_address, ''), '@._-', '    ')), 'B') ||
    setweight(to_tsvector('es_sin_acentos', coalesce(NEW.body_text, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER messages_search_trigger
  BEFORE INSERT OR UPDATE OF subject, from_name, from_address, body_text ON "messages"
  FOR EACH ROW EXECUTE FUNCTION messages_search_update();
--> statement-breakpoint
UPDATE "messages" SET subject = subject;
--> statement-breakpoint
CREATE INDEX "messages_search" ON "messages" USING gin ("search");
