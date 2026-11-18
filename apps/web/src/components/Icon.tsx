import type { ReactNode } from "react";

const PATHS = {
  mail: (
    <>
      <path d="M2 4h12v9H2z" />
      <path d="m2 5 6 4 6-4" />
    </>
  ),
  archive: (
    <>
      <path d="M2 3.5h12v3H2z" />
      <path d="M3 6.5V13h10V6.5" />
      <path d="M6.5 9h3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  inbox: (
    <>
      <path d="M2 9l2-5h8l2 5v4H2z" />
      <path d="M2 9h3.5l1 1.5h3l1-1.5H14" />
    </>
  ),
  sent: <path d="m2 8 12-5-4 11-2.5-4.5z" />,
  drafts: <path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12z" />,
  trash: (
    <>
      <path d="M3 4.5h10" />
      <path d="M6 4.5V3h4v1.5" />
      <path d="M4.5 4.5 5 13h6l.5-8.5" />
    </>
  ),
  junk: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="m4 4 8 8" />
    </>
  ),
  folder: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  move: (
    <>
      <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
      <path d="M6.5 9.5h4M9 8l1.5 1.5L9 11" />
    </>
  ),
  clip: <path d="M12.5 7.5 8 12a2.8 2.8 0 0 1-4-4l5-5a1.9 1.9 0 0 1 2.7 2.7L7 10.4" />,
  flag: (
    <>
      <path d="M4 14V2.5" />
      <path d="M4 3h8l-2 3 2 3H4" />
    </>
  ),
  down: <path d="m4 6 4 4 4-4" />,
  right: <path d="m6 4 4 4-4 4" />,
  reply: (
    <>
      <path d="M6.5 4 2.5 8l4 4" />
      <path d="M3 8h6a4.5 4.5 0 0 1 4.5 4.5" />
    </>
  ),
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  back: (
    <>
      <path d="M7 3.5 2.5 8 7 12.5" />
      <path d="M3 8h10.5" />
    </>
  ),
  replyAll: (
    <>
      <path d="M5 4.5 1.5 8 5 11.5" />
      <path d="M9 4.5 5.5 8 9 11.5" />
      <path d="M6 8h4a4.5 4.5 0 0 1 4.5 4.5" />
    </>
  ),
  forward: (
    <>
      <path d="m9.5 4 4 4-4 4" />
      <path d="M13 8H7a4.5 4.5 0 0 0-4.5 4.5" />
    </>
  ),
  print: (
    <>
      <path d="M4.5 6V2.5h7V6" />
      <path d="M4.5 11.5H2.5V6h11v5.5h-2" />
      <path d="M4.5 9.5h7v4h-7z" />
    </>
  ),
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M10 3v10" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
    </>
  ),
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  file: (
    <>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </>
  ),
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="m2 11 3.5-3.5 3 3L11 8l3 3" />
    </>
  ),
  imageOff: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="m2 11 3.5-3.5 3 3L11 8l3 3" />
      <path d="M2 2l12 12" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2 14.5 13.5h-13z" />
      <path d="M8 6.5v3.5" />
      <path d="M8 11.8v.2" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5" />
      <path d="M8 10.8v.2" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.5" />
      <path d="M13 2.5v3h-3" />
    </>
  ),
  check: <path d="m3 8.5 3 3 7-7" />,
  case: (
    <>
      <path d="M2 5h12v8H2z" />
      <path d="M6 5V3h4v2" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  logout: (
    <>
      <path d="M6.5 2.5h-4v11h4" />
      <path d="M6 8h8M11 5l3 3-3 3" />
    </>
  ),
  // Estados de la tramitación. Cada uno con su forma, para no depender del color.
  circle: <circle cx="8" cy="8" r="5.5" />,
  circleDashed: <circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 2.2" />,
  circleHalf: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </>
  ),
  circleSlash: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m4.2 11.8 7.6-7.6" />
    </>
  ),
  circleCheck: (
    <>
      <circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" />
      <path d="m5.3 8.2 1.9 1.9 3.6-3.8" stroke="#fff" strokeWidth="1.8" />
    </>
  ),
  circleCheckOutline: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m5.4 8.1 1.8 1.8 3.4-3.6" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="5.5" fill="currentColor" stroke="none" />,
  hourglass: (
    <>
      <path d="M4.5 2.5h7M4.5 13.5h7" />
      <path d="M5.5 2.5c0 3 5 3.3 5 5.5s-5 2.5-5 5.5M10.5 2.5c0 3-5 3.3-5 5.5s5 2.5 5 5.5" />
    </>
  ),
  hourglassUser: (
    <>
      <path d="M3.5 2.5h6M3.5 13.5h6" />
      <path d="M4.3 2.5c0 3 4.4 3.3 4.4 5.5s-4.4 2.5-4.4 5.5M8.7 2.5c0 3-4.4 3.3-4.4 5.5s4.4 2.5 4.4 5.5" />
      <circle cx="13" cy="6.2" r="1.5" />
      <path d="M10.8 11.5a2.2 2.2 0 0 1 4.4 0" />
    </>
  ),
  triangle: (
    <>
      <path d="M8 2.3 14.2 13H1.8z" fill="currentColor" />
      <path d="M8 6.4v3" stroke="#fff" strokeWidth="1.6" />
      <path d="M8 11.1v.1" stroke="#fff" strokeWidth="1.8" />
    </>
  ),
  diamond: <path d="M8 1.6 14.4 8 8 14.4 1.6 8z" fill="currentColor" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2.6" />,
  scales: (
    <>
      <path d="M8 2.5v11M5 13.5h6M3 4.5h10" />
      <path d="M3 4.5 1.5 8.5h3zM13 4.5l-1.5 4h3z" />
    </>
  ),
  tasks: (
    <>
      <path d="M2.5 4.5h1.5M2.5 8h1.5M2.5 11.5h1.5" />
      <path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h4.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  lock: (
    <>
      <path d="M4 7.5h8v6H4z" />
      <path d="M5.8 7.5V5.5a2.2 2.2 0 0 1 4.4 0v2" />
    </>
  ),
  server: (
    <>
      <path d="M2.5 3h11v4h-11zM2.5 9h11v4h-11z" />
      <path d="M5 5h.1M5 11h.1" strokeWidth="2" />
    </>
  ),
  cloud: <path d="M4.5 12.5h7a3 3 0 0 0 .4-6 4 4 0 0 0-7.7 1A2.5 2.5 0 0 0 4.5 12.5z" />,
  more: (
    <>
      <circle cx="4" cy="8" r=".7" fill="currentColor" />
      <circle cx="8" cy="8" r=".7" fill="currentColor" />
      <circle cx="12" cy="8" r=".7" fill="currentColor" />
    </>
  ),
  note: (
    <>
      <path d="M3 2.5h10v11H3z" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/** Icono de trazo. Decorativo por defecto; con `label` se anuncia a los lectores de pantalla. */
export function Icon({
  name,
  size = 16,
  label,
  className,
  filled = false,
}: {
  name: IconName;
  size?: number;
  label?: string;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ""}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {PATHS[name]}
    </svg>
  );
}

/** Icono que corresponde a una carpeta según su papel. */
export function folderIcon(specialUse: string | null): IconName {
  if (specialUse && specialUse in PATHS) return specialUse as IconName;
  return "folder";
}
