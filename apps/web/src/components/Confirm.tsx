import { useEffect, useRef, type ReactNode } from "react";

/** Pregunta de «¿seguro?» antes de una acción. Esc o «Cancelar» la descartan. */
export function Confirm({
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** La acción quita o borra algo: el botón se pinta en rojo. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      aria-labelledby="confirmar-titulo"
      className="m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-[10px] border-0 bg-panel p-5 text-ink shadow-[0_16px_40px_rgba(27,35,48,0.3)] backdrop:bg-ink/30"
    >
      <div className="flex flex-col gap-2.5">
        <h2 id="confirmar-titulo" className="m-0 text-base font-semibold">
          {title}
        </h2>
        <div className="leading-normal">{children}</div>
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="h-9 rounded-md border border-line-strong bg-panel px-3.5 font-semibold text-ink hover:bg-ground"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`h-9 rounded-md border-0 px-3.5 font-semibold text-white disabled:opacity-60 ${
              danger ? "bg-bad-ink" : "bg-accent"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
