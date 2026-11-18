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
  /** Si se ha podido leer su texto. `null`: aún no se ha intentado. */
  textStatus: "pending" | "ok" | "needs_ocr" | "empty" | "unsupported" | "failed" | null;
  textChars: number | null;
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
  /** Lo que este correo aporta de nuevo, sin historial citado ni firma. */
  bodyClean: string | null;
  replyTo: Address[];
  bcc: Address[];
  direction: "in" | "out" | null;
  autoReply: boolean;
  priority: "high" | "low" | null;
  bodyPending: boolean;
  hasAttachments: boolean | null;
  removedFromServerAt: string | null;
  /** Borrador escrito aquí por este usuario: se puede seguir editando. */
  draftId: string | null;
  locations: {
    folderId: string;
    path: string;
    specialUse: string | null;
    flags: string[];
    uid: number;
  }[];
  attachments: Attachment[];
};

export type OutboundKind = "new" | "reply" | "replyAll" | "forward";
export type OutboundFile = { id: string; filename: string; contentType: string; size: number };
export type Outbound = {
  id: string;
  accountId: string;
  kind: OutboundKind;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyHtml: string;
  state: "draft" | "queued" | "sending" | "sent" | "failed";
  error: string | null;
  sendAfter: string | null;
  draftSavedAt: string | null;
  updatedAt: string;
  attachments: OutboundFile[];
};
export type OutboundFields = Pick<Outbound, "to" | "cc" | "bcc" | "subject" | "bodyHtml">;
export type OutboxItem = {
  id: string;
  subject: string;
  to: Address[];
  state: Outbound["state"];
  error: string | null;
  sendAfter: string | null;
  updatedAt: string;
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

/** Texto leído de un adjunto, página a página. */
export type AttachmentText = {
  status: string;
  pagesNeedingOcr: number;
  error: string | null;
  pages: { page: number; label: string | null; text: string; method: string }[];
};

/** Dato de negocio ligado a un correo, con su origen. */
export type MessageFact = {
  id: string;
  kind: string;
  value: string;
  source: string | null;
  evidence: string | null;
  method: "rule" | "model" | "user" | "system";
  extractor: string;
  confidence: number | null;
  confirmed: boolean;
};

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
  /** La coincidencia está dentro de un adjunto. */
  attachmentHit: {
    filename: string | null;
    page: number;
    label: string | null;
    pages: number;
    headline: string;
  } | null;
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
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
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

/** Para los plugins: llamadas a sus propias rutas con la sesión y el token de siempre. */
export const apiGet = <T>(path: string) => request<T>(path);
export const apiPost = post;
export const apiPut = <T>(path: string, body: object) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const apiDelete = <T>(path: string) => request<T>(path, { method: "DELETE" });

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
  createOutbound: (accountId: string, kind: OutboundKind, sourceMessageId?: string) =>
    post<{ outbound: Outbound }>("/outbound", { accountId, kind, sourceMessageId }).then(
      (data) => data.outbound,
    ),
  outbound: (id: string) =>
    request<{ outbound: Outbound }>(`/outbound/${id}`).then((data) => data.outbound),
  saveOutbound: (id: string, fields: OutboundFields) =>
    request<{ outbound: Outbound }>(`/outbound/${id}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    }).then((data) => data.outbound),
  discardOutbound: (id: string) => request<{ ok: true }>(`/outbound/${id}`, { method: "DELETE" }),
  attach: (id: string, file: File) =>
    request<{ attachment: OutboundFile }>(
      `/outbound/${id}/attachments?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        body: file,
        headers: {
          "content-type": "application/octet-stream",
          "x-file-type": file.type || "application/octet-stream",
        },
      },
    ).then((data) => data.attachment),
  detach: (id: string, fileId: string) =>
    request<{ ok: true }>(`/outbound/${id}/attachments/${fileId}`, { method: "DELETE" }),
  send: (id: string) => post<{ outbound: Outbound; undoMs: number }>(`/outbound/${id}/send`, {}),
  cancelSend: (id: string) => post<{ outbound: Outbound }>(`/outbound/${id}/cancel`, {}),
  outbox: (accountId: string) =>
    request<{ items: OutboxItem[] }>(`/accounts/${accountId}/outbox`).then((data) => data.items),
  signature: (accountId: string) =>
    request<{ signature: string }>(`/accounts/${accountId}/identity`).then(
      (data) => data.signature,
    ),
  saveSignature: (accountId: string, signature: string) =>
    request<{ signature: string }>(`/accounts/${accountId}/identity`, {
      method: "PUT",
      body: JSON.stringify({ signature }),
    }),
  oauthProviders: () =>
    request<{ providers: { id: string; label: string }[] }>("/admin/oauth/providers").then(
      (data) => data.providers,
    ),
  oauthComplete: (params: { state?: string; code?: string; error?: string }) =>
    post<{ email: string }>("/admin/oauth/complete", params),
  oauthStart: (provider: string) => post<{ url: string }>(`/admin/oauth/${provider}/start`, {}),
  undo: (actionId: string) => post<ActionReply>(`/actions/${actionId}/undo`, {}),
  attachmentText: (id: string) => request<AttachmentText>(`/attachments/${id}/text`),
  facts: (id: string) =>
    request<{ facts: MessageFact[] }>(`/messages/${id}/facts`).then((data) => data.facts),
  thread: (id: string) =>
    request<{ messages: ThreadMessage[] }>(`/threads/${id}`).then((data) => data.messages),
  search: (filters: SearchFilters) => {
    const params = new URLSearchParams({ q: filters.q, limit: "100" });
    // Persona o dominio en cualquier papel: remitente, destinatario o copia.
    if (filters.from) params.set("with", filters.from);
    if (filters.since) params.set("since", filters.since);
    if (filters.until) params.set("until", filters.until);
    if (filters.attachments) params.set("attachments", "1");
    if (!filters.archive) params.set("archive", "0");
    return request<SearchResult>(`/search?${params.toString()}`);
  },
};

export const attachmentUrl = (id: string) => `/api/attachments/${id}`;
