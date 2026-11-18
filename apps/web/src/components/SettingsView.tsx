/**
 * Pantalla de Configuración: una página con su propio menú de apartados, agrupados por para
 * qué sirven. El núcleo aporta Buzones, Lectura de documentos y Módulos; cada plugin, los suyos.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type Account, type NewAccount } from "../api.ts";
import { useLayout } from "../layout.ts";
import { plugins } from "../plugins/index.ts";
import { SETTINGS_GROUPS, type SettingsPage } from "../plugins/types.ts";
import { navigate, useUrlState } from "../url-state.ts";
import { Icon } from "./Icon.tsx";
import {
  errorText,
  Field,
  Rows,
  SettingsBlock,
  settingsButton,
  settingsField,
} from "./settings.tsx";

const number = (value: number) => value.toLocaleString("es-ES");

// ------------------------------------------------------------------ Buzones

function since(iso: string | null): string {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "ahora mismo";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

const PROVIDER: Record<Account["authType"], { label: string; id: string | null }> = {
  oauth_google: { label: "Google", id: "google" },
  oauth_microsoft: { label: "Microsoft 365", id: "microsoft" },
  password: { label: "servidor propio", id: null },
};

function connectWith(provider: string, onError: (message: string) => void) {
  api
    .oauthStart(provider)
    // Se sale a la página del proveedor; al volver, el buzón ya está conectado.
    .then(({ url }) => window.location.assign(url))
    .catch(() => onError("No se ha podido empezar la conexión. Inténtalo de nuevo."));
}

function AccountState({ account }: { account: Account }) {
  if (account.state === "ok")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
        <Icon name="dot" size={12} className="text-ok" />
        Al día{account.lastSyncAt ? ` · ${since(account.lastSyncAt)}` : ""}
      </span>
    );
  if (account.state === "new")
    return <span className="text-xs whitespace-nowrap text-ink-2">Conectando…</span>;
  return (
    <span
      title={account.lastError ?? undefined}
      className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap"
    >
      <Icon name="triangle" size={13} className="text-flag" />
      {account.state === "auth_error"
        ? "Hay que volver a conectarlo"
        : "Sin conexión con el servidor"}
    </span>
  );
}

function ServerAccountForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    email: "",
    imapHost: "",
    imapPort: "993",
    smtpHost: "",
    smtpPort: "465",
    username: "",
    password: "",
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });
  const create = useMutation({
    mutationFn: (input: NewAccount) => api.createAccount(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({
      ...form,
      username: form.username || form.email,
      imapPort: Number(form.imapPort),
      smtpPort: Number(form.smtpPort),
    });
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-lg border border-line-strong p-4"
      aria-label="Buzón de otro servidor"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Nombre" hint="Cómo se verá en la lista: «Siniestros», «Andrés»…">
          <input required value={form.name} onChange={set("name")} className={settingsField} />
        </Field>
        <Field label="Dirección de correo">
          <input
            required
            type="email"
            value={form.email}
            onChange={set("email")}
            className={settingsField}
          />
        </Field>
        <Field label="Servidor de entrada (IMAP)">
          <span className="flex gap-2">
            <input
              required
              value={form.imapHost}
              onChange={set("imapHost")}
              placeholder="imap.ejemplo.es"
              className={settingsField}
            />
            <input
              aria-label="Puerto IMAP"
              inputMode="numeric"
              value={form.imapPort}
              onChange={set("imapPort")}
              className={`${settingsField} w-20!`}
            />
          </span>
        </Field>
        <Field label="Servidor de salida (SMTP)">
          <span className="flex gap-2">
            <input
              required
              value={form.smtpHost}
              onChange={set("smtpHost")}
              placeholder="smtp.ejemplo.es"
              className={settingsField}
            />
            <input
              aria-label="Puerto SMTP"
              inputMode="numeric"
              value={form.smtpPort}
              onChange={set("smtpPort")}
              className={`${settingsField} w-20!`}
            />
          </span>
        </Field>
        <Field label="Usuario" hint="Si lo dejas vacío, se usa la dirección de correo.">
          <input value={form.username} onChange={set("username")} className={settingsField} />
        </Field>
        <Field label="Contraseña" hint="Se guarda cifrada en el servidor.">
          <input
            required
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set("password")}
            className={settingsField}
          />
        </Field>
      </div>
      {create.isError && (
        <p role="alert" className="m-0 text-xs text-bad-ink">
          {errorText(create.error, "No se ha podido entrar en el buzón con estos datos.")}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="grow text-xs text-ink-2">
          Al guardar se prueba la entrada; si falla, no se guarda nada.
        </span>
        <button type="button" onClick={onClose} className={settingsButton.secondary}>
          Cancelar
        </button>
        <button type="submit" disabled={create.isPending} className={settingsButton.primary}>
          {create.isPending ? "Probando…" : "Conectar"}
        </button>
      </div>
    </form>
  );
}

function Mailboxes({ isAdmin }: { isAdmin: boolean }) {
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const providers = useQuery({
    queryKey: ["oauth-providers"],
    queryFn: api.oauthProviders,
    enabled: isAdmin,
  });
  const [failed, setFailed] = useState("");
  const [serverForm, setServerForm] = useState(false);
  const list = accounts.data ?? [];
  const card =
    "flex min-w-0 flex-1 basis-56 cursor-pointer flex-col gap-1.5 rounded-lg border border-line-strong bg-panel p-3.5 text-left text-ink hover:bg-ground";
  return (
    <>
      {accounts.isSuccess && list.length === 0 ? (
        <p className="m-0 text-ink-2">Todavía no hay ningún buzón conectado.</p>
      ) : (
        <Rows>
          {list.map((account) => {
            const provider = PROVIDER[account.authType];
            return (
              <li
                key={account.id}
                className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 py-2"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ground text-ink-2">
                  <Icon name={account.authType === "password" ? "server" : "cloud"} />
                </span>
                <span className="flex min-w-0 grow basis-60 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <b className="truncate font-semibold">{account.name}</b>
                    <span className="rounded-full border border-line bg-ground px-1.5 text-[11px] font-semibold text-ink-2">
                      {account.shared ? "Compartido" : "Personal"}
                    </span>
                  </span>
                  <span className="truncate text-xs text-ink-2">
                    {account.email} · {provider.label}
                  </span>
                </span>
                <span className="w-56 shrink-0">
                  <AccountState account={account} />
                </span>
                <span className="flex w-40 shrink-0 justify-end">
                  {isAdmin && account.state === "auth_error" && provider.id && (
                    <button
                      type="button"
                      onClick={() => connectWith(provider.id!, setFailed)}
                      className={settingsButton.secondary}
                    >
                      <Icon name="refresh" size={14} />
                      Volver a conectar
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </Rows>
      )}
      {failed && (
        <p role="alert" className="m-0 text-xs text-bad-ink">
          {failed}
        </p>
      )}
      {isAdmin ? (
        <SettingsBlock title="Conectar otro buzón">
          <div className="flex flex-wrap gap-3">
            {providers.data?.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => connectWith(provider.id, setFailed)}
                className={card}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <Icon name="cloud" />
                  {provider.label}
                </span>
                <span className="text-xs leading-normal text-ink-2">
                  {provider.id === "microsoft"
                    ? "Entras en la página de Microsoft. Hace falta «SMTP autenticado» activado en el buzón."
                    : `Entras con tu cuenta en la página de ${provider.label}. Tu contraseña no pasa por aquí.`}
                </span>
              </button>
            ))}
            <button
              type="button"
              aria-expanded={serverForm}
              onClick={() => setServerForm(true)}
              className={card}
            >
              <span className="flex items-center gap-2 font-semibold">
                <Icon name="server" />
                Otro servidor
              </span>
              <span className="text-xs leading-normal text-ink-2">
                Cualquier proveedor con IMAP y SMTP: servidor, usuario y contraseña.
              </span>
            </button>
          </div>
          {serverForm && <ServerAccountForm onClose={() => setServerForm(false)} />}
          <p className="m-0 text-xs text-ink-2">
            Quien conecta un buzón lo ve desde ese momento. Para compartirlo con otra persona, de
            momento hay que dar el permiso por consola.
          </p>
        </SettingsBlock>
      ) : (
        <p className="m-0 text-xs text-ink-2">
          Los buzones los conecta quien administra. Si te falta alguno, pídeselo.
        </p>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Lectura de documentos

const STATUS: Record<string, { label: string; why: string }> = {
  ok: { label: "Con su texto leído", why: "Se pueden buscar y sirven de contexto." },
  empty: { label: "Sin texto dentro", why: "Ficheros vacíos o sin nada que leer." },
  pending: { label: "En cola, leyéndose", why: "Se leen en orden de llegada." },
  needs_ocr: {
    label: "Imágenes y escaneados sin leer",
    why: "Los lee el reconocimiento de texto, si está activo.",
  },
  no_text_image: {
    label: "Fotos y dibujos sin texto",
    why: "Solo se pueden anotar: alguien dice qué contienen.",
  },
  unsupported: {
    label: "Ficheros que no se saben leer",
    why: "TIFF, HEIC y formatos raros. Se abren y se anotan a mano.",
  },
  failed: { label: "Han dado error al leerlos", why: "Ficheros dañados o protegidos." },
};
const ORDER = ["ok", "pending", "needs_ocr", "no_text_image", "unsupported", "failed", "empty"];

function Documents({ isAdmin }: { isAdmin: boolean }) {
  const summary = useQuery({
    queryKey: ["processing"],
    queryFn: api.processing,
    refetchInterval: 10_000,
  });
  const modules = useQuery({ queryKey: ["modules"], queryFn: api.modules });
  const data = summary.data;
  const documents = [...(data?.documents ?? [])].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );
  const total = documents.reduce((sum, row) => sum + row.documents, 0);
  const read = documents.find((row) => row.status === "ok")?.documents ?? 0;
  const ocr = modules.data?.find((module) => module.id === "ocr");
  const extra = plugins.filter((plugin) => plugin.DocumentsSection);
  return (
    <>
      {summary.isError && (
        <p role="alert" className="m-0 text-xs text-ink-2">
          No se ha podido consultar el estado.
        </p>
      )}
      {data && (
        <dl className="m-0 grid grid-cols-2 gap-y-4 sm:grid-cols-4">
          {[
            [data.messages, "correos"],
            [total, "adjuntos distintos"],
            [read, "adjuntos leídos"],
            [data.incomplete, "correos con algo sin leer"],
          ].map(([value, label]) => (
            <div
              key={label}
              className="flex flex-col gap-0.5 border-l border-line pl-4 first:border-l-0 first:pl-0"
            >
              <dd className="m-0 text-[22px] font-semibold tabular-nums">
                {number(value as number)}
              </dd>
              <dt className="text-xs text-ink-2">{label}</dt>
            </div>
          ))}
        </dl>
      )}
      {data && (
        <SettingsBlock
          title="Adjuntos por estado"
          description="En cada carpeta, el filtro «Sin procesar» enseña los correos a los que les falta algo."
        >
          <Rows>
            {documents.map((row) => (
              <li key={row.status} className="flex min-h-12 items-center gap-4 py-1.5">
                <span className="flex min-w-0 grow flex-col gap-0.5">
                  <b className="font-semibold">{STATUS[row.status]?.label ?? row.status}</b>
                  <span className="text-xs text-ink-2">
                    {STATUS[row.status]?.why}
                    {row.noted > 0 && ` ${number(row.noted)} con nota de una persona.`}
                  </span>
                </span>
                <span className="w-16 text-right font-semibold tabular-nums">
                  {number(row.documents)}
                </span>
              </li>
            ))}
            {documents.length === 0 && (
              <li className="py-2 text-xs text-ink-2">Todavía no ha llegado ningún adjunto.</li>
            )}
          </Rows>
        </SettingsBlock>
      )}
      {ocr && (
        <SettingsBlock title="Reconocimiento de texto" description={ocr.description}>
          <span className="inline-flex items-center gap-1.5 text-xs">
            {ocr.active ? (
              <>
                <Icon name="dot" size={12} className="text-ok" />
                Activo, dentro del servidor
              </>
            ) : (
              <span className="text-ink-2">Sin activar</span>
            )}
          </span>
        </SettingsBlock>
      )}
      {extra.map(
        (plugin) =>
          plugin.DocumentsSection && <plugin.DocumentsSection key={plugin.id} isAdmin={isAdmin} />,
      )}
    </>
  );
}

// ------------------------------------------------------------------ Módulos

function Modules() {
  const modules = useQuery({ queryKey: ["modules"], queryFn: api.modules });
  return (
    <>
      {modules.isError && (
        <p role="alert" className="m-0 text-xs text-ink-2">
          No se ha podido consultar qué módulos hay.
        </p>
      )}
      <Rows>
        {modules.data?.map((module) => (
          <li key={module.id} className="flex min-h-16 items-center gap-4 py-2">
            <span className="flex min-w-0 grow flex-col gap-0.5">
              <b className="font-semibold">{module.name}</b>
              <span className="text-xs leading-normal text-ink-2">{module.description}</span>
            </span>
            <span className="inline-flex w-28 shrink-0 items-center justify-end gap-1.5 text-xs whitespace-nowrap">
              {module.active ? (
                <>
                  <Icon name="dot" size={12} className="text-ok" />
                  Activo
                </>
              ) : (
                <span className="text-ink-2">Sin activar</span>
              )}
            </span>
          </li>
        ))}
        {modules.data?.length === 0 && (
          <li className="py-2 text-xs text-ink-2">Esta instalación no tiene módulos.</li>
        )}
      </Rows>
      <p className="m-0 text-xs leading-normal text-ink-2">
        Los módulos los activa quien instala el servidor. Si uno no está activo, sus pantallas y
        botones no aparecen.
      </p>
    </>
  );
}

// ------------------------------------------------------------------ página

const CORE: SettingsPage[] = [
  {
    id: "buzones",
    group: "Correo",
    label: "Buzones",
    description:
      "Los buzones que lees desde aquí. Si uno deja de sincronizar, lo verás en esta lista.",
    Component: Mailboxes,
  },
  {
    id: "documentos",
    group: "Correo",
    label: "Lectura de documentos",
    description: "Cuánto de lo que llega está leído y se puede buscar.",
    adminOnly: true,
    wide: true,
    Component: Documents,
  },
  {
    id: "modulos",
    group: "Instalación",
    label: "Módulos",
    description:
      "De serie es un cliente de correo con contexto. Los módulos añaden funciones encima.",
    adminOnly: true,
    Component: Modules,
  },
];

/** Todos los apartados, en el orden de sus grupos. */
export function settingsPages(): SettingsPage[] {
  const all = [...CORE, ...plugins.flatMap((plugin) => plugin.settings ?? [])];
  return SETTINGS_GROUPS.flatMap((group) => all.filter((page) => page.group === group));
}

