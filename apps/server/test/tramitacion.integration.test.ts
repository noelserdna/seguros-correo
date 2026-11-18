/**
 * Módulo de tramitación: abrir un expediente desde el atestado con su plan, llevar sus
 * tareas, esperas y reclamaciones, y ver la cartera. Requiere `pnpm dev:up`.
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { User } from "../src/auth/sessions.ts";
import { createUser } from "../src/auth/users.ts";
import { accountAccess, events } from "../src/db/schema.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import { expedientesPlugin } from "../src/plugins/expedientes/index.ts";
import { orderPlugins, PluginHost } from "../src/plugins/host.ts";
import { addCalendarDays } from "../src/plugins/tramitacion/days.ts";
import { tramitacionPlugin } from "../src/plugins/tramitacion/index.ts";
import { todayInSpain } from "../src/plugins/tramitacion/store.ts";
import {
  ANA,
  appendMail,
  createTestAccount,
  openTestEnv,
  otherClient,
  resetDb,
  resetMailbox,
  syncAll,
  type TestEnv,
} from "./helpers.ts";

const PASSWORD = "contraseña-de-prueba";
const BASE = "/api/plugins/tramitacion";

let env: TestEnv;
let app: FastifyInstance;
let host: PluginHost;
let outlook: ImapFlow;
let account: Account;
let marta: User;
let session: Login;

type Login = { cookie: string; csrf: string };
type Task = {
  id: string;
  key: string | null;
  name: string;
  status: string;
  state: string;
  due: string | null;
  lateDays: number;
  assigneeId: string | null;
  blockers: string[];
  chaseCount: number;
  chaseAt: string | null;
  evidenceMessageId: string | null;
};
type View = {
  case: {
    id: string;
    number: string;
    status: string;
    closeReason: string | null;
    ownerId: string | null;
  };
  plan: { templateName: string } | null;
  phases: { name: string; state: string }[];
  tasks: Task[];
  nextStep: { kind: string; name?: string };
  health: { level: string; reasons: string[]; idleDays: number };
  history: { kind: string }[];
};

async function login(email: string): Promise<Login> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
  return {
    cookie: `${SESSION_COOKIE}=${cookie?.value}`,
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
}

const call = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
  as = session,
) =>
  app.inject({
    method,
    url,
    headers: { cookie: as.cookie, [CSRF_HEADER]: as.csrf },
    ...(payload ? { payload } : {}),
  });

async function settle(): Promise<void> {
  await syncAll(env, account);
  await host.drain();
}

async function idOf(subject: string): Promise<string> {
  const rows = await env.db.execute<{ id: string }>(
    sql`select id from messages where subject = ${subject}`,
  );
  return rows.rows[0]!.id;
}

async function templateId(): Promise<string> {
  const list = (await call("GET", `${BASE}/templates`)).json<{
    templates: { id: string; name: string }[];
  }>();
  return list.templates.find((entry) => entry.name === "Siniestro de automóvil con atestado")!.id;
}

/** Abre un expediente desde un correo de atestado con la plantilla de serie. */
async function open(
  subject: string,
  lossDate = addCalendarDays(todayInSpain(), -3),
): Promise<View> {
  await appendMail(outlook, { subject });
  await settle();
  const response = await call("POST", `${BASE}/open`, {
    messageId: await idOf(subject),
    templateId: await templateId(),
    lossDate,
  });
  expect(response.statusCode).toBe(200);
  return response.json<View>();
}

const task = (view: View, key: string) => view.tasks.find((entry) => entry.key === key)!;

beforeAll(async () => {
  env = await openTestEnv();
  host = new PluginHost(env.db, orderPlugins([tramitacionPlugin, expedientesPlugin]));
  await host.setup();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await env.db.execute(sql`truncate table tra_contacts, tra_templates cascade`);
  await host.setup();
  await resetMailbox(ANA);
  outlook = await otherClient(ANA);
  account = await createTestAccount(env);
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    rawStore: env.rawStore,
    plugins: [expedientesPlugin, tramitacionPlugin],
  });
  marta = await createUser(env.db, { email: "marta@c.test", name: "Marta", password: PASSWORD });
  await env.db.insert(accountAccess).values({ userId: marta.id, accountId: account.id });
  session = await login(marta.email);
});
afterEach(async () => {
  await app.close();
  await outlook.logout().catch(() => undefined);
});

