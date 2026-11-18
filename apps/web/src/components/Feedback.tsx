import { useEffect, useRef } from "react";
import type { Toast } from "../actions.ts";
import { Icon } from "./Icon.tsx";

/** Aviso breve abajo, con «Deshacer» cuando la acción lo permite. */
export function ToastView({
  toast,
  onUndo,
  onClose,
}: {
  toast: Toast;
  onUndo: () => void;
  onClose: () => void;
}) {
  if (toast.tone === "error") {
    return (
      <div
        role="alert"
        className="fixed bottom-6 left-1/2 z-30 flex w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 items-start gap-2.5 rounded-md border border-warn-line bg-warn px-3.5 py-3 text-warn-ink shadow-[0_8px_24px_rgba(27,35,48,0.18)]"
      >
        <Icon name="alert" className="mt-0.5" />
        <div className="flex min-w-0 grow flex-col gap-0.5 leading-[1.45]">
          <span className="font-semibold">{toast.title}</span>
          {toast.detail && <span>{toast.detail}</span>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="border-0 bg-transparent p-0 font-semibold text-warn-ink"
        >
          Cerrar
        </button>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-30 flex min-h-11 min-w-[360px] max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-4 rounded-lg bg-ink py-1.5 pr-2 pl-4 text-white shadow-[0_8px_24px_rgba(27,35,48,0.25)]"
    >
      {toast.busy && (
        <span
          aria-hidden
          className="size-4 shrink-0 animate-spin rounded-full border-2 border-rail-ink border-t-transparent"
        />
      )}
      <span className="grow">
        {toast.title}
        {toast.detail && <span className="text-rail-ink"> · {toast.detail}</span>}
      </span>
      {toast.undo && (
        <button
          type="button"
          onClick={onUndo}
          title="Deshacer (Ctrl + Z)"
          className="h-[30px] rounded-md border-0 bg-rail-active px-3 font-semibold text-white hover:bg-[#3b4960]"
        >
          Deshacer
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        hidden={toast.busy}
        aria-label="Cerrar el aviso"
        className="flex size-[30px] items-center justify-center rounded-md border-0 bg-transparent text-rail-ink hover:bg-rail-active"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Confirmación antes de borrar un correo del buzón del servidor, que no tiene vuelta atrás. */
export function ConfirmDelete({
  onConfirm,
  onCancel,
}: {
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
      aria-labelledby="confirmar-borrado"
      className="m-auto w-[420px] max-w-[calc(100vw-32px)] rounded-[10px] border-0 bg-panel p-5 text-ink shadow-[0_16px_40px_rgba(27,35,48,0.3)] backdrop:bg-ink/30"
    >
      <div className="flex flex-col gap-2.5">
        <h2 id="confirmar-borrado" className="m-0 text-base font-semibold">
          ¿Borrar este correo del buzón?
        </h2>
        <p className="m-0 leading-normal">
          Dejará de verse en Outlook y en el servidor de correo, y eso no se puede deshacer. Aquí se
          conserva en el archivo, completo y con sus adjuntos.
        </p>
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
            className="h-9 rounded-md border-0 bg-bad-ink px-3.5 font-semibold text-white"
          >
            Borrar del buzón
          </button>
        </div>
      </div>
    </dialog>
  );
}
