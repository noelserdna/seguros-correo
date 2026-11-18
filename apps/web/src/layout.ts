import { useEffect, useState } from "react";

/**
 * Tres disposiciones según el ancho de la ventana:
 * - teléfono: una sola cosa a la vez (lista o correo) y el menú en un panel lateral;
 * - tableta: lista y correo, con las carpetas en un panel lateral;
 * - escritorio: todo a la vista.
 */
export type Layout = "phone" | "tablet" | "desktop";

const PHONE = 768;
const DESKTOP = 1280;
/** A partir de este ancho el panel de contexto cabe al lado; por debajo se superpone. */
const WIDE = 1440;

export function layoutFor(width: number): Layout {
  return width < PHONE ? "phone" : width < DESKTOP ? "tablet" : "desktop";
}

export function useLayout(): { layout: Layout; wide: boolean } {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { layout: layoutFor(width), wide: width >= WIDE };
}
