import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Account, type Folder } from "../api.ts";
import { folderRows } from "../folders.ts";
import { navigate, useUrlState, type View } from "../url-state.ts";
import { folderIcon, Icon, type IconName } from "./Icon.tsx";

function RailButton({
  icon,
  label,
  view,
  current,
}: {
  icon: IconName;
  label: string;
  view: View;
  current: View;
}) {
  const active = current === view || (view === "mail" && current === "search");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      onClick={() => navigate({ view, messageId: null })}
      className={`flex h-11 w-10 items-center justify-center rounded-md border-0 ${
        active ? "bg-rail-active text-white" : "bg-transparent text-rail-ink hover:bg-rail-active"
      }`}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

/** Riel de módulos. Debajo de Archivo queda sitio para una entrada por plugin. */
export function Rail() {
  const { view } = useUrlState();
  return (
    <nav
      aria-label="Módulos"
      className="flex w-12 shrink-0 flex-col items-center gap-1 bg-rail py-2"
    >
      <RailButton icon="mail" label="Correo" view="mail" current={view} />
      <RailButton icon="archive" label="Archivo" view="archive" current={view} />
    </nav>
  );
}

function FolderLink({
  folder,
  name,
  depth,
  accountId,
  selected,
}: {
  folder: Folder;
  name: string;
  depth: number;
  accountId: string;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={() => navigate({ view: "mail", accountId, folderId: folder.id, messageId: null })}
      style={{ paddingLeft: 8 + depth * 20 }}
      className={`flex h-[30px] w-full items-center gap-2 rounded-md border-0 pr-2 text-left ${
        selected
          ? "bg-accent-soft font-semibold text-accent-strong"
          : "bg-transparent text-ink hover:bg-line-soft"
      }`}
    >
      <Icon name={folderIcon(folder.specialUse)} className={selected ? "" : "text-ink-2"} />
      <span className="min-w-0 grow truncate">{name}</span>
      {folder.unread > 0 && (
        <span className={`text-xs ${selected ? "" : "text-ink-2"}`}>{folder.unread}</span>
      )}
    </button>
  );
}

function AccountFolders({
  account,
  open,
  onToggle,
}: {
  account: Account;
  open: boolean;
  onToggle: () => void;
}) {
  const url = useUrlState();
  const { data: folders, isError } = useQuery({
    queryKey: ["folders", account.id],
    queryFn: () => api.folders(account.id),
  });
  const unread = folders?.find((folder) => folder.specialUse === "inbox")?.unread ?? 0;

  return (
    <section className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-left hover:bg-line-soft"
      >
        <Icon name={open ? "down" : "right"} size={12} className="text-ink-2" />
        <span className="min-w-0 grow">
          <span className="block truncate text-xs font-semibold">{account.name}</span>
          <span className="block truncate text-[11px] text-ink-2">
            {open || unread === 0 ? account.email : `${unread} sin leer`}
          </span>
        </span>
      </button>
      {open && isError && (
        <p className="m-0 px-2 py-1 text-xs text-ink-2">No se han podido cargar las carpetas.</p>
      )}
      {open &&
        folderRows(folders ?? []).map((row) => (
          <FolderLink
            key={row.folder.id}
            folder={row.folder}
            name={row.name}
            depth={row.depth}
            accountId={account.id}
            selected={url.view === "mail" && url.folderId === row.folder.id}
          />
        ))}
    </section>
  );
}

/** Panel de carpetas: un bloque por buzón, plegable. */
export function FolderPanel({ accounts }: { accounts: Account[] }) {
  const url = useUrlState();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const { data: currentFolders } = useQuery({
    queryKey: ["folders", url.accountId],
    queryFn: () => api.folders(url.accountId!),
    enabled: Boolean(url.accountId),
  });
  const historyPending = currentFolders?.some((folder) => folder.historyPending);

  return (
    <nav
      aria-label="Carpetas"
      className="flex w-52 shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-line bg-ground px-2 py-3"
    >
      {accounts.map((account) => (
        <AccountFolders
          key={account.id}
          account={account}
          open={!closed.has(account.id)}
          onToggle={() => toggle(account.id)}
        />
      ))}
      {accounts.length === 0 && (
        <p className="m-0 px-2 text-xs leading-normal text-ink-2">
          Todavía no tienes ningún buzón asignado. Pídeselo a tu administrador.
        </p>
      )}
      <div className="grow" />
      {historyPending && (
        <p className="m-0 border-t border-line px-2 pt-2 text-[11px] leading-[1.45] text-ink-2">
          Trayendo el histórico de este buzón. Ya puedes trabajar.
        </p>
      )}
    </nav>
  );
}
