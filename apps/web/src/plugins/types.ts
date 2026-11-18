import type { ComponentType } from "react";
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
  useLabels?: (messageIds: string[]) => Map<string, string>;
  /** Hueco 3: acción en el extremo derecho de la barra del correo abierto. */
  ToolbarAction?: ComponentType<{ message: MessageDetail; openContext: () => void }>;
  /** Hueco 4: sección en el panel de contexto. */
  ContextSection?: ComponentType<{ message: MessageDetail; onSelect: (messageId: string) => void }>;
};
