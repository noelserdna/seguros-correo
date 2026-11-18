/** Cliente de la API del servidor. Todo va por el mismo origen, con la cookie de sesión. */

export type User = { id: string; email: string; name: string; role: "admin" | "user" };
export type Session = { user: User; csrfToken: string };

export type AccountState = "new" | "ok" | "auth_error" | "offline";
export type Account = {
  id: string;
  name: string;
  email: string;
  state: AccountState;
  lastError: string | null;
  lastSyncAt: string | null;
};

export type Folder = {
  id: string;
  path: string;
  delimiter: string;
  specialUse: string | null;
  historyPending: boolean;
  total: number;
  unread: number;
};

export type Address = { name: string; address: string };

export type MessageItem = {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: string;
  snippet: string | null;
  hasAttachments: boolean | null;
  flags: string[];
  removedFromServerAt?: string | null;
};
export type MessagePage = { items: MessageItem[]; nextCursor: string | null };

export type Attachment = {
  id: string;
  filename: string | null;
  contentType: string;
  size: number;
  inline: boolean;
};
export type MessageDetail = {
  id: string;
  accountId: string;
  threadId: string;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  date: string | null;
  internalDate: string;
  bodyText: string | null;
  bodyPending: boolean;
  hasAttachments: boolean | null;
  removedFromServerAt: string | null;
  locations: {
    folderId: string;
    path: string;
    specialUse: string | null;
    flags: string[];
    uid: number;
  }[];
  attachments: Attachment[];
};

export type MessageLocation = MessageDetail["locations"][number];
export type UserFlag = "\\Seen" | "\\Flagged";
export type QueuedAction = {
  id: string;
  type: "flags" | "move" | "expunge";
  state: string;
  undoable: boolean;
  targetFolderId: string | null;
};
type ActionReply = { action: QueuedAction | null };

export type ThreadMessage = {
  id: string;
  messageIdHeader: string | null;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: string;
  snippet: string | null;
  removedFromServerAt: string | null;
};

export type RenderedBody = { pending: boolean; html: string; blockedImages: number };

export type SearchHit = {
  id: string;
  accountId: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  internalDate: string;
  hasAttachments: boolean | null;
  removedFromServerAt: string | null;
  headline: string;
  location: string | null;
  locationUse: string | null;
};
export type SearchResult = {
  items: SearchHit[];
  truncated: boolean;
  marks?: { start: string; end: string };
};

export type SearchFilters = {
  q: string;
  from: string;
  since: string;
  until: string;
  attachments: boolean;
  archive: boolean;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken = "";
export const setCsrfToken = (token: string) => {
  csrfToken = token;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (method !== "GET") headers.set("x-csrf-token", csrfToken);

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "No hay conexión con el servidor de la oficina.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(
      response.status,
      body?.error ?? "error",
      body?.message ?? "Algo ha fallado. Inténtalo de nuevo.",
    );
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body: object) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  session: () => request<Session>("/auth/session"),
  login: (email: string, password: string) =>
    request<Session>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),

  accounts: () => request<{ accounts: Account[] }>("/accounts").then((data) => data.accounts),
  folders: (accountId: string) =>
    request<{ folders: Folder[] }>(`/accounts/${accountId}/folders`).then((data) => data.folders),
  messages: (folderId: string, before?: string | null) =>
    request<MessagePage>(
      `/folders/${folderId}/messages?limit=60${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  archive: (accountId: string, before?: string | null) =>
    request<MessagePage>(
      `/accounts/${accountId}/archive?limit=60${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  message: (id: string) =>
    request<{ message: MessageDetail }>(`/messages/${id}`).then((data) => data.message),
  body: (id: string, images: boolean) =>
    request<RenderedBody>(`/messages/${id}/html?images=${images ? "1" : "0"}`),
  setFlags: (id: string, folderId: string, add: UserFlag[], remove: UserFlag[]) =>
    post<ActionReply>(`/messages/${id}/flags`, { folderId, add, remove }),
  move: (id: string, folderId: string, targetFolderId: string) =>
    post<ActionReply>(`/messages/${id}/move`, { folderId, targetFolderId }),
  remove: (id: string, folderId: string, permanent: boolean) =>
    post<ActionReply>(`/messages/${id}/delete`, { folderId, permanent }),
  undo: (actionId: string) => post<ActionReply>(`/actions/${actionId}/undo`, {}),
  thread: (id: string) =>
    request<{ messages: ThreadMessage[] }>(`/threads/${id}`).then((data) => data.messages),
  search: (filters: SearchFilters) => {
    const params = new URLSearchParams({ q: filters.q, limit: "100" });
    if (filters.from) params.set("from", filters.from);
    if (filters.since) params.set("since", filters.since);
    if (filters.until) params.set("until", filters.until);
    if (filters.attachments) params.set("attachments", "1");
    if (!filters.archive) params.set("archive", "0");
    return request<SearchResult>(`/search?${params.toString()}`);
  },
};

export const attachmentUrl = (id: string) => `/api/attachments/${id}`;
