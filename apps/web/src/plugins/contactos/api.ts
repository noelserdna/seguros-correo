/** La agenda de contactos: tipos, llamadas y textos que comparten sus pantallas. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "../../api.ts";

export const BASE = "/plugins/contactos";
export const KEY = ["plugins", "contactos"];

export type Channel = {
  id: string;
  kind: "email" | "phone";
  value: string;
  label: string | null;
  source: string;
  sourceMessageId: string | null;
  seen?: number;
  since?: string | null;
};

export type ContactRow = {
  id: string;
  kind: "persona" | "empresa";
  name: string;
  companyId: string | null;
  companyName: string | null;
  notes: string | null;
  archived: boolean;
  roles: string[];
  channels: Channel[];
  email: string | null;
  phone: string | null;
  openCases: number;
};

export type Activity = {
  id: string;
  accountId: string;
  subject: string;
  preview: string;
  at: string;
  whatsapp: boolean;
  files: number;
  cases: string[];
};

export type Detail = {
  contact: ContactRow;
  members: { id: string; name: string }[];
  cases: { id: string; number: string; title: string; status: string; role: string | null }[];
  activity: Activity[];
};

export type Suggestion =
  | {
      kind: "nuevo";
      key: string;
      address: string;
      name: string;
      whatsapp: boolean;
      count: number;
      cases: number;
      subject: string;
      messageId: string;
      guess: string | null;
    }
  | {
      kind: "duplicado";
      key: string;
      contact: { id: string; name: string; detail: string };
      other: { address: string; name: string; whatsapp: boolean };
      reason: string;
      messageId: string | null;
    };

export type ContactInput = {
  kind: "persona" | "empresa";
  name: string;
  companyId: string | null;
  notes: string | null;
  roles: string[];
  channels: {
    kind: "email" | "phone";
    value: string;
    label: string | null;
    sourceMessageId?: string | null;
  }[];
};

export const ROLES = [
  { id: "cliente", label: "Cliente", plural: "Clientes" },
  { id: "aseguradora", label: "Aseguradora", plural: "Aseguradoras" },
  { id: "perito", label: "Perito", plural: "Peritos" },
  { id: "taller", label: "Taller", plural: "Talleres" },
  { id: "abogado", label: "Abogado", plural: "Abogados" },
  { id: "policia", label: "Policía o juzgado", plural: "Policía y juzgados" },
  { id: "medico", label: "Médico", plural: "Médicos" },
  { id: "grua", label: "Grúa", plural: "Grúas" },
  { id: "otro", label: "Otro", plural: "Otros" },
];
export const roleLabel = (id: string) => ROLES.find((role) => role.id === id)?.label ?? id;

/** «+34 600 111 222» a partir de «34600111222». */
export function formatPhone(value: string): string {
  if (value.startsWith("34") && value.length === 11) {
    return `+34 ${value.slice(2, 5)} ${value.slice(5, 8)} ${value.slice(8)}`;
  }
  return value.length > 9 ? `+${value}` : value;
}

/** De una dirección de correo, el canal: correo, o teléfono si es de WhatsApp. */
export function channelOfAddress(address: string): { kind: "email" | "phone"; value: string } {
  const email = address.trim().toLowerCase();
  const [local, domain] = email.split("@");
  return domain === "whatsapp.invalid" && local
    ? { kind: "phone", value: local.replace(/\D/g, "") }
    : { kind: "email", value: email };
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((part) => /^\p{L}/u.test(part))
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

export const contactos = {
  create: (body: ContactInput) => apiPost<Detail>(`${BASE}/contacts`, body),
  update: (id: string, body: ContactInput) => apiPut<Detail>(`${BASE}/contacts/${id}`, body),
  addChannel: (
    id: string,
    body: { kind: "email" | "phone"; value: string; sourceMessageId?: string | null },
  ) => apiPost<Detail>(`${BASE}/contacts/${id}/channels`, body),
  archive: (id: string, archived: boolean) =>
    apiPost<Detail>(`${BASE}/contacts/${id}/archive`, { archived }),
  merge: (keepId: string, dropId: string) => apiPost<Detail>(`${BASE}/merge`, { keepId, dropId }),
  dismiss: (kind: "nuevo" | "duplicado", key: string) =>
    apiPost(`${BASE}/review/dismiss`, { kind, key }),
  setClient: (caseId: string, contactId: string | null) =>
    apiPut(`${BASE}/cases/${caseId}/client`, { contactId }),
};

export const useContactSearch = (q: string, role?: string, enabled = true) =>
  useQuery({
    queryKey: [...KEY, "list", q, role ?? ""],
    queryFn: () =>
      apiGet<{ contacts: ContactRow[]; counts: Record<string, number>; total: number }>(
        `${BASE}/contacts?${new URLSearchParams({ ...(q ? { q } : {}), ...(role ? { role } : {}) })}`,
      ),
    enabled,
    placeholderData: (previous) => previous,
  });

export const useReview = () =>
  useQuery({
    queryKey: [...KEY, "review"],
    queryFn: () => apiGet<{ suggestions: Suggestion[] }>(`${BASE}/review`),
  });

/** Tras cualquier cambio en la agenda, se refresca todo lo que la enseña. */
export function useRefreshContacts() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: KEY });
    void queryClient.invalidateQueries({ queryKey: ["plugins", "tramitacion"] });
  };
}
