/**
 * Piezas visuales de la tramitación, como en el lienzo: el texto va en tinta y el color
 * solo en el icono; cada estado tiene su propia forma. El rojo no se usa para estados.
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon.tsx";
import type { DerivedState, Health, PhaseState, Task } from "./api.ts";
import { dueText, healthText, shortDay } from "./logic.ts";

const STATE_ICON: Record<DerivedState, { icon: IconName; className: string; label: string }> = {
  lista: { icon: "circle", className: "text-ink-2", label: "Por hacer" },
  en_curso: { icon: "circleHalf", className: "text-ink", label: "En curso" },
  bloqueada: { icon: "circleDashed", className: "text-ink-2", label: "Bloqueada" },
  esperando: { icon: "hourglass", className: "text-ink-2", label: "Esperando" },
  hecha: { icon: "circleCheck", className: "text-ok", label: "Hecha" },
  omitida: { icon: "circleSlash", className: "text-ink-2", label: "No aplica" },
};

export function StateIcon({
  task,
  size = 16,
}: {
  task: Pick<Task, "state" | "waitingClient">;
  size?: number;
}) {
  const look = STATE_ICON[task.state];
  const icon = task.state === "esperando" && task.waitingClient ? "hourglassUser" : look.icon;
  return <Icon name={icon} size={size} className={look.className} label={look.label} />;
}

export function DueCell({
  due,
  today,
  legalRef,
  done,
}: {
  due: string | null;
  today: string;
  legalRef?: string | null;
  done?: boolean;
}) {
  if (done || !due) {
    return <span className="text-ink-2">{due ? shortDay(due, today) : "—"}</span>;
  }
  const { text, tone } = dueText(due, today);
  if (tone === "late") {
    return (
      <span className="inline-flex items-center gap-1.5 font-bold whitespace-nowrap text-ink">
        <Icon name="diamond" size={12} />
        {text}
      </span>
    );
  }
  if (tone === "soon") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink">
        <Icon name="triangle" size={13} className="text-flag" />
        {text}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-2"
      title={legalRef ? `Plazo legal orientativo · ${legalRef}` : undefined}
    >
      {legalRef && <Icon name="scales" size={13} label="Plazo legal" />}
      {text}
    </span>
  );
}

const HEALTH_ICON: Record<Health["level"], { icon: IconName; className: string; strong: boolean }> =
  {
    vencidas: { icon: "diamond", className: "text-ink", strong: true },
    parado: { icon: "pause", className: "text-ink", strong: true },
    riesgo: { icon: "triangle", className: "text-flag", strong: false },
    al_dia: { icon: "dot", className: "text-ok", strong: false },
    cerrado: { icon: "circleCheckOutline", className: "text-ink-2", strong: false },
    sin_plan: { icon: "circleDashed", className: "text-ink-2", strong: false },
  };

export function HealthBadge({ health, size = 14 }: { health: Health; size?: number }) {
  const look = HEALTH_ICON[health.level];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap ${look.strong ? "font-bold text-ink" : health.level === "cerrado" ? "text-ink-2" : "text-ink"}`}
      title={health.reasons.join(" · ") || undefined}
    >
      <Icon name={look.icon} size={size} className={look.className} />
      {healthText(health)}
    </span>
  );
}

const PHASE_LOOK: Record<PhaseState, string> = {
  hecha: "bg-[#EEF6F1] text-ink",
  actual: "bg-accent text-white",
  retraso: "bg-warn text-warn-ink",
  proxima: "bg-ground text-ink-2",
};

/** Barra de fases en chevrons. En compacto, solo los iconos. */
export function PhaseBar({
  phases,
  compact = false,
}: {
  phases: { name: string; state: PhaseState }[];
  compact?: boolean;
}) {
  return (
    <ol aria-label="Fases" className="m-0 flex list-none p-0">
      {phases.map((phase, index) => {
        const first = index === 0;
        const last = index === phases.length - 1;
        const clip = first
          ? "polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%)"
          : last
            ? "polygon(0 0, 100% 0, 100% 100%, 0 100%, 10px 50%)"
            : "polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%, 10px 50%)";
        const icon: ReactNode =
          phase.state === "hecha" ? (
            <Icon name="circleCheck" size={13} className="text-ok" />
          ) : phase.state === "actual" ? (
            <span className="size-2 rounded-full bg-white" />
          ) : phase.state === "retraso" ? (
            <Icon name="triangle" size={12} className="text-flag" />
          ) : null;
        const label = {
          hecha: "hecha",
          actual: "en curso",
          retraso: "con retraso",
          proxima: "pendiente",
        }[phase.state];
        return (
          <li
            key={phase.name}
            aria-label={`${phase.name}: ${label}`}
            aria-current={phase.state === "actual" ? "step" : undefined}
            className={`flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold whitespace-nowrap ${compact ? "h-6 justify-center" : "h-8 pr-3 pl-5"} ${first ? "" : "-ml-1"} ${PHASE_LOOK[phase.state]}`}
            style={{ clipPath: clip }}
          >
            {icon}
            {!compact && <span className="truncate">{phase.name}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function Avatar({ name, size = 22 }: { name: string | null; size?: number }) {
  if (!name) return <span className="text-ink-2">—</span>;
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-strong"
      style={{ width: size, height: size, fontSize: size < 24 ? 10 : 12 }}
    >
      {initials}
    </span>
  );
}

export function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-[26px] rounded-full border px-2.5 text-xs whitespace-nowrap ${
        active
          ? "border-accent bg-accent-soft font-semibold text-accent-strong"
          : "border-line-strong bg-panel text-ink hover:bg-ground"
      }`}
    >
      {children}
    </button>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="m-0 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
      {children}
    </h3>
  );
}

export const buttonClass = {
  primary:
    "inline-flex h-[30px] items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 font-semibold whitespace-nowrap text-white hover:bg-accent-strong disabled:opacity-60",
  secondary:
    "inline-flex h-[30px] items-center gap-1.5 rounded-md border border-line-strong bg-panel px-2.5 font-semibold whitespace-nowrap text-ink hover:bg-ground disabled:opacity-60",
  ghost:
    "inline-flex h-[30px] items-center gap-1.5 rounded-md border-0 bg-transparent px-2 whitespace-nowrap text-ink hover:bg-ground",
  small:
    "inline-flex h-6 items-center gap-1 rounded-md border border-line-strong bg-panel px-2 text-xs font-semibold whitespace-nowrap text-ink hover:bg-ground disabled:opacity-60",
  link: "border-0 bg-transparent p-0 font-semibold text-accent hover:text-accent-strong",
};

export const fieldClass =
  "h-8 rounded-md border border-line-strong bg-panel px-2 text-[13px] text-ink outline-none focus:border-accent";