export function SettingsView({ isAdmin }: { isAdmin: boolean }) {
  const { sub } = useUrlState();
  const { layout } = useLayout();
  const phone = layout === "phone";
  const pages = settingsPages();
  const current = pages.find((page) => page.id === sub) ?? (phone ? undefined : pages[0]);
  const go = (id: string | null) => navigate({ sub: id });

  const menu = (
    <nav
      aria-label="Apartados de configuración"
      className={`flex shrink-0 flex-col gap-0.5 overflow-y-auto ${phone ? "w-full" : "w-[232px] border-r border-line bg-ground px-3 py-5"}`}
    >
      <h1
        className={`m-0 text-lg font-semibold tracking-[-0.01em] ${phone ? "px-4 pt-4" : "px-2.5 pb-2"}`}
      >
        Configuración
      </h1>
      {SETTINGS_GROUPS.map((group) => {
        const entries = pages.filter((page) => page.group === group);
        if (entries.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-0.5">
            <span
              className={`text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase ${phone ? "px-4 pt-4 pb-1.5" : "px-2.5 pt-3.5 pb-1"}`}
            >
              {group}
            </span>
            {entries.map((page) => {
              const on = page.id === current?.id;
              return (
                <button
                  key={page.id}
                  type="button"
                  aria-current={on ? "page" : undefined}
                  onClick={() => go(page.id)}
                  className={
                    phone
                      ? "flex h-12 items-center border-0 border-b border-line-soft bg-transparent px-4 text-left text-ink"
                      : `flex h-[34px] items-center gap-2 rounded-md border-0 px-2.5 text-left ${on ? "bg-accent-soft font-semibold text-accent-strong" : "bg-transparent text-ink hover:bg-line-soft"}`
                  }
                >
                  <span className="grow">{page.label}</span>
                  {page.adminOnly && !isAdmin && (
                    <Icon
                      name="lock"
                      size={12}
                      label="Solo lo cambia un administrador"
                      className="text-ink-2"
                    />
                  )}
                  {phone && <Icon name="right" size={14} className="text-ink-2" />}
                </button>
              );
            })}
          </div>
        );
      })}
      {!isAdmin && !phone && (
        <p className="m-0 mt-auto flex gap-1.5 px-2.5 pt-4 text-xs leading-normal text-ink-2">
          <Icon name="lock" size={12} className="mt-0.5 shrink-0" />
          Lo puedes consultar; lo cambia quien administra.
        </p>
      )}
    </nav>
  );

  if (phone && !current) {
    return <main className="flex min-w-0 grow flex-col overflow-y-auto bg-panel">{menu}</main>;
  }
  return (
    <main className="flex min-w-0 grow bg-panel">
      {!phone && menu}
      {current && (
        <div className="flex min-w-0 grow flex-col overflow-y-auto">
          <div
            className={`flex w-full flex-col gap-7 px-4 pt-6 pb-8 md:px-8 ${current.wide ? "" : "max-w-[864px]"}`}
          >
            <header className="flex flex-col gap-1">
              {phone && (
                <button
                  type="button"
                  onClick={() => go(null)}
                  className={`${settingsButton.link} mb-2 inline-flex items-center gap-1 self-start`}
                >
                  <Icon name="back" size={14} />
                  Configuración
                </button>
              )}
              <h2 className="m-0 text-xl font-semibold tracking-[-0.01em]">{current.label}</h2>
              <p className="m-0 max-w-[640px] text-[13px] leading-normal text-ink-2">
                {current.description}
              </p>
            </header>
            <current.Component isAdmin={isAdmin} />
          </div>
        </div>
      )}
    </main>
  );
}
