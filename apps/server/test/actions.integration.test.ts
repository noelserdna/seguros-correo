/**
 * Acciones con reflejo: lo que se hace aquí llega al servidor de correo, y lo que hace
 * «Outlook» a la vez no rompe nada. Requiere `pnpm dev:up`.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../src/auth/users.ts";
import type { User } from "../src/auth/sessions.ts";
import {
  accountAccess,
  auditLog,
  events,
  folderMessages,
  folders,
  mailActions,
  messages,
} from "../src/db/schema.ts";
import { buildApp, CSRF_HEADER, SESSION_COOKIE } from "../src/http/app.ts";
import { imapClientFor, type Account } from "../src/imap/connection.ts";
import { syncFolder } from "../src/sync/folder-sync.ts";
import { AccountSupervisor } from "../src/sync/supervisor.ts";
import { DEFAULT_SYNC_OPTIONS } from "../src/sync/types.ts";
import {
  ANA,
  appendMail,
  createTestAccount,
  inFolder,
  openTestEnv,
  otherClient,
  resetDb,
  resetMailbox,
  syncAll,
  waitFor,
  type TestEnv,
} from "./helpers.ts";

const PASSWORD = "contraseña-de-prueba";

let env: TestEnv;
let app: FastifyInstance;
let outlook: ImapFlow;
let account: Account;
let marta: User;
let pedro: User;
let session: Login;
let queued: string[];

type Login = { cookie: string; csrf: string };
type ActionReply = {
  action: { id: string; type: string; state: string; undoable: boolean } | null;
  error?: string;
};
type Item = { id: string; subject: string; flags: string[] };

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

const post = (url: string, payload: object, as: Login = session) =>
  app.inject({
    method: "POST",
    url,
    headers: { cookie: as.cookie, [CSRF_HEADER]: as.csrf },
    payload,
  });

async function folderId(path: string): Promise<string> {
  const [folder] = await env.db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.accountId, account.id), eq(folders.path, path)));
  if (!folder) throw new Error(`No existe la carpeta ${path}.`);
  return folder.id;
}

/** Lo que enseña la interfaz en una carpeta. */
async function listed(path: string): Promise<Item[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/folders/${await folderId(path)}/messages`,
    headers: { cookie: session.cookie },
  });
  return response.json<{ items: Item[] }>().items;
}

/** Lo que hay de verdad en el servidor de correo, visto desde «Outlook». */
const onServer = (path: string) =>
  inFolder(outlook, path, async () => {
    // Si ya tenía la carpeta abierta, el servidor le debe las novedades hasta que pregunte.
    await outlook.noop();
    if (!outlook.mailbox || outlook.mailbox.exists === 0) return [];
    const found = await outlook.fetchAll("1:*", { uid: true, flags: true, envelope: true });
    return found.map((message) => ({
      uid: message.uid,
      subject: message.envelope?.subject ?? "",
      flags: [...(message.flags ?? [])].filter((flag) => flag !== "\\Recent").sort(),
    }));
  });

const eventsOf = async (type: string) =>
  (await env.db.select().from(events).orderBy(asc(events.id))).filter((e) => e.type === type);

beforeAll(async () => {
  env = await openTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await resetMailbox(ANA);
  outlook = await otherClient(ANA);
  await outlook.mailboxCreate("Siniestros");
  account = await createTestAccount(env);
  queued = [];
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    rawStore: env.rawStore,
    onActionQueued: (accountId) => queued.push(accountId),
  });
  marta = await createUser(env.db, { email: "marta@c.test", name: "Marta", password: PASSWORD });
  pedro = await createUser(env.db, { email: "pedro@c.test", name: "Pedro", password: PASSWORD });
  await env.db.insert(accountAccess).values({ userId: marta.id, accountId: account.id });
  session = await login(marta.email);
});
afterEach(async () => {
  await app.close();
  await outlook.logout().catch(() => undefined);
});

/** Deja un correo en la Entrada, ya sincronizado, y devuelve su identificador estable. */
async function mailInInbox(subject: string): Promise<{ id: string; inbox: string }> {
  await appendMail(outlook, { subject });
  await syncAll(env, account);
  const item = (await listed("INBOX")).find((entry) => entry.subject === subject);
  if (!item) throw new Error("El correo no ha llegado.");
  return { id: item.id, inbox: await folderId("INBOX") };
}

describe("marcas", () => {
  it("marcar como leído y poner bandera se ve al instante y llega al servidor", async () => {
    const { id, inbox } = await mailInInbox("Parte de daños");

    const reply = await post(`/api/messages/${id}/flags`, {
      folderId: inbox,
      add: ["\\Seen", "\\Flagged"],
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json<ActionReply>().action).toMatchObject({ type: "flags", state: "pending" });
    expect(queued).toEqual([account.id]);

    // Al instante en pantalla; el servidor aún no lo sabe.
    expect((await listed("INBOX"))[0]?.flags).toEqual(["\\Flagged", "\\Seen"]);
    expect((await onServer("INBOX"))[0]?.flags).toEqual([]);

    const [cycle] = await syncAll(env, account);
    expect(cycle?.actions).toBe(1);
    expect((await onServer("INBOX"))[0]?.flags).toEqual(["\\Flagged", "\\Seen"]);
    expect((await listed("INBOX"))[0]?.flags).toEqual(["\\Flagged", "\\Seen"]);

    await post(`/api/messages/${id}/flags`, { folderId: inbox, remove: ["\\Seen"] });
    await syncAll(env, account);
    expect((await onServer("INBOX"))[0]?.flags).toEqual(["\\Flagged"]);

    const changes = await eventsOf("message.flagsChanged");
    expect(changes.at(-1)?.payload).toMatchObject({ removed: ["\\Seen"], byUserId: marta.id });
    // La auditoría no se vacía entre pruebas: se miran solo las anotaciones de esta usuaria.
    const trail = await env.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "message.flags"), eq(auditLog.userId, marta.id)));
    expect(trail).toHaveLength(2);
  });

  it("no encola nada si la marca ya estaba, ni admite marcas que no son de usuario", async () => {
    const { id, inbox } = await mailInInbox("Repetido");
    await post(`/api/messages/${id}/flags`, { folderId: inbox, add: ["\\Seen"] });
    const again = await post(`/api/messages/${id}/flags`, { folderId: inbox, add: ["\\Seen"] });
    expect(again.json<ActionReply>().action).toBeNull();
    expect(await env.db.select().from(mailActions)).toHaveLength(1);

    const odd = await post(`/api/messages/${id}/flags`, { folderId: inbox, add: ["\\Deleted"] });
    expect(odd.statusCode).toBe(400);
  });

  it("una sincronización que se cruza no pisa la marca que aún está en cola", async () => {
    const { id, inbox } = await mailInInbox("En cola");
    await post(`/api/messages/${id}/flags`, { folderId: inbox, add: ["\\Seen"] });

    // Sincroniza la carpeta sin atender la cola, como si el ciclo ya hubiera pasado ese punto.
    const client = imapClientFor(account, env.secrets);
    await client.connect();
    try {
      const [folder] = await env.db.select().from(folders).where(eq(folders.id, inbox));
      await syncFolder(
        {
          db: env.db,
          client,
          account,
          rawStore: env.rawStore,
          options: { ...DEFAULT_SYNC_OPTIONS, useCondstore: false },
        },
        folder!,
      );
    } finally {
      await client.logout();
    }
    expect((await listed("INBOX"))[0]?.flags).toEqual(["\\Seen"]);
  });
});

describe("mover y deshacer", () => {
  it("mueve a otra carpeta conservando la identidad del correo, y lo devuelve al deshacer", async () => {
    const { id, inbox } = await mailInInbox("Para archivar en su carpeta");
    const target = await folderId("Siniestros");

    const reply = await post(`/api/messages/${id}/move`, {
      folderId: inbox,
      targetFolderId: target,
    });
    const action = reply.json<ActionReply>().action!;
    expect(action).toMatchObject({ type: "move", undoable: true });
    expect(await listed("INBOX")).toEqual([]);

    await syncAll(env, account);
    expect(await onServer("INBOX")).toEqual([]);
    expect((await onServer("Siniestros")).map((m) => m.subject)).toEqual([
      "Para archivar en su carpeta",
    ]);
    expect((await listed("Siniestros")).map((item) => item.id)).toEqual([id]);
    expect(await env.db.select().from(messages)).toHaveLength(1);

    const undo = await post(`/api/actions/${action.id}/undo`, {});
    expect(undo.statusCode).toBe(200);
    expect(await listed("Siniestros")).toEqual([]);
    await syncAll(env, account);
    expect(await onServer("Siniestros")).toEqual([]);
    expect((await listed("INBOX")).map((item) => item.id)).toEqual([id]);
    expect(await env.db.select().from(messages)).toHaveLength(1);

    // Deshacer dos veces no hace nada más.
    expect((await post(`/api/actions/${action.id}/undo`, {})).statusCode).toBe(409);
  });

  it("deshacer antes de que salga hacia el servidor lo cancela sin tocar el buzón", async () => {
    const { id, inbox } = await mailInInbox("Me he equivocado");
    const reply = await post(`/api/messages/${id}/move`, {
      folderId: inbox,
      targetFolderId: await folderId("Siniestros"),
    });
    const undo = await post(`/api/actions/${reply.json<ActionReply>().action!.id}/undo`, {});
    expect(undo.json<ActionReply>().action?.state).toBe("cancelled");
    expect((await listed("INBOX")).map((item) => item.id)).toEqual([id]);

    const [cycle] = await syncAll(env, account);
    expect(cycle?.actions).toBe(0);
    expect(await onServer("INBOX")).toHaveLength(1);
    expect(await onServer("Siniestros")).toEqual([]);
  });

  it("no deja mover a la misma carpeta ni actuar a quien no tiene el buzón", async () => {
    const { id, inbox } = await mailInInbox("Protegido");
    const same = await post(`/api/messages/${id}/move`, { folderId: inbox, targetFolderId: inbox });
    expect(same.statusCode).toBe(409);
    expect(same.json<ActionReply>().error).toBe("bad_target");

    const stranger = await login(pedro.email);
    const body = { folderId: inbox, add: ["\\Seen"] };
    expect((await post(`/api/messages/${id}/flags`, body, stranger)).statusCode).toBe(404);
    expect(
      (await post(`/api/messages/${id}/delete`, { folderId: inbox }, stranger)).statusCode,
    ).toBe(404);
    expect(await env.db.select().from(mailActions)).toHaveLength(0);
    expect((await listed("INBOX"))[0]?.flags).toEqual([]);
  });
});

describe("borrar", () => {
  it("borra a la Papelera; desde ella pide confirmación y el correo queda en el archivo", async () => {
    const { id, inbox } = await mailInInbox("Publicidad");

    const first = await post(`/api/messages/${id}/delete`, { folderId: inbox });
    expect(first.json<ActionReply>().action).toMatchObject({ type: "move", undoable: true });
    await syncAll(env, account);
    expect(await onServer("INBOX")).toEqual([]);
    expect(await onServer("Trash")).toHaveLength(1);

    const trash = await folderId("Trash");
    const unconfirmed = await post(`/api/messages/${id}/delete`, { folderId: trash });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json<ActionReply>().error).toBe("confirm_permanent");
    expect(await listed("Trash")).toHaveLength(1);

    const confirmed = await post(`/api/messages/${id}/delete`, {
      folderId: trash,
      permanent: true,
    });
    expect(confirmed.json<ActionReply>().action).toMatchObject({
      type: "expunge",
      undoable: false,
    });
    await syncAll(env, account, { removalGraceMs: 0 });
    expect(await onServer("Trash")).toEqual([]);

    // Fuera del buzón, pero no de nuestro archivo.
    const [kept] = await env.db.select().from(messages).where(eq(messages.id, id));
    expect(kept?.removedFromServerAt).not.toBeNull();
    expect(kept?.rawSha256).not.toBeNull();
  });
});

describe("a la vez que Outlook", () => {
  it("si Outlook ya había movido el correo, la acción se rechaza y queda el estado real", async () => {
    const { id, inbox } = await mailInInbox("Disputado");
    const uid = (await onServer("INBOX"))[0]!.uid;
    await inFolder(outlook, "INBOX", () =>
      outlook.messageMove(String(uid), "Trash", { uid: true }),
    );

    // Sin saberlo todavía, aquí se pide moverlo a otra carpeta y ponerle bandera.
    await post(`/api/messages/${id}/flags`, { folderId: inbox, add: ["\\Flagged"] });
    await post(`/api/messages/${id}/move`, {
      folderId: inbox,
      targetFolderId: await folderId("Siniestros"),
    });
    const [cycle] = await syncAll(env, account);
    expect(cycle?.actions).toBe(2);

    const failed = await eventsOf("action.failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]?.payload).toMatchObject({ userId: marta.id });
    expect(String(failed[0]?.payload.message)).toContain("ya no estaba");

    // Un solo correo, vivo solo donde lo dejó Outlook.
    expect(await env.db.select().from(messages)).toHaveLength(1);
    expect(await listed("INBOX")).toEqual([]);
    expect(await listed("Siniestros")).toEqual([]);
    expect((await listed("Trash")).map((item) => [item.id, item.flags])).toEqual([[id, []]]);
    expect(await onServer("Siniestros")).toEqual([]);
    const live = await env.db
      .select()
      .from(folderMessages)
      .where(and(eq(folderMessages.messageId, id), isNull(folderMessages.goneAt)));
    expect(live).toHaveLength(1);
  });

  it("si Outlook cambia una marca mientras aquí se cambia otra, quedan las dos", async () => {
    const { id, inbox } = await mailInInbox("Dos manos");
    const uid = (await onServer("INBOX"))[0]!.uid;
    await inFolder(outlook, "INBOX", () =>
      outlook.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }),
    );
    await post(`/api/messages/${id}/flags`, { folderId: inbox, add: ["\\Flagged"] });
    await syncAll(env, account);

    expect((await onServer("INBOX"))[0]?.flags).toEqual(["\\Flagged", "\\Seen"]);
    expect((await listed("INBOX"))[0]?.flags).toEqual(["\\Flagged", "\\Seen"]);
  });
});

describe("en vivo", () => {
  it("con el buzón vigilado, la acción llega al servidor en segundos", async () => {
    const { id, inbox } = await mailInInbox("Rápido");
    const supervisor = new AccountSupervisor(env, account, { pollIntervalMs: 60_000 });
    supervisor.start();
    try {
      // Se deja pasar el primer ciclo para que la acción dependa del aviso, no del arranque.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const started = Date.now();
      await post(`/api/messages/${id}/flags`, { folderId: inbox, add: ["\\Seen"] });
      supervisor.nudge();
      await waitFor(async () => (await onServer("INBOX"))[0]?.flags.includes("\\Seen"));
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await supervisor.stop();
    }
  });
});
