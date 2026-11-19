import type { ComponentType, ReactNode } from "react";
import type { MessageDetail } from "../api.ts";
import type { IconName } from "../components/Icon.tsx";

/**
 * Lo que un plugin puede pintar en la interfaz. Cada propiedad corresponde a uno de
 * los huecos reservados en el diseño; todas son opcionales.
 */
export type WebPlugin = {
  id: string;
  /** Hueco 1: entrada en el riel de módulos. Al elegirla, `View` ocupa la columna de lista. */
  rail?: { icon: IconName; label: string };
  View?: ComponentType<{
    accountId: string | null;
    selectedId: string | null;
    onSelect: (messageId: string) => void;
  }>;
  /** Hueco 2: etiqueta en las filas de la lista. Recibe los correos visibles. */
  useLabels?: (messageIds: string[]) => Map<string, string[]>;
  /** Hueco 3: acción en el extremo derecho de la barra del correo abierto. */
  ToolbarAction?: ComponentType<{ message: MessageDetail; openContext: () => void }>;
  /**
   * Página a todo el ancho: al elegir la entrada del riel ocupa lista y lectura, sin el
   * panel de carpetas. Si un módulo tiene `Page`, no usa `View`.
   */
  Page?: ComponentType<{ isAdmin: boolean; userId: string }>;
  /** Apartados propios en el menú de Configuración. */
  settings?: SettingsPage[];
  /** Bloque dentro del apartado «Lectura de documentos» (p. ej. una cola de lectura). */
  DocumentsSection?: ComponentType<{ isAdmin: boolean }>;
  /**
   * Bloque dentro de un expediente abierto en el módulo Expedientes (p. ej. su plan de
   * tramitación). Solo lo usan módulos que dependen de Expedientes.
   */
  CaseSection?: ComponentType<{ caseId: string; wide?: boolean }>;
  /**
   * Una línea de estado por expediente para la lista de Expedientes (p. ej. salud y fase).
   * Se llama una vez por pantalla y devuelve lo de todos los expedientes que conoce.
   */
  useCaseLines?: () => Map<string, ReactNode>;
  /**
   * Filtros propios en la lista de correos, junto a «Sin leer» o «Con adjuntos». Dicen qué
   * correos de los cargados cumplen el filtro.
   */
  listFilters?: { id: string; label: string; useMatches: (messageIds: string[]) => Set<string> }[];
  /** Aviso en el redactor según los destinatarios (p. ej. «esto saldrá por WhatsApp»). */
  ComposeNotice?: ComponentType<{ recipients: string[] }>;
  /** Hueco 4: sección en el panel de contexto. */
  ContextSection?: ComponentType<{ message: MessageDetail; onSelect: (messageId: string) => void }>;
};

/** Grupos del menú de Configuración, en este orden. */
export const SETTINGS_GROUPS = ["Correo", "Expedientes", "Tramitación", "Instalación"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** Un apartado de Configuración: una entrada del menú y su página. */
export type SettingsPage = {
  id: string;
  group: SettingsGroup;
  label: string;
  description: string;
  /** Solo lo cambia un administrador; los demás lo consultan y ven un candado. */
  adminOnly?: boolean;
  /** Ocupa todo el ancho; si no, el contenido se queda en 800 px. */
  wide?: boolean;
  Component: ComponentType<{ isAdmin: boolean }>;
};
