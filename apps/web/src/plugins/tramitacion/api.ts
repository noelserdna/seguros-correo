/** Tipos y llamadas del módulo de tramitación. Reflejan lo que devuelve el servidor. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPatch, apiPost, apiPut } from "../../api.ts";

export const BASE = "/plugins/tramitacion";
export const KEY = ["plugins", "tramitacion"] as const;

export type DerivedState = "hecha" | "omitida" | "bloqueada" | "esperando" | "en_curso" | "lista";
export type HealthLevel = "cerrado" | "sin_plan" | "vencidas" | "parado" | "riesgo" | "al_dia";
export type PhaseState = "hecha" | "actual" | "retraso" | "proxima";
export type Health = { level: HealthLevel; reasons: string[]; lateCount: number; idleDays: number };

export type NextStep =
  | {
      kind: "tarea";
      taskId: string;
      name: string;
      due: string | null;
      late: boolean;
      legal: boolean;
    }
  | {
      kind: "esperar";
      taskId: string;
      name: string;
      waitingOn: string | null;
      chaseAt: string | null;
    }
  | { kind: "desbloquear"; taskId: string; name: string; blockers: string[] }
  | { kind: "cerrar" }
  | { kind: "sin_plan" };

export type Task = {
  id: string;
  key: string | null;
  phaseId: string;
  position: number;
  name: string;
  description: string | null;
  status: "pendiente" | "en_curso" | "esperando" | "hecha" | "omitida";
  state: DerivedState;
  blockers: string[];
  dependsOn: string[];
  due: string | null;
  lateDays: number;
  dueSoon: boolean;
  chaseDue: boolean;
  legalRef: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  waitingOn: string | null;
  waitingContactId: string | null;
  waitingClient: boolean;
  waitsOnRole: string | null;
  waitingSince: string | null;
  chaseAt: string | null;
  chaseCount: number;
  chaseDays: number | null;
  doneAt: string | null;
  evidenceMessageId: string | null;
  dueOverride: string | null;
};

export type CaseInfo = {
  id: string;
  accountId: string;
  number: string;
  title: string;
  createdAt: string;
  insurerName: string | null;
  typeName: string | null;
  status: "abierto" | "cerrado";
  closedAt: string | null;
  closeReason: string | null;
  ownerId: string | null;
  ownerName: string | null;
  lossDate: string | null;
  claimRef: string | null;
};

export type CaseView = {
  case: CaseInfo;
  plan: { templateName: string | null; appliedAt: string } | null;
  today: string;
  phases: { id: string; position: number; name: string; state: PhaseState }[];
  tasks: Task[];
  nextStep: NextStep;
  health: Health;
  currentPhase: string | null;
  parties: {
    contactId: string;
    role: string;
    reference: string | null;
    name: string;
    email: string | null;
    phone: string | null;
  }[];
  history: {
    id: string;
    at: string;
    kind: string;
    detail: Record<string, string | number | boolean | null>;
    taskName: string | null;
    userName: string | null;
  }[];
};

export type PortfolioRow = {
  case: CaseInfo;
  health: Health;
  nextStep: NextStep;
  currentPhase: string | null;
  phases: { name: string; state: PhaseState }[];
  waiting: { who: string | null; client: boolean; days: number; chaseDue: boolean } | null;
  nextDue: { name: string; due: string; lateDays: number; dueSoon: boolean; legal: boolean } | null;
};
export type Portfolio = {
  today: string;
  total: number;
  counts: Record<string, number>;
  cases: PortfolioRow[];
};

export type MyTask = {
  taskId: string;
  name: string;
  state: DerivedState;
  due: string | null;
  lateDays: number;
  dueSoon: boolean;
  legal: boolean;
  waitingOn: string | null;
  waitingDays: number | null;
  chaseAt: string | null;
  chaseDue: boolean;
  case: { id: string; number: string; title: string };
};
export type MyTasks = {
  today: string;
  groups: Record<"vencidas" | "hoy" | "semana" | "despues" | "esperando", MyTask[]>;
};

export type Contact = {
  id: string;
  role: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  active: boolean;
  openCases: number;
};
export type TemplateSummary = {
  id: string;
  name: string;
  active: boolean;
  caseTypeId: string | null;
  typeName: string | null;
  phases: number;
  tasks: number;
};
export type TemplateTask = {
  key: string;
  name: string;
  description?: string | null;
  ownerRule?: "gestor" | null;
  waitsOnRole?: string | null;
  after?: string[];
  dueAnchor?: "apertura" | "siniestro" | "lista";
  dueDays?: number | null;
  dueUnit?: "naturales" | "habiles";
  chaseDays?: number | null;
  legalRef?: string | null;
  optional?: boolean;
};
export type TemplateTree = {
  id?: string;
  name: string;
  caseTypeId: string | null;
  active: boolean;
  phases: { name: string; tasks: TemplateTask[] }[];
};

export type ByMessage = {
  cases: {
    case: CaseInfo;
    health: Health;
    nextStep: NextStep;
    currentPhase: string | null;
    phases: { name: string; state: PhaseState }[];
    awaited: { taskId: string; taskName: string; who: string | null; days: number } | null;
  }[];
};

export const CONTACT_ROLES: { id: string; label: string; plural: string }[] = [
  { id: "aseguradora", label: "Aseguradora", plural: "Aseguradoras" },
  { id: "perito", label: "Perito", plural: "Peritos" },
  { id: "taller", label: "Taller", plural: "Talleres" },
  { id: "abogado", label: "Abogado", plural: "Abogados" },
  { id: "policia", label: "Policía o juzgado", plural: "Policía y juzgados" },
  { id: "medico", label: "Médico", plural: "Médicos" },
  { id: "grua", label: "Grúa", plural: "Grúas" },
  { id: "otro", label: "Otro", plural: "Otros" },
];
export const PARTY_ROLES = [
  ...CONTACT_ROLES,
  {
    id: "aseguradora_contraria",
    label: "Aseguradora contraria",
    plural: "Aseguradoras contrarias",
  },
  { id: "cliente", label: "Cliente", plural: "Clientes" },
];
export const roleLabel = (id: string | null) =>
  PARTY_ROLES.find((role) => role.id === id)?.label ?? id ?? "";

export const caseKey = (id: string) => [...KEY, "case", id];

export const useCase = (id: string) =>
  useQuery({ queryKey: caseKey(id), queryFn: () => apiGet<CaseView>(`${BASE}/cases/${id}`) });

/** Tras cambiar algo: el servidor devuelve el expediente ya calculado y se refresca lo demás. */
export function useApplyView() {
  const queryClient = useQueryClient();
  return (view: CaseView) => {
    queryClient.setQueryData(caseKey(view.case.id), view);
    void queryClient.invalidateQueries({ queryKey: [...KEY, "portfolio"] });
    void queryClient.invalidateQueries({ queryKey: [...KEY, "my-tasks"] });
    void queryClient.invalidateQueries({ queryKey: [...KEY, "by-message"] });
  };
}

