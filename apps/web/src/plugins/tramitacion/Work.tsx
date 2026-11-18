/** Página de la tramitación: Mis tareas y la cartera, y la ficha de cada expediente. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { navigate, useUrlState } from "../../url-state.ts";
import {
  BASE,
  KEY,
  tramitacion,
  useApplyView,
  type MyTask,
  type MyTasks,
  type Portfolio,
  type PortfolioRow,
} from "./api.ts";
import { openCase, startChase } from "./actions.ts";
import { CaseProject } from "./CaseProject.tsx";
import { nextStepText } from "./logic.ts";
import { Avatar, buttonClass, Chip, DueCell, HealthBadge, StateIcon } from "./pieces.tsx";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type PortfolioFilter = "todos" | "mios" | "parados" | "terceros" | "vencidas" | "cerrados";

function filterQuery(filter: PortfolioFilter, userId: string): string {
  switch (filter) {
    case "mios":
      return `gestor=${userId}`;
    case "parados":
      return "parados=7";
    case "terceros":
      return "esperando=terceros";
    case "vencidas":
      return "salud=vencidas";
    case "cerrados":
      return "estado=cerrados";
    default:
      return "";
  }
}

function MiniPhases({ row }: { row: PortfolioRow }) {
  const current = row.phases.findIndex((phase) => phase.state !== "hecha");
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex gap-0.5" aria-hidden>
        {row.phases.map((phase, index) => (
          <span
            key={phase.name}
            className={`h-1.5 w-3.5 rounded-sm ${phase.state === "hecha" ? "bg-ok" : index === current ? "bg-accent" : phase.state === "retraso" ? "bg-flag" : "bg-line"}`}
          />
        ))}
      </span>
      <span className="truncate text-xs">{row.currentPhase ?? "Terminado"}</span>
    </span>
  );
}

function PortfolioView({ userId, query }: { userId: string; query: string }) {
  const [filter, setFilter] = useState<PortfolioFilter>("todos");
  const portfolio = useQuery({
    queryKey: [...KEY, "portfolio", filter],
    queryFn: () => apiGet<Portfolio>(`${BASE}/portfolio?${filterQuery(filter, userId)}`),
  });
  const all = useQuery({
    queryKey: [...KEY, "portfolio", "todos"],
    queryFn: () => apiGet<Portfolio>(`${BASE}/portfolio`),
  });
  const counts = all.data?.counts ?? {};
  const needle = query.trim().toLowerCase();
  const rows = (portfolio.data?.cases ?? []).filter(
    (row) =>
      !needle ||
      [row.case.number, row.case.title, row.case.claimRef ?? ""].some((text) =>
        text.toLowerCase().includes(needle),
      ),
  );
  const filters: { id: PortfolioFilter; label: string }[] = [
    { id: "todos", label: `Todos ${all.data?.total ?? ""}` },
    { id: "mios", label: "Míos" },
    { id: "parados", label: "Parados > 7 d" },
    { id: "terceros", label: "Esperando a terceros" },
    { id: "vencidas", label: `Con vencidas ${counts.vencidas ?? ""}` },
    { id: "cerrados", label: "Cerrados" },
  ];
  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-5 py-2.5">
        {filters.map((entry) => (
          <Chip key={entry.id} active={filter === entry.id} onClick={() => setFilter(entry.id)}>
            {entry.label}
          </Chip>
        ))}
        <span className="grow" />
        <span className="text-xs text-ink-2">Orden: salud y días sin avance</span>
      </div>
      {all.data && (
        <div className="flex shrink-0 flex-wrap gap-4 px-5 pb-2 text-xs text-ink-2">
          <span>Toda la cartera:</span>
          <span className="inline-flex items-center gap-1.5 font-bold text-ink">
            <Icon name="diamond" size={12} />
            {counts.vencidas ?? 0} con vencidas
          </span>
          <span className="inline-flex items-center gap-1.5 font-bold text-ink">
            <Icon name="pause" size={12} />
            {counts.parado ?? 0} parados
          </span>
          <span className="inline-flex items-center gap-1.5 text-ink">
            <Icon name="triangle" size={12} className="text-flag" />
            {counts.riesgo ?? 0} en riesgo
          </span>
          <span className="inline-flex items-center gap-1.5 text-ink">
            <Icon name="dot" size={12} className="text-ok" />
            {counts.al_dia ?? 0} al día
          </span>
        </div>
      )}
      <div className="mx-5 min-h-0 grow overflow-auto rounded-md border border-line">
        <table className="w-full min-w-[1000px] border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-ground text-left text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
            <tr className="border-b border-line">
              <th className="w-[130px] px-4 py-2 font-semibold">Salud</th>
              <th className="px-2 py-2 font-semibold">Expediente</th>
              <th className="w-[120px] px-2 py-2 font-semibold">Fase</th>
              <th className="px-2 py-2 font-semibold">Siguiente paso</th>
              <th className="w-[190px] px-2 py-2 font-semibold">Esperando a</th>
              <th className="w-[120px] px-2 py-2 font-semibold">Plazo</th>
              <th className="w-[80px] px-2 py-2 font-semibold">Sin mov.</th>
              <th className="w-[56px] px-2 py-2 font-semibold">Gestor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.case.id}
                tabIndex={0}
                onClick={() => openCase(row.case.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") openCase(row.case.id);
                }}
                className="h-[42px] cursor-pointer border-b border-line-soft hover:bg-ground focus:bg-accent-soft focus:outline-none"
              >
                <td className="px-4">
                  <HealthBadge health={row.health} size={13} />
                </td>
                <td className="max-w-0 px-2">
                  <span className="flex flex-col">
                    <b className="font-semibold">{row.case.number}</b>
                    <span className="truncate text-xs text-ink-2">{row.case.title}</span>
                  </span>
                </td>
                <td className="px-2">
                  <MiniPhases row={row} />
                </td>
                <td className="max-w-0 truncate px-2">
                  {nextStepText(row.nextStep, portfolio.data!.today)}
                </td>
                <td className="max-w-0 truncate px-2 text-xs">
                  {row.waiting ? (
                    `${capitalize(row.waiting.who ?? "un tercero")} · ${row.waiting.days} d`
                  ) : (
                    <span className="text-ink-2">—</span>
                  )}
                </td>
                <td className="px-2 text-xs">
                  {row.nextDue ? (
                    <DueCell
                      due={row.nextDue.due}
                      today={portfolio.data!.today}
                      legalRef={row.nextDue.legal ? "plazo legal" : null}
                    />
                  ) : (
                    "—"
                  )}
                </td>
                <td className={`px-2 tabular-nums ${row.health.idleDays >= 7 ? "font-bold" : ""}`}>
                  {row.health.idleDays} d
                </td>
                <td className="px-2">
                  <Avatar name={row.case.ownerName} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {portfolio.isLoading && (
          <p role="status" className="m-0 p-4 text-ink-2">
            Cargando la cartera…
          </p>
        )}
        {portfolio.isError && (
          <div role="alert" className="flex flex-col items-start gap-2 p-4">
            No se ha podido cargar la cartera.
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => void portfolio.refetch()}
            >
              Reintentar
            </button>
          </div>
        )}
        {portfolio.isSuccess && rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
            <Icon name="tasks" size={28} className="text-ink-2" />
            {filter === "todos" && !needle ? (
              <>
                <b className="font-semibold">No hay expedientes en tramitación</b>
                <span className="text-xs text-ink-2">
                  Se abren desde el correo del atestado, con el botón «Tramitar» de su barra.
                </span>
              </>
            ) : (
              <>
                <b className="font-semibold">Ningún expediente cumple el filtro</b>
                <button
                  type="button"
                  className={buttonClass.link}
                  onClick={() => setFilter("todos")}
                >
                  Quitar filtro
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <p className="m-0 shrink-0 px-5 py-2 text-xs text-ink-2">
        «Sin mov.» son días sin avance real: un correo que no cumple nada no cuenta.
      </p>
    </div>
  );
}

const GROUPS: { id: keyof MyTasks["groups"]; label: string; open: boolean }[] = [
  { id: "vencidas", label: "Vencidas", open: true },
  { id: "hoy", label: "Hoy", open: true },
  { id: "semana", label: "Próximos 7 días", open: true },
  { id: "despues", label: "Más adelante", open: false },
  { id: "esperando", label: "Esperando a otros", open: true },
];

function MyTasksView({ query }: { query: string }) {
  const tasks = useQuery({
    queryKey: [...KEY, "my-tasks"],
    queryFn: () => apiGet<MyTasks>(`${BASE}/my-tasks`),
  });
  const [closed, setClosed] = useState(
    () => new Set(GROUPS.filter((group) => !group.open).map((group) => group.id)),
  );
  const apply = useApplyView();
  const queryClient = useQueryClient();
  const needle = query.trim().toLowerCase();
  const total = Object.values(tasks.data?.groups ?? {}).reduce((sum, list) => sum + list.length, 0);
  const done = (task: MyTask) =>
    void tramitacion
      .patchTask(task.taskId, { status: "hecha" })
      .then(apply, () => void queryClient.invalidateQueries({ queryKey: [...KEY, "my-tasks"] }));
  return (
    <div className="min-h-0 grow overflow-y-auto px-5 py-3">
      {tasks.isLoading && (
        <p role="status" className="m-0 text-ink-2">
          Cargando tus tareas…
        </p>
      )}
      {tasks.isSuccess && total === 0 && (
        <div className="flex flex-col items-center gap-2 py-14 text-center">
          <Icon name="circleCheckOutline" size={28} className="text-ink-2" />
          <b className="font-semibold">No tienes nada pendiente</b>
          <span className="text-xs text-ink-2">
            Las esperas a terceros siguen en «Esperando a otros».
          </span>
        </div>
      )}
      {tasks.data && total > 0 && (
        <div className="overflow-hidden rounded-md border border-line">
          {GROUPS.map((group) => {
            const list = tasks.data.groups[group.id].filter(
              (task) =>
                !needle ||
                [task.name, task.case.number, task.case.title].some((text) =>
                  text.toLowerCase().includes(needle),
                ),
            );
            const isOpen = !closed.has(group.id);
            return (
              <section key={group.id} aria-label={group.label}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() =>
                    setClosed((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                  className="flex h-[30px] w-full items-center gap-2 border-0 border-b border-line bg-ground px-3 text-left text-xs font-semibold text-ink"
                >
                  <Icon name={isOpen ? "down" : "right"} size={12} />
                  {group.label}
                  <span className="font-normal text-ink-2">{list.length}</span>
                </button>
                {isOpen &&
                  list.map((task) => (
                    <div
                      key={task.taskId}
                      className="flex h-9 items-center gap-3 border-b border-line-soft pr-3 pl-4"
                    >
                      <StateIcon
                        task={{ state: task.state, waitingClient: task.waitingOn === "el cliente" }}
                      />
                      <button
                        type="button"
                        onClick={() => openCase(task.case.id)}
                        className="min-w-0 grow truncate border-0 bg-transparent p-0 text-left text-ink"
                      >
                        {task.name}
                      </button>
                      <span className="hidden w-[320px] shrink-0 truncate text-xs text-ink-2 md:block">
                        <b className="font-semibold text-ink">{task.case.number}</b> ·{" "}
                        {task.state === "esperando"
                          ? `${capitalize(task.waitingOn ?? "un tercero")} · ${task.waitingDays ?? 0} d`
                          : task.case.title}
                      </span>
                      <span className="w-[120px] shrink-0 text-xs">
                        {task.state === "esperando" ? (
                          task.chaseDue ? (
                            <span className="inline-flex items-center gap-1.5 font-bold">
                              <Icon name="diamond" size={12} />
                              Reclamar ya
                            </span>
                          ) : (
                            <span className="text-ink-2">
                              reclamar {task.chaseAt?.split("-").reverse().slice(0, 2).join("/")}
                            </span>
                          )
                        ) : (
                          <DueCell
                            due={task.due}
                            today={tasks.data.today}
                            legalRef={task.legal ? "plazo legal" : null}
                          />
                        )}
                      </span>
                      <span className="flex w-[104px] shrink-0 justify-end">
                        {task.state === "esperando" ? (
                          <button
                            type="button"
                            className={buttonClass.small}
                            onClick={() => void startChase(task.taskId)}
                          >
                            Reclamar
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={buttonClass.small}
                            onClick={() => done(task)}
                          >
                            Hecha
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
              </section>
            );
          })}
        </div>
      )}
      <p className="mt-2 mb-0 text-xs text-ink-2">
        Las tareas suben solas de sección según su plazo. Los avisos de vencimiento están aquí; no
        hay ventanas emergentes.
      </p>
    </div>
  );
}

/** La página entera. La subruta dice dónde se está: «mis», «cartera» o «exp:<id>». */
export function TramitacionPage({ userId }: { isAdmin: boolean; userId: string }) {
  const { sub } = useUrlState();
  const [query, setQuery] = useState("");
  if (sub?.startsWith("exp:")) return <CaseProject caseId={sub.slice(4)} userId={userId} />;
  const tab = sub === "cartera" ? "cartera" : "mis";
  return (
    <main className="flex min-w-0 grow flex-col bg-panel">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-5 pt-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-lg font-semibold">Tramitación</h1>
          <span className="grow" />
          <label className="flex h-[30px] w-[280px] max-w-full items-center gap-1.5 rounded-md border border-line bg-ground px-2.5 text-ink-2">
            <Icon name="search" size={14} />
            <span className="sr-only">Buscar expediente</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar expediente o número de siniestro"
              className="min-w-0 grow border-0 bg-transparent text-[13px] text-ink outline-none"
            />
          </label>
        </div>
        <div role="tablist" className="flex">
          {(["mis", "cartera"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              onClick={() => navigate({ sub: entry })}
              className={`mr-5 h-9 border-0 border-b-2 bg-transparent px-0.5 ${tab === entry ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2"}`}
            >
              {entry === "mis" ? "Mis tareas" : "Cartera"}
            </button>
          ))}
        </div>
      </div>
      {tab === "cartera" ? (
        <PortfolioView userId={userId} query={query} />
      ) : (
        <MyTasksView query={query} />
      )}
    </main>
  );
}
