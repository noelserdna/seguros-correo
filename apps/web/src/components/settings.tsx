/** Piezas comunes de los apartados de Configuración: bloques sin caja y listas de un catálogo. */
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api.ts";
import { Confirm } from "./Confirm.tsx";
import { Icon } from "./Icon.tsx";

/** Un bloque dentro de un apartado: título pequeño, explicación y contenido. Sin caja alrededor. */
export function SettingsBlock({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="m-0 grow text-sm font-semibold">{title}</h3>
          {actions}
        </div>
        {description && <p className="m-0 text-xs leading-normal text-ink-2">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Lista de filas separadas por una línea. */
export function Rows({ children }: { children: ReactNode }) {
  return (
    <ul className="m-0 flex list-none flex-col border-t border-line p-0 [&>li]:border-b [&>li]:border-line-soft">
      {children}
    </ul>
  );
}

export const settingsButton = {
  primary:
    "inline-flex h-[34px] items-center gap-1.5 rounded-md border border-accent bg-accent px-3 font-semibold whitespace-nowrap text-white hover:bg-accent-strong disabled:opacity-60",
  secondary:
    "inline-flex h-[34px] items-center gap-1.5 rounded-md border border-line-strong bg-panel px-3 font-semibold whitespace-nowrap text-ink hover:bg-ground disabled:opacity-60",
  link: "border-0 bg-transparent p-0 font-semibold text-accent hover:text-accent-strong disabled:opacity-60",
};
export const settingsField =
  "h-[34px] w-full min-w-0 rounded-md border border-line-strong bg-panel px-2.5 text-[13px] text-ink outline-none focus:border-accent";

/** Campo con su etiqueta encima y, si hace falta, una ayuda debajo. */
export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-semibold">{label}</span>
      {children}
      {hint && <span className="text-xs leading-normal text-ink-2">{hint}</span>}
    </label>
  );
}

export const errorText = (error: unknown, fallback = "No se ha podido guardar el cambio.") =>
  error instanceof ApiError ? error.message : fallback;

type CatalogItem = { id: string; name: string; caseCount: number };

/** Catálogo sencillo: añadir por nombre y quitar con confirmación. */
export function CatalogList({
  title,
  description,
  items,
  loaded,
  isAdmin,
  placeholder,
  noun,
  removeEffect,
  onAdd,
  onRemove,
}: {
  title: string;
  description: string;
  items: CatalogItem[];
  loaded: boolean;
  isAdmin: boolean;
  placeholder: string;
  /** Cómo se llama un elemento, para la confirmación: «aseguradora». */
  noun: string;
  /** Qué les pasa a los expedientes que lo usan. */
  removeEffect: (count: number) => string;
  onAdd: (name: string) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [failed, setFailed] = useState("");
  const [removing, setRemoving] = useState<CatalogItem | null>(null);
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setFailed("");
    onAdd(name.trim()).then(
      () => setName(""),
      (error: unknown) => setFailed(errorText(error)),
    );
  };
  const count = (n: number) => (n === 1 ? "1 expediente" : `${n} expedientes`);
  return (
    <SettingsBlock title={title} description={description}>
      {isAdmin && (
        <form onSubmit={add} className="flex gap-2">
          <input
            aria-label={placeholder}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={placeholder}
            className={settingsField}
          />
          <button type="submit" disabled={!name.trim()} className={settingsButton.secondary}>
            <Icon name="plus" size={14} />
            Añadir
          </button>
        </form>
      )}
      {failed && (
        <p role="alert" className="m-0 text-xs text-bad-ink">
          {failed}
        </p>
      )}
      {loaded && items.length === 0 ? (
        <p className="m-0 text-xs text-ink-2">Todavía no hay ninguna.</p>
      ) : (
        <Rows>
          {items.map((item) => (
            <li key={item.id} className="flex min-h-11 items-center gap-3">
              <span className="min-w-0 grow truncate">{item.name}</span>
              <span className="text-xs whitespace-nowrap text-ink-2">{count(item.caseCount)}</span>
              {isAdmin && (
                <button
                  type="button"
                  aria-label={`Quitar ${item.name}`}
                  onClick={() => setRemoving(item)}
                  className="flex size-7 items-center justify-center rounded-md border-0 bg-transparent text-ink-2 hover:bg-ground hover:text-ink"
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </li>
          ))}
        </Rows>
      )}
      {removing && (
        <Confirm
          title={`¿Quitar «${removing.name}»?`}
          confirmLabel={`Quitar ${noun}`}
          danger
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            onRemove(target.id).catch((error: unknown) => setFailed(errorText(error)));
          }}
          onCancel={() => setRemoving(null)}
        >
          <p className="m-0">
            {removing.caseCount === 0
              ? `Ningún expediente la usa.`
              : `${count(removing.caseCount)} la ${removing.caseCount === 1 ? "usa" : "usan"}: ${removeEffect(removing.caseCount)} Los expedientes y sus correos no se tocan.`}
          </p>
        </Confirm>
      )}
    </SettingsBlock>
  );
}
