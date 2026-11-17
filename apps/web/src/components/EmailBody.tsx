import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Hoja de estilo mínima dentro del marco: el correo trae sus propios estilos en línea
 * (los que han pasado el filtro del servidor).
 */
const FRAME_STYLE = `
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1b2330;
         overflow-wrap: anywhere; overflow: hidden; }
  img { max-width: 100%; height: auto; }
  img[data-blocked] { display: inline-block; min-width: 20px; min-height: 20px;
         border: 1px dashed #c9d1dc; background: #f3f5f8; vertical-align: middle; }
  table { max-width: 100%; }
  a { color: #1859c9; }
  blockquote { margin: 8px 0; padding-left: 12px; border-left: 2px solid #c9d1dc; color: #4a5362; }
  pre { white-space: pre-wrap; font-family: inherit; }
  p { margin: 0 0 10px; }
`;

/**
 * Muestra el cuerpo de un correo dentro de un marco aislado.
 *
 * El HTML ya llega saneado del servidor; el marco es la segunda barrera: no puede
 * ejecutar scripts ni enviar formularios, y su política de contenido solo admite
 * imágenes y estilos en línea. Se le permite compartir origen (sin scripts no puede
 * aprovecharlo) únicamente para que la página pueda medir su altura.
 */
export function EmailBody({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const document = useMemo(
    () =>
      `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'">` +
      `<base target="_blank"><style>${FRAME_STYLE}</style></head><body>${html}</body></html>`,
    [html],
  );

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      const body = element.contentDocument?.body;
      if (body) setHeight(Math.max(40, Math.ceil(body.scrollHeight)));
    };
    const onLoad = () => {
      measure();
      const body = element.contentDocument?.body;
      if (!body) return;
      observer?.disconnect();
      // Las imágenes cambian la altura al terminar de cargar.
      observer = new ResizeObserver(measure);
      observer.observe(body);
    };
    element.addEventListener("load", onLoad);
    if (element.contentDocument?.readyState === "complete") onLoad();
    return () => {
      element.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [document]);

  return (
    <iframe
      ref={frame}
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={document}
      style={{ height }}
      className="block w-full border-0"
    />
  );
}
