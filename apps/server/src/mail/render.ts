import sanitizeHtml from "sanitize-html";

export type InlineImage = { contentType: string; content: Buffer };

export type RenderOptions = {
  /** Cargar imágenes de otros servidores. Por defecto no: sirven para rastrear la lectura. */
  allowRemoteImages?: boolean;
  /** Imágenes incrustadas en el propio correo, por su identificador (cid). */
  inlineImages?: Map<string, InlineImage>;
};

export type RenderedEmail = {
  html: string;
  /** Imágenes externas que no se han cargado. */
  blockedImages: number;
};

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * Valor de estilo sin nada que pueda cargar un recurso o ejecutar algo: se admiten
 * rgb()/hsl() y nada más entre paréntesis, lo que deja fuera url(), expression() y var().
 */
const SAFE_VALUE = /^(?:[^()\\;{}<>@]|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/a-z]+\))*$/i;

const STYLE_PROPERTIES = [
  "color",
  "background-color",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-variant",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-transform",
  "vertical-align",
  "white-space",
  "word-break",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-collapse",
  "border-spacing",
  "border-radius",
  "width",
  "height",
  "max-width",
  "min-width",
  "display",
  "list-style-type",
  "table-layout",
];

const allowedStyles = {
  "*": Object.fromEntries(STYLE_PROPERTIES.map((property) => [property, [SAFE_VALUE]])),
};

const LAYOUT_ATTRIBUTES = [
  "style",
  "align",
  "valign",
  "bgcolor",
  "width",
  "height",
  "colspan",
  "rowspan",
  "cellpadding",
  "cellspacing",
  "border",
  "dir",
  "lang",
  "title",
];

/**
 * Convierte el HTML de un correo en HTML que se puede mostrar sin riesgo: sin scripts,
 * formularios, marcos ni hojas de estilo; con los estilos en línea filtrados; con las
 * imágenes externas bloqueadas salvo permiso; y con las incrustadas dentro del propio
 * documento. La interfaz lo muestra además en un marco aislado.
 */
export function renderEmailHtml(source: string, options: RenderOptions = {}): RenderedEmail {
  let blockedImages = 0;

  const html = sanitizeHtml(source, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== "nl"),
      "img",
      "font",
      "center",
      "u",
      "s",
      "ins",
      "del",
    ],
    allowedAttributes: {
      "*": LAYOUT_ATTRIBUTES,
      a: ["href", "name", "target", "rel", ...LAYOUT_ATTRIBUTES],
      img: ["src", "alt", "data-blocked", ...LAYOUT_ATTRIBUTES],
      font: ["color", "face", "size", ...LAYOUT_ATTRIBUTES],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
    allowProtocolRelative: false,
    allowedStyles,
    transformTags: {
      a: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        if (next.href && !/^(?:https?:|mailto:|tel:)/i.test(next.href.trim())) delete next.href;
        if (next.href) {
          next.target = "_blank";
          next.rel = "noopener noreferrer nofollow";
          // El texto de un enlace puede decir una cosa y llevar a otra: al pasar el
          // ratón se ve la dirección real.
          next.title = next.href;
        }
        return { tagName, attribs: next };
      },
      img: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        const src = (next.src ?? "").trim();
        delete next.src;

        if (/^cid:/i.test(src)) {
          const image = options.inlineImages?.get(src.slice(4).replace(/^<|>$/g, ""));
          if (
            image &&
            INLINE_IMAGE_TYPES.has(image.contentType.toLowerCase()) &&
            image.content.length <= MAX_INLINE_IMAGE_BYTES
          ) {
            next.src = `data:${image.contentType.toLowerCase()};base64,${image.content.toString("base64")}`;
          }
        } else if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) {
          next.src = src;
        } else if (/^https?:\/\//i.test(src)) {
          if (options.allowRemoteImages) {
            next.src = src;
          } else {
            blockedImages++;
            next["data-blocked"] = "1";
          }
        }
        return { tagName, attribs: next };
      },
    },
  });

  return { html, blockedImages };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Un correo de solo texto, listo para mostrarse: conserva los saltos y enlaza las direcciones. */
export function renderEmailText(text: string): RenderedEmail {
  const body = escapeHtml(text).replace(
    /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`,
  );
  return { html: `<div style="white-space: pre-wrap">${body}</div>`, blockedImages: 0 };
}
