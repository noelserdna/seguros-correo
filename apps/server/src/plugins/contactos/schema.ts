/**
 * Tablas de la agenda. Pensadas para crecer sin rehacer: los identificadores externos sirven
 * para importar (vCard, CSV, Outlook, un programa de gestión) sin duplicar, y los vínculos
 * genéricos atan un contacto a un expediente hoy y a una póliza mañana.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";

export async function setupContactos(db: Db): Promise<void> {
  await db.execute(sql`
    create table if not exists ct_contacts (
      id uuid primary key default gen_random_uuid(),
      kind text not null default 'persona',
      name text not null,
      company_id uuid references ct_contacts(id) on delete set null,
      notes text,
      archived boolean not null default false,
      created_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`);
  await db.execute(sql`create index if not exists ct_contacts_name on ct_contacts (lower(name))`);
  // Cada correo o teléfono, de una sola ficha, con de dónde salió.
  await db.execute(sql`
    create table if not exists ct_channels (
      id uuid primary key default gen_random_uuid(),
      contact_id uuid not null references ct_contacts(id) on delete cascade,
      kind text not null,
      value text not null,
      label text,
      source text not null default 'manual',
      source_message_id uuid,
      created_by uuid,
      created_at timestamptz not null default now()
    )`);
  await db.execute(
    sql`create unique index if not exists ct_channels_value on ct_channels (kind, value)`,
  );
  await db.execute(sql`create index if not exists ct_channels_contact on ct_channels (contact_id)`);
  await db.execute(sql`
    create table if not exists ct_roles (
      contact_id uuid not null references ct_contacts(id) on delete cascade,
      role text not null,
      primary key (contact_id, role)
    )`);
  // Preparado para importar: de qué agenda externa viene cada ficha.
  await db.execute(sql`
    create table if not exists ct_external (
      contact_id uuid not null references ct_contacts(id) on delete cascade,
      source text not null,
      external_id text not null,
      primary key (source, external_id)
    )`);
  // Vínculos con otras cosas: un expediente (cliente) hoy, una póliza más adelante.
  await db.execute(sql`
    create table if not exists ct_links (
      contact_id uuid not null references ct_contacts(id) on delete cascade,
      target_kind text not null,
      target_id uuid not null,
      role text not null,
      created_by uuid,
      created_at timestamptz not null default now(),
      primary key (target_kind, target_id, role, contact_id)
    )`);
  // Sugerencias que alguien descartó: no vuelven a salir.
  await db.execute(sql`
    create table if not exists ct_dismissed (
      kind text not null,
      key text not null,
      dismissed_by uuid,
      dismissed_at timestamptz not null default now(),
      primary key (kind, key)
    )`);
}
