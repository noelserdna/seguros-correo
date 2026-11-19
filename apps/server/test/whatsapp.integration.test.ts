/**
 * Módulo de WhatsApp de punta a punta: un aviso firmado de Meta acaba como correo en una
 * carpeta del buzón de pruebas, la sincronización lo trae y cada contacto es un hilo.
 * Meta (sus avisos y la descarga de adjuntos) se simula aquí mismo.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.ts";
import type { Account } from "../src/imap/connection.ts";
import { PluginHost } from "../src/plugins/host.ts";
import { whatsappPlugin } from "../src/plugins/whatsapp/index.ts";
import { contactAddress } from "../src/plugins/whatsapp/mail.ts";
import { signBody } from "../src/plugins/whatsapp/meta.ts";
import { echoes, incoming, media, text } from "../src/plugins/whatsapp/simulate.ts";
import {
  config,
  createTestAccount,
  openTestEnv,
  resetDb,
  resetMailbox,
  syncAll,
  waitFor,
  type TestEnv,
} from "./helpers.ts";

const BUSINESS = "34976000100";
const PILAR = "34600111222";
const JAVIER = "34600333444";
const SECRET = "secreto-de-la-app";
const PHOTO = Buffer.from("foto del golpe");

let env: TestEnv;
let host: PluginHost;
let app: FastifyInstance;
let account: Account;
let graph: Server;
let graphUrl: string;

/** Hace de la API de Meta para los adjuntos: primero la dirección, después el fichero. */
beforeAll(async () => {
  env = await openTestEnv();
  host = new PluginHost(env.db, [whatsappPlugin]);
  await host.setup();
  graph = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer permiso") {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/M-FOTO") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ url: `${graphUrl}/fichero/M-FOTO` }));
    } else if (request.url === "/fichero/M-FOTO") {
      response.writeHead(200, { "content-type": "image/jpeg" }).end(PHOTO);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => graph.listen(0, "127.0.0.1", resolve));
  graphUrl = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;
});
afterAll(async () => {
  graph.close();
  await env.close();
});
beforeEach(async () => {
  await resetDb(env.db);
  await env.db.execute(sql`truncate table wa_events, wa_messages, wa_threads`);
  await resetMailbox();
  account = await createTestAccount(env);
  app = await buildApp({
    db: env.db,
    secrets: env.secrets,
    rawStore: env.rawStore,
    plugins: [whatsappPlugin],
    config: {
      ...config,
      WHATSAPP_MAILBOX: account.email,
      WHATSAPP_FOLDER: "WhatsApp",
      WHATSAPP_VERIFY_TOKEN: "comprobar",
      WHATSAPP_APP_SECRET: SECRET,
      WHATSAPP_TOKEN: "permiso",
      WHATSAPP_GRAPH_URL: graphUrl,
    },
  });
});
afterEach(async () => {
  await app.close();
});

const post = (payload: object, secret = SECRET) => {
  const body = JSON.stringify(payload);
  return app.inject({
    method: "POST",
    url: "/api/plugins/whatsapp/webhook",
    headers: { "content-type": "application/json", "x-hub-signature-256": signBody(body, secret) },
    payload: body,
  });
};
const converted = (count: number) =>
  waitFor(async () => {
    const rows = await env.db.execute<{ n: number }>(
      sql`select count(*)::int as n from wa_messages`,
    );
    return rows.rows[0]!.n >= count;
  });

describe("WhatsApp", () => {
  it("responde a la comprobación de Meta solo con el token acordado", async () => {
    const ok = await app.inject({
      url: "/api/plugins/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=comprobar&hub.challenge=1234",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("1234");
    const wrong = await app.inject({
      url: "/api/plugins/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1",
    });
    expect(wrong.statusCode).toBe(403);
  });

  it("rechaza avisos sin la firma de la aplicación", async () => {
    const response = await post(incoming(BUSINESS, [], [text(PILAR, new Date(), "hola")]), "otro");
    expect(response.statusCode).toBe(401);
    const rows = await env.db.execute(sql`select 1 from wa_events`);
    expect(rows.rows).toHaveLength(0);
  });

  it("cada contacto es un hilo, con lo que contesta la empresa desde el móvil y los adjuntos", async () => {
    const t0 = Date.now() - 3_600_000;
    const at = (minutes: number) => new Date(t0 + minutes * 60_000);
    const first = incoming(
      BUSINESS,
      [{ phone: PILAR, name: "Pilar Ferrer" }],
      [
        text(PILAR, at(0), "Buenas, hemos tenido un golpe con la furgoneta"),
        media(PILAR, at(1), "image", "M-FOTO", "image/jpeg", { caption: "Así ha quedado" }),
      ],
    );
    expect((await post(first)).statusCode).toBe(200);
    expect(
      (await post(echoes(BUSINESS, [text(BUSINESS, at(5), "Recibido, abrimos el parte", PILAR)])))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await post(
          incoming(
            BUSINESS,
            [{ phone: JAVIER, name: "Javier" }],
            [text(JAVIER, at(7), "¿Me llamáis?")],
          ),
        )
      ).statusCode,
    ).toBe(200);
    // El mismo aviso otra vez (Meta reintenta): no se duplica nada.
    expect((await post(first)).statusCode).toBe(200);
    await converted(4);
    await waitFor(async () => {
      const rows = await env.db.execute<{ n: number }>(
        sql`select count(*)::int as n from wa_events where processed_at is null`,
      );
      return rows.rows[0]!.n === 0;
    });

    await syncAll(env, account);
    const rows = await env.db.execute<{
      thread: string;
      from: string;
      subject: string;
      files: number;
    }>(sql`
      select m.thread_id as thread, m.from_address as from, m.subject,
             (select count(*)::int from attachments a where a.message_id = m.id) as files
        from messages m join folder_messages fm on fm.message_id = m.id join folders f on f.id = fm.folder_id
       where f.path = 'WhatsApp' order by m.internal_date`);
    expect(rows.rows.map((row) => [row.from, row.subject, row.files])).toEqual([
      [contactAddress(PILAR), "WhatsApp · Pilar Ferrer (+34 600 111 222)", 0],
      [contactAddress(PILAR), "WhatsApp · Pilar Ferrer (+34 600 111 222)", 1],
      [account.email, "WhatsApp · Pilar Ferrer (+34 600 111 222)", 0],
      [contactAddress(JAVIER), "WhatsApp · Javier (+34 600 333 444)", 0],
    ]);
    const [a, b, c, d] = rows.rows.map((row) => row.thread);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(d).not.toBe(a);
  });
});