export const tramitacion = {
  patchTask: (id: string, body: object) => apiPatch<CaseView>(`${BASE}/tasks/${id}`, body),
  evidence: (id: string, messageId: string, complete: boolean) =>
    apiPost<CaseView>(`${BASE}/tasks/${id}/evidence`, { messageId, complete }),
  chaseDraft: (id: string) =>
    apiPost<{ draft: { accountId: string; to: string | null; subject: string; text: string } }>(
      `${BASE}/tasks/${id}/chase`,
      {},
    ),
  chaseLink: (id: string, outboundId: string) =>
    apiPost<{ ok: true }>(`${BASE}/tasks/${id}/chase-link`, { outboundId }),
  chased: (id: string) => apiPost<CaseView>(`${BASE}/tasks/${id}/chased`, {}),
  close: (id: string, reason: string, force: boolean) =>
    apiPost<
      (CaseView & { closed: true }) | { closed: false; openTasks: { id: string; name: string }[] }
    >(`${BASE}/cases/${id}/close`, { reason, force }),
  reopen: (id: string) => apiPost<unknown>(`/plugins/expedientes/cases/${id}/reopen`, {}),
  addTask: (caseId: string, body: object) =>
    apiPost<CaseView>(`${BASE}/cases/${caseId}/tasks`, body),
  addParty: (caseId: string, body: object) =>
    apiPost<CaseView>(`${BASE}/cases/${caseId}/parties`, body),
  open: (body: object) => apiPost<CaseView>(`${BASE}/open`, body),
  applyPlan: (caseId: string, templateId: string) =>
    apiPost<CaseView>(`${BASE}/cases/${caseId}/plan`, { templateId }),
  saveTemplate: (id: string | null, tree: TemplateTree) =>
    id
      ? apiPut<{ template: TemplateTree }>(`${BASE}/templates/${id}`, tree)
      : apiPost<{ template: TemplateTree }>(`${BASE}/templates`, tree),
  duplicateTemplate: (id: string) =>
    apiPost<{ template: TemplateTree }>(`${BASE}/templates/${id}/duplicate`, {}),
  addContact: (body: object) => apiPost<{ contact: Contact }>(`${BASE}/contacts`, body),
  updateContact: (id: string, body: object) => apiPut<{ ok: true }>(`${BASE}/contacts/${id}`, body),
};