describe("tramitación", () => {
  it("trae de serie la plantilla del siniestro con atestado", async () => {
    const id = await templateId();
    const tree = (await call("GET", `${BASE}/templates/${id}`)).json<{
      template: {
        phases: {
          name: string;
          tasks: { key: string; after: string[]; legalRef: string | null }[];
        }[];
      };
    }>().template;
    expect(tree.phases.map((phase) => phase.name)).toEqual([
      "Apertura",
      "Comunicación",
      "Valoración",
      "Resolución",
      "Cobro y cierre",
    ]);
    const tasks = tree.phases.flatMap((phase) => phase.tasks);
    expect(tasks).toHaveLength(16);
    expect(tasks.find((entry) => entry.key === "T14")!.after).toEqual(["T11", "T12"]);
    expect(tasks.filter((entry) => entry.legalRef).map((entry) => entry.key)).toEqual([
      "T3",
      "T11",
      "T14",
    ]);
  });

  it("abre el expediente desde el atestado con su plan, y solo lo ve quien tiene el buzón", async () => {
    const view = await open("Atestado 2026/8812");
    expect(view.plan?.templateName).toBe("Siniestro de automóvil con atestado");
    expect(view.case.ownerId).toBe(marta.id);
    expect(view.tasks).toHaveLength(16);
    expect(task(view, "T9").status).toBe("omitida"); // opcional: se crea como «no aplica»
    expect(task(view, "T1")).toMatchObject({ state: "lista", assigneeId: marta.id });
    expect(task(view, "T3")).toMatchObject({
      state: "bloqueada",
      blockers: ["Registrar el atestado y los datos del siniestro"],
    });
    expect(view.phases.map((phase) => phase.state)).toEqual([
      "actual",
      "proxima",
      "proxima",
      "proxima",
      "proxima",
    ]);
    expect(view.nextStep).toMatchObject({
      kind: "tarea",
      name: "Registrar el atestado y los datos del siniestro",
    });
    expect(view.history.map((event) => event.kind)).toEqual(["creada"]);

    const stranger = await createUser(env.db, {
      email: "otro@c.test",
      name: "Otro",
      password: PASSWORD,
    });
    const other = await login(stranger.email);
    expect((await call("GET", `${BASE}/cases/${view.case.id}`, undefined, other)).statusCode).toBe(
      404,
    );
    expect(
      (await call("GET", `${BASE}/portfolio`, undefined, other)).json<{ cases: unknown[] }>().cases,
    ).toEqual([]);
  });

  it("lleva las tareas: hecha, bloqueada, esperas, reclamaciones y el correo como prueba", async () => {
    let view = await open("Atestado 2026/9001");
    const patch = async (key: string, body: object) =>
      call("PATCH", `${BASE}/tasks/${task(view, key).id}`, body);

    // Una tarea de la que faltan otras no se da por hecha sin decirlo a propósito.
    const blocked = await patch("T8", { status: "hecha" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ message: string }>().message).toContain("Peritación del vehículo");

    view = (await patch("T1", { status: "hecha" })).json<View>();
    expect(task(view, "T1")).toMatchObject({
      state: "hecha",
      due: addCalendarDays(view.tasks[0]!.due ?? todayInSpain(), 0),
    });
    expect(task(view, "T3").state).toBe("lista");

    // Esperar al cliente, con su reclamación.
    view = (await patch("T2", { waiting: { client: true } })).json<View>();
    expect(task(view, "T2")).toMatchObject({ state: "esperando", chaseCount: 0 });
    const draft = (await call("POST", `${BASE}/tasks/${task(view, "T2").id}/chase`)).json<{
      draft: { to: string | null; subject: string };
    }>().draft;
    expect(draft.to).toBeNull();
    expect(draft.subject).toContain(view.case.number);
    view = (await call("POST", `${BASE}/tasks/${task(view, "T2").id}/chased`)).json<View>();
    expect(task(view, "T2").chaseCount).toBe(1);
    // Enviada desde el redactor, la reclamación se apunta sola.
    const outboundId = "00000000-0000-4000-8000-000000000001";
    await call("POST", `${BASE}/tasks/${task(view, "T2").id}/chase-link`, { outboundId });
    await env.db.insert(events).values({
      accountId: account.id,
      type: "outbound.sent",
      payload: { outboundId, userId: marta.id },
    });
    await host.drain();
    view = (await call("GET", `${BASE}/cases/${view.case.id}`)).json<View>();
    expect(task(view, "T2").chaseCount).toBe(2);

    // Un tercero del directorio: el perito. Su correo se reconoce y cumple la tarea.
    const perito = (
      await call("POST", `${BASE}/contacts`, {
        role: "perito",
        name: "Peritaciones Norte",
        email: "informes@norte.test",
      })
    ).json<{ contact: { id: string } }>().contact;
    expect(
      (await call("POST", `${BASE}/contacts`, { role: "perito", name: "peritaciones norte" }))
        .statusCode,
    ).toBe(409);
    for (const key of ["T3", "T4", "T6"])
      view = (await patch(key, { status: "hecha" })).json<View>();
    view = (await patch("T7", { waiting: { contactId: perito.id } })).json<View>();
    expect(task(view, "T7").state).toBe("esperando");

    await appendMail(outlook, { subject: "Informe pericial", from: "informes@norte.test" });
    await settle();
    const informe = await idOf("Informe pericial");
    // El correo no está en el expediente: el panel no lo reconoce todavía.
    expect(
      (await call("GET", `${BASE}/by-message/${informe}`)).json<{ cases: unknown[] }>().cases,
    ).toEqual([]);
    await call("POST", `/api/plugins/expedientes/cases/${view.case.id}/messages`, {
      messageId: informe,
    });
    const panel = (await call("GET", `${BASE}/by-message/${informe}`)).json<{
      cases: { awaited: { taskName: string; who: string } | null }[];
    }>();
    expect(panel.cases[0]!.awaited).toMatchObject({
      taskName: "Peritación del vehículo",
      who: "Peritaciones Norte",
    });

    view = (
      await call("POST", `${BASE}/tasks/${task(view, "T7").id}/evidence`, { messageId: informe })
    ).json<View>();
    expect(task(view, "T7")).toMatchObject({ state: "hecha", evidenceMessageId: informe });
    expect(task(view, "T8").state).toBe("lista");
    expect(view.history.map((event) => event.kind).slice(0, 2)).toEqual(["prueba", "espera"]);
    expect(view.health.idleDays).toBe(0);

    // Las dependencias no admiten círculos.
    const cycle = await call("PUT", `${BASE}/tasks/${task(view, "T1").id}/deps`, {
      dependsOn: [task(view, "T16").id],
    });
    expect(cycle.statusCode).toBe(400);
  });

  it("cerrar pide confirmación si quedan tareas, y la cartera lo refleja", async () => {
    const view = await open("Atestado 2026/9002");
    const url = `${BASE}/cases/${view.case.id}/close`;
    const ask = (await call("POST", url, { reason: "desistido" })).json<{
      closed: boolean;
      openTasks: unknown[];
    }>();
    expect(ask.closed).toBe(false);
    expect(ask.openTasks).toHaveLength(14);
    const closed = (await call("POST", url, { reason: "desistido", force: true })).json<
      View & { closed: boolean }
    >();
    expect(closed.closed).toBe(true);
    expect(closed.case).toMatchObject({ status: "cerrado", closeReason: "desistido" });
    expect(closed.health.level).toBe("cerrado");
    expect(closed.tasks.every((entry) => ["hecha", "omitida"].includes(entry.status))).toBe(true);

    const open_ = (await call("GET", `${BASE}/portfolio`)).json<{ cases: unknown[] }>();
    expect(open_.cases).toHaveLength(0);
    const done = (await call("GET", `${BASE}/portfolio?estado=cerrados`)).json<{
      cases: { case: { number: string } }[];
    }>();
    expect(done.cases.map((row) => row.case.number)).toEqual([view.case.number]);
  });

  it("la cartera ordena por urgencia y Mis tareas agrupa por plazo", async () => {
    const calm = await open("Atestado tranquilo");
    const late = await open("Atestado con prisa");
    // Una tarea con plazo pasado hace 5 días: vencida de verdad.
    await call("PATCH", `${BASE}/tasks/${task(late, "T1").id}`, {
      dueOverride: addCalendarDays(todayInSpain(), -5),
    });

    const portfolio = (await call("GET", `${BASE}/portfolio`)).json<{
      counts: Record<string, number>;
      cases: { case: { id: string }; health: { level: string }; nextStep: { name?: string } }[];
    }>();
    expect(portfolio.cases.map((row) => row.case.id)).toEqual([late.case.id, calm.case.id]);
    expect(portfolio.cases[0]!.health.level).toBe("vencidas");
    expect(portfolio.counts.vencidas).toBe(1);
    const filtered = (await call("GET", `${BASE}/portfolio?salud=vencidas`)).json<{
      cases: unknown[];
    }>();
    expect(filtered.cases).toHaveLength(1);

    const mine = (await call("GET", `${BASE}/my-tasks`)).json<{
      groups: Record<string, { case: { id: string } }[]>;
    }>();
    expect(mine.groups.vencidas!.map((entry) => entry.case.id)).toEqual([late.case.id]);
    // La tarea del expediente tranquilo vence mañana: va en los próximos días.
    expect(mine.groups.semana!.map((entry) => entry.case.id)).toEqual([calm.case.id]);
  });

  it("las plantillas solo las cambia un administrador, y sin círculos ni nombres repetidos", async () => {
    const admin = await createUser(env.db, {
      email: "admin@c.test",
      name: "Admin",
      password: PASSWORD,
      role: "admin",
    });
    const boss = await login(admin.email);
    const tree = {
      name: "Daños por agua",
      phases: [
        {
          name: "Única",
          tasks: [
            { key: "A", name: "Visita" },
            { key: "B", name: "Informe", after: ["A"] },
          ],
        },
      ],
    };
    expect((await call("POST", `${BASE}/templates`, tree)).statusCode).toBe(403);
    expect((await call("POST", `${BASE}/templates`, tree, boss)).statusCode).toBe(200);
    expect((await call("POST", `${BASE}/templates`, tree, boss)).statusCode).toBe(409);
    const cyclic = {
      name: "En círculo",
      phases: [
        {
          name: "Única",
          tasks: [
            { key: "A", name: "Uno", after: ["B"] },
            { key: "B", name: "Dos", after: ["A"] },
          ],
        },
      ],
    };
    const refused = await call("POST", `${BASE}/templates`, cyclic, boss);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ message: string }>().message).toContain("círculo");
  });
});
