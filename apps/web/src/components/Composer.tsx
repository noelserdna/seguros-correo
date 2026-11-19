import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { api, ApiError, type Account, type Outbound, type OutboundFile } from "../api.ts";
import { formatSize } from "../format.ts";
import { plugins } from "../plugins/index.ts";
import { formatRecipients, parseRecipients } from "../recipients.ts";
import { Icon } from "./Icon.tsx";

const AUTOSAVE_MS = 2000;

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : "Algo ha fallado. Inténtalo de nuevo.";

const clock = (date: Date) => `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;

function Field({
  label,
  htmlFor,
  children,
  error,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  error?: string;
}) {
  return (
    <div className="border-b border-line-soft">
      <div className="flex min-h-[38px] items-center gap-3">
        <label htmlFor={htmlFor} className="w-12 shrink-0 text-ink-2">
          {label}
        </label>
        {children}
      </div>
      {error && (
        <p role="alert" className="m-0 pb-1.5 pl-[60px] text-xs text-bad-ink">
          {error}
        </p>
      )}
    </div>
  );
}

const input = "min-w-0 grow border-0 bg-transparent py-2 text-[13px] text-ink outline-none";

function FormatButton({
  label,
  command,
  children,
}: {
  label: string;
  command: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // Sin esto el botón se lleva el foco y el texto pierde la selección.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => document.execCommand(command)}
      className="flex h-7 min-w-7 items-center justify-center rounded-md border-0 bg-transparent px-1.5 text-ink-2 hover:bg-ground hover:text-ink"
    >
      {children}
    </button>
  );
}

/** Firma del usuario en este buzón. Vale para los correos que se empiecen después. */
function SignatureDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: ["signature", accountId],
    queryFn: () => api.signature(accountId),
  });
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  const value = text ?? current.data ?? "";

  const save = () => {
    api
      .saveSignature(accountId, value)
      .then(() => {
        queryClient.setQueryData(["signature", accountId], value);
        onClose();
      })
      .catch((error: unknown) => setFailed(errorText(error)));
  };

  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="titulo-firma"
      className="m-auto w-[460px] max-w-[calc(100vw-32px)] rounded-[10px] border-0 bg-panel p-5 text-ink shadow-[0_16px_40px_rgba(27,35,48,0.3)] backdrop:bg-ink/30"
    >
      <div className="flex flex-col gap-2.5">
        <h2 id="titulo-firma" className="m-0 text-base font-semibold">
          Tu firma en este buzón
        </h2>
        <p className="m-0 text-xs leading-normal text-ink-2">
          Se añade al final de los correos que empieces a partir de ahora. El que tienes abierto no
          cambia.
        </p>
        <textarea
          aria-label="Firma"
          rows={5}
          value={value}
          onChange={(event) => setText(event.target.value)}
          placeholder={"Nombre y apellidos\nCargo · Teléfono"}
          className="resize-y rounded-md border border-line-strong p-2.5 font-sans text-[13px] text-ink"
        />
        {failed && (
          <p role="alert" className="m-0 text-xs text-bad-ink">
            {failed}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-line-strong bg-panel px-3.5 font-semibold text-ink hover:bg-ground"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={save}
            className="h-9 rounded-md border-0 bg-accent px-3.5 font-semibold text-white"
          >
            Guardar firma
          </button>
        </div>
      </div>
    </dialog>
  );
}

function Editor({
  outbound,
  account,
  onClose,
  onSent,
}: {
  outbound: Outbound;
  account: Account | undefined;
  onClose: () => void;
  onSent: (outbound: Outbound, undoMs: number) => void;
}) {
  const queryClient = useQueryClient();
  const body = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [to, setTo] = useState(() => formatRecipients(outbound.to));
  const [cc, setCc] = useState(() => formatRecipients(outbound.cc));
  const [bcc, setBcc] = useState(() => formatRecipients(outbound.bcc));
  const [subject, setSubject] = useState(outbound.subject);
  const [showCopies, setShowCopies] = useState(outbound.cc.length + outbound.bcc.length > 0);
  const [files, setFiles] = useState<OutboundFile[]>(outbound.attachments);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [save, setSave] = useState<SaveState>(
    outbound.draftSavedAt ? { kind: "saved", at: new Date(outbound.updatedAt) } : { kind: "idle" },
  );
  const [problem, setProblem] = useState(outbound.state === "failed" ? (outbound.error ?? "") : "");
  const [sending, setSending] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const dirty = useRef(false);

  const parsed = { to: parseRecipients(to), cc: parseRecipients(cc), bcc: parseRecipients(bcc) };
  const invalid = [...parsed.to.invalid, ...parsed.cc.invalid, ...parsed.bcc.invalid];
  const latest = useRef({ parsed, subject, invalid });
  latest.current = { parsed, subject, invalid };

  // El contenido inicial se coloca una sola vez: a partir de ahí manda lo que se escribe.
  useEffect(() => {
    if (!body.current) return;
    body.current.innerHTML = outbound.bodyHtml;
    if (outbound.kind === "new" || outbound.kind === "forward") {
      document.getElementById("redactar-para")?.focus();
    } else {
      body.current.focus();
    }
  }, [outbound.id, outbound.bodyHtml, outbound.kind]);

  const changed = useCallback(() => {
    dirty.current = true;
    setVersion((value) => value + 1);
  }, []);

  /** Guarda si hay cambios. Devuelve si el borrador ha quedado guardado. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (!dirty.current) return true;
    const current = latest.current;
    if (current.invalid.length > 0) return false;
    dirty.current = false;
    setSave({ kind: "saving" });
    try {
      await api.saveOutbound(outbound.id, {
        to: current.parsed.to.list,
        cc: current.parsed.cc.list,
        bcc: current.parsed.bcc.list,
        subject: current.subject,
        bodyHtml: body.current?.innerHTML ?? "",
      });
      setSave({ kind: "saved", at: new Date() });
      return true;
    } catch (error) {
      dirty.current = true;
      setSave({ kind: "error", message: errorText(error) });
      return false;
    }
  }, [outbound.id]);

  // Se guarda solo, un momento después de dejar de escribir.
  useEffect(() => {
    if (version === 0) return;
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [version, flush]);
  // Y al salir de la pantalla, si quedaba algo.
  useEffect(() => () => void flush(), [flush]);

  const addFiles = async (list: FileList | File[]) => {
    for (const file of list) {
      setUploading((count) => count + 1);
      try {
        const added = await api.attach(outbound.id, file);
        setFiles((current) => [...current, added]);
        setSave({ kind: "saved", at: new Date() });
      } catch (error) {
        setProblem(`No se ha podido adjuntar «${file.name}». ${errorText(error)}`);
      } finally {
        setUploading((count) => count - 1);
      }
    }
  };

  const removeFile = (file: OutboundFile) => {
    setFiles((current) => current.filter((entry) => entry.id !== file.id));
    api.detach(outbound.id, file.id).catch((error: unknown) => {
      setFiles((current) => [...current, file]);
      setProblem(errorText(error));
    });
  };

  const send = async () => {
    setProblem("");
    if (invalid.length > 0) return;
    if (parsed.to.list.length + parsed.cc.list.length + parsed.bcc.list.length === 0) {
      setProblem("Falta al menos un destinatario.");
      document.getElementById("redactar-para")?.focus();
      return;
    }
    setSending(true);
    dirty.current = true;
    try {
      if (!(await flush())) throw new Error("save");
      const result = await api.send(outbound.id);
      void queryClient.invalidateQueries({ queryKey: ["outbox"] });
      onSent(result.outbound, result.undoMs);
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : "No se ha podido guardar el correo para enviarlo.",
      );
      setSending(false);
    }
  };

  const discard = () => {
    dirty.current = false;
    api
      .discardOutbound(outbound.id)
      .then(() => {
        queryClient.removeQueries({ queryKey: ["outbound", outbound.id] });
        void queryClient.invalidateQueries({ queryKey: ["outbox"] });
        onClose();
      })
      .catch((error: unknown) => setProblem(errorText(error)));
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
  };

  const badAddresses = (list: string[]) =>
    list.length > 0 ? `No es una dirección de correo: ${list.join(", ")}` : undefined;
  const status =
    uploading > 0
      ? "Adjuntando…"
      : save.kind === "saving"
        ? "Guardando…"
        : save.kind === "saved"
          ? `Guardado en Borradores a las ${clock(save.at)}`
          : save.kind === "error"
            ? `No se ha podido guardar: ${save.message}`
            : "";

  return (
    <main
      aria-label="Redactar correo"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`relative flex min-w-0 grow flex-col bg-panel ${dragging ? "outline-2 -outline-offset-2 outline-accent" : ""}`}
    >
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 border-b border-line px-3 py-1">
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || uploading > 0}
          className="flex h-[30px] items-center gap-1.5 rounded-md border-0 bg-accent px-3.5 font-semibold text-white disabled:opacity-60"
        >
          <Icon name="sent" />
          {sending ? "Enviando…" : "Enviar"}
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="flex h-[30px] items-center gap-1.5 rounded-md border-0 bg-transparent px-2.5 text-ink hover:bg-ground"
        >
          <Icon name="clip" />
          Adjuntar
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void addFiles([...event.target.files]);
            event.target.value = "";
          }}
        />
        <span
          role="status"
          className={`hidden truncate text-xs sm:inline ${save.kind === "error" ? "text-bad-ink" : "text-ink-2"}`}
        >
          {status}
        </span>
        <span className="grow" />
        <button
          type="button"
          onClick={() => void flush().then(onClose)}
          title="Cerrar y seguir más tarde. El correo queda en Borradores."
          className="h-[30px] rounded-md border-0 bg-transparent px-2.5 text-ink hover:bg-ground"
        >
          Cerrar
        </button>
        <button
          type="button"
          onClick={discard}
          className="h-[30px] rounded-md border-0 bg-transparent px-2.5 text-ink hover:bg-ground"
        >
          Descartar
        </button>
      </div>

      {problem && (
        <div
          role="alert"
          className="mx-6 mt-3 flex shrink-0 items-start gap-2.5 rounded-md border border-warn-line bg-warn px-3 py-2.5 leading-[1.45] text-warn-ink"
        >
          <Icon name="alert" className="mt-0.5" />
          <span className="grow">{problem}</span>
          <button
            type="button"
            onClick={() => setProblem("")}
            className="border-0 bg-transparent p-0 font-semibold text-warn-ink"
          >
            Cerrar
          </button>
        </div>
      )}

      <div className="flex shrink-0 flex-col px-4 md:px-6">
        <Field label="De" htmlFor="redactar-de">
          <span id="redactar-de" className="truncate py-2">
            {account
              ? account.name !== account.email
                ? `${account.name} <${account.email}>`
                : account.email
              : ""}
          </span>
        </Field>
        <Field label="Para" htmlFor="redactar-para" error={badAddresses(parsed.to.invalid)}>
          <input
            id="redactar-para"
            type="text"
            value={to}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setTo(event.target.value);
              changed();
            }}
            placeholder="Direcciones separadas por comas"
            className={input}
          />
          {!showCopies && (
            <button
              type="button"
              onClick={() => setShowCopies(true)}
              className="shrink-0 border-0 bg-transparent p-0 text-xs font-semibold text-accent hover:text-accent-strong"
            >
              CC · CCO
            </button>
          )}
        </Field>
        {showCopies && (
          <>
            <Field label="CC" htmlFor="redactar-cc" error={badAddresses(parsed.cc.invalid)}>
              <input
                id="redactar-cc"
                type="text"
                value={cc}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setCc(event.target.value);
                  changed();
                }}
                className={input}
              />
            </Field>
            <Field label="CCO" htmlFor="redactar-cco" error={badAddresses(parsed.bcc.invalid)}>
              <input
                id="redactar-cco"
                type="text"
                value={bcc}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setBcc(event.target.value);
                  changed();
                }}
                placeholder="Copia oculta: los demás no ven estas direcciones"
                className={input}
              />
            </Field>
          </>
        )}
        <Field label="Asunto" htmlFor="redactar-asunto">
          <input
            id="redactar-asunto"
            type="text"
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
              changed();
            }}
            className={`${input} font-semibold`}
          />
        </Field>
      </div>

      {plugins.map(
        (plugin) =>
          plugin.ComposeNotice && (
            <plugin.ComposeNotice
              key={plugin.id}
              recipients={[...parsed.to.list, ...parsed.cc.list, ...parsed.bcc.list].map(
                (address) => address.address,
              )}
            />
          ),
      )}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line-soft px-5">
        <FormatButton label="Negrita" command="bold">
          <b>N</b>
        </FormatButton>
        <FormatButton label="Cursiva" command="italic">
          <i>K</i>
        </FormatButton>
        <FormatButton label="Subrayado" command="underline">
          <u>S</u>
        </FormatButton>
        <span className="mx-1.5 h-[18px] w-px bg-line" />
        <FormatButton label="Lista con puntos" command="insertUnorderedList">
          • Lista
        </FormatButton>
        <FormatButton label="Lista numerada" command="insertOrderedList">
          1. Lista
        </FormatButton>
        <span className="grow" />
        <button
          type="button"
          onClick={() => setSignatureOpen(true)}
          className="h-7 rounded-md border-0 bg-transparent px-2 text-xs text-ink-2 hover:bg-ground hover:text-ink"
        >
          Firma
        </button>
      </div>

      <div
        ref={body}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Texto del correo"
        onInput={changed}
        // El cursor ya indica dónde se escribe; el recuadro de foco aquí solo estorba.
        style={{ outline: "none" }}
        className="min-h-0 grow overflow-y-auto px-6 py-4 text-sm leading-[1.6] outline-none [&_a]:text-accent [&_blockquote]:text-ink-2 [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:max-w-full [&_ul]:list-disc [&_ul]:pl-6"
      />

      <div className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-2 border-t border-line-soft px-6 py-2">
        {files.map((file) => (
          <span
            key={file.id}
            className="flex h-9 max-w-[260px] items-center gap-2 rounded-md border border-line-strong pr-1 pl-2.5 text-xs"
          >
            <span className="truncate font-semibold">{file.filename}</span>
            <span className="whitespace-nowrap text-ink-2">{formatSize(file.size)}</span>
            <button
              type="button"
              onClick={() => removeFile(file)}
              aria-label={`Quitar ${file.filename}`}
              className="flex size-6 items-center justify-center rounded border-0 bg-transparent text-ink-2 hover:bg-ground hover:text-ink"
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        <span className="text-xs text-ink-2">
          {dragging
            ? "Suelta los ficheros para adjuntarlos"
            : "También puedes arrastrar ficheros aquí"}
        </span>
      </div>

      {signatureOpen && (
        <SignatureDialog accountId={outbound.accountId} onClose={() => setSignatureOpen(false)} />
      )}
    </main>
  );
}

/** Pantalla de redactar: ocupa el panel de lectura mientras se escribe un correo. */
export function Composer({
  id,
  accounts,
  onClose,
  onSent,
}: {
  id: string;
  accounts: Account[];
  onClose: () => void;
  onSent: (outbound: Outbound, undoMs: number) => void;
}) {
  const outbound = useQuery({
    queryKey: ["outbound", id],
    queryFn: () => api.outbound(id),
    // Lo que se está escribiendo no se recarga por detrás: se perdería lo tecleado.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  if (outbound.isLoading) {
    return (
      <main className="flex min-w-0 grow bg-panel p-6 text-ink-2" role="status">
        Abriendo el borrador…
      </main>
    );
  }
  const editable = outbound.data?.state === "draft" || outbound.data?.state === "failed";
  if (!outbound.data || !editable) {
    return (
      <main className="flex min-w-0 grow flex-col items-start gap-2 bg-panel p-6">
        <p className="m-0 text-ink-2">
          {outbound.data
            ? "Este correo ya está saliendo o ya se ha enviado."
            : "Este borrador ya no existe."}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-md border border-line-strong bg-panel px-3 font-semibold"
        >
          Cerrar
        </button>
      </main>
    );
  }
  return (
    <Editor
      key={outbound.data.id}
      outbound={outbound.data}
      account={accounts.find((account) => account.id === outbound.data.accountId)}
      onClose={onClose}
      onSent={onSent}
    />
  );
}
