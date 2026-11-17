/**
 * Fase 1 — prueba del reflejo con Outlook.
 *
 * Herramienta de consola para comprobar, contra un buzón real que también está
 * abierto en Outlook, que lo que hacemos por IMAP/SMTP se ve en Outlook y al revés.
 * Los resultados se anotan en docs/outlook-reflejo.md.
 *
 * Uso: pnpm reflejo <orden> [argumentos]      (pnpm reflejo ayuda)
 * Configuración: variables REFLEJO_* en .env.reflejo (ver .env.reflejo.example).
 * Sin configuración apunta al buzón de pruebas de Docker (ana@correo.test).
 */
import { randomUUID } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { z } from "zod";
import { detectSpecialUse, type SpecialUse } from "@correo/shared";

// Carga opcional de la configuración del buzón real; sin ella se usa el de Docker.
try {
  process.loadEnvFile(".env.reflejo");
} catch {
  // No hay .env.reflejo: valores por defecto.
}

const flag = z
  .enum(["0", "1", "true", "false"])
  .default("0")
  .transform((value) => value === "1" || value === "true");

const config = z
  .object({
    REFLEJO_IMAP_HOST: z.string().default("127.0.0.1"),
    REFLEJO_IMAP_PORT: z.coerce.number().default(1993),
    REFLEJO_SMTP_HOST: z.string().default("127.0.0.1"),
    REFLEJO_SMTP_PORT: z.coerce.number().default(1587),
    REFLEJO_USER: z.string().default("ana@correo.test"),
    REFLEJO_PASS: z.string().default("prueba-1234"),
    /** Dirección del remitente, si no coincide con el usuario de acceso. */
    REFLEJO_FROM: z.string().optional(),
    /** Aceptar certificados autofirmados. Solo para el servidor de pruebas. */
    REFLEJO_TLS_INSECURE: flag,
  })
  .parse(process.env);

const isDockerDefault = !process.env.REFLEJO_IMAP_HOST;
const tls = { rejectUnauthorized: !(config.REFLEJO_TLS_INSECURE || isDockerDefault) };
const from = config.REFLEJO_FROM ?? config.REFLEJO_USER;

function newClient(): ImapFlow {
  return new ImapFlow({
    host: config.REFLEJO_IMAP_HOST,
    port: config.REFLEJO_IMAP_PORT,
    secure: config.REFLEJO_IMAP_PORT === 993 || config.REFLEJO_IMAP_PORT === 1993,
    tls,
    auth: { user: config.REFLEJO_USER, pass: config.REFLEJO_PASS },
    // Con QRESYNC el servidor identifica por uid los cambios que notifica.
    qresync: true,
    logger: false,
  });
}

function newTransport() {
  return nodemailer.createTransport({
    host: config.REFLEJO_SMTP_HOST,
    port: config.REFLEJO_SMTP_PORT,
    secure: config.REFLEJO_SMTP_PORT === 465,
    requireTLS: config.REFLEJO_SMTP_PORT !== 465,
    tls,
    auth: { user: config.REFLEJO_USER, pass: config.REFLEJO_PASS },
  });
}

async function withClient<T>(run: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = newClient();
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function withFolder<T>(path: string, run: (client: ImapFlow) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      return await run(client);
    } finally {
      lock.release();
    }
  });
}

async function findFolder(client: ImapFlow, use: SpecialUse): Promise<ListResponse> {
  const folders = await client.list();
  const found = folders.find((folder) => detectSpecialUse(folder) === use);
  if (!found) throw new Error(`No encuentro la carpeta de tipo «${use}» en este buzón.`);
  return found;
}

const now = () => new Date().toLocaleTimeString("es-ES", { hour12: false });

function describeMessage(message: FetchMessageObject): string {
  const sender = message.envelope?.from?.[0];
  const date = message.internalDate ? new Date(message.internalDate).toLocaleString("es-ES") : "";
  const flags = [...(message.flags ?? [])].join(" ") || "(sin marcas)";
  return [
    `uid ${String(message.uid).padStart(6)}`,
    date.padEnd(20),
    (sender?.address ?? "").slice(0, 30).padEnd(30),
    (message.envelope?.subject ?? "").slice(0, 50).padEnd(50),
    flags,
  ].join("  ");
}

/** Construye el mensaje una sola vez; esos mismos bytes se envían y se guardan. */
async function buildRaw(options: Mail.Options): Promise<{ raw: Buffer; messageId: string }> {
  const domain = from.split("@")[1] ?? "localhost";
  const messageId = `<${randomUUID()}@${domain}>`;
  const raw = await new MailComposer({
    ...options,
    from,
    messageId,
    headers: { "X-Correo-Origen": "reflejo-fase1", ...(options.headers as object) },
  })
    .compile()
    .build();
  return { raw, messageId };
}

/** Envía y deja copia en Enviados, sin duplicar si el servidor ya la guarda solo. */
async function sendAndFile(raw: Buffer, messageId: string, to: string[]): Promise<void> {
  const transport = newTransport();
  const info = await transport.sendMail({ envelope: { from, to }, raw });
  transport.close();
  console.log(`Enviado. Respuesta del servidor: ${info.response}`);

  await withClient(async (client) => {
    const sent = await findFolder(client, "sent");
    const lock = await client.getMailboxLock(sent.path);
    try {
      // Algunos servidores guardan la copia ellos mismos; se le da un margen antes de mirar.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await client.noop();
      const existing = await client.search({ header: { "message-id": messageId } }, { uid: true });
      if (existing && existing.length > 0) {
        console.log(
          `El servidor ya guardó la copia en «${sent.path}» (uid ${existing.join(", ")}). No se sube otra.`,
        );
        return;
      }
      const result = await client.append(sent.path, raw, ["\\Seen"]);
      console.log(
        `Copia subida a «${sent.path}»${result && result.uid ? ` con uid ${result.uid}` : ""}.`,
      );
    } finally {
      lock.release();
    }
  });
}

const SAMPLE_HTML = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#000">
<p>Buenos días:</p>
<p>Este es un correo de prueba enviado desde <b>nuestra aplicación</b> para comprobar cómo lo muestra Outlook.</p>
<table style="border-collapse:collapse" cellpadding="6">
<tr><td style="border:1px solid #999"><b>Siniestro</b></td><td style="border:1px solid #999">SIN-2026-0142</td></tr>
<tr><td style="border:1px solid #999"><b>Estado</b></td><td style="border:1px solid #999">Pendiente de peritación</td></tr>
</table>
<ul><li>Acentos y eñes: póliza, daños, compañía.</li><li>Un <a href="https://example.com/">enlace</a>.</li></ul>
<p>Un saludo,<br>Prueba de reflejo</p>
</div>`;

const SAMPLE_TEXT = `Buenos días:

Este es un correo de prueba enviado desde nuestra aplicación para comprobar cómo lo muestra Outlook.

Siniestro: SIN-2026-0142
Estado: Pendiente de peritación

Un saludo,
Prueba de reflejo`;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const commands: Record<string, { help: string; run: (args: string[]) => Promise<void> }> = {
  info: {
    help: "info — capacidades del servidor, carpetas y su papel",
    run: async () =>
      withClient(async (client) => {
        console.log(`Buzón: ${config.REFLEJO_USER} en ${config.REFLEJO_IMAP_HOST}`);
        console.log(`Servidor: ${JSON.stringify(client.serverInfo ?? {})}`);
        console.log(`\nCapacidades:\n  ${[...client.capabilities.keys()].sort().join(" ")}`);
        const wanted = [
          "IDLE",
          "CONDSTORE",
          "QRESYNC",
          "MOVE",
          "UIDPLUS",
          "SPECIAL-USE",
          "OBJECTID",
        ];
        console.log("\nLas que usa la sincronización:");
        for (const name of wanted) {
          console.log(`  ${client.capabilities.has(name) ? "sí" : "NO"}  ${name}`);
        }
        console.log("\nCarpetas:");
        for (const folder of await client.list()) {
          const status = await client
            .status(folder.path, { messages: true, unseen: true, uidValidity: true })
            .catch(() => null);
          console.log(
            [
              `  ${folder.path.padEnd(32)}`,
              `papel: ${(detectSpecialUse(folder) ?? "-").padEnd(8)}`,
              `anunciado: ${(folder.specialUse ?? "-").padEnd(10)}`,
              `suscrita: ${folder.subscribed ? "sí" : "no"}`,
              `separador: ${folder.delimiter}`,
              status
                ? `correos: ${status.messages} (${status.unseen} sin leer)`
                : "(no seleccionable)",
            ].join("  "),
          );
        }
      }),
  },

  listar: {
    help: "listar [carpeta=INBOX] [n=15] — últimos correos con su uid y marcas",
    run: async ([path = "INBOX", count = "15"]) =>
      withFolder(path, async (client) => {
        const total = client.mailbox ? client.mailbox.exists : 0;
        if (total === 0) return console.log("Carpeta vacía.");
        const first = Math.max(1, total - Number(count) + 1);
        for await (const message of client.fetch(`${first}:*`, {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
        })) {
          console.log(describeMessage(message));
        }
      }),
  },

  marcar: {
    help: "marcar <uid> <leido|no-leido|destacado|no-destacado> [carpeta=INBOX]",
    run: async ([uid, state, path = "INBOX"]) => {
      if (!uid || !state) throw new Error("Faltan argumentos: marcar <uid> <estado>");
      const flagName = state.includes("destacado") ? "\\Flagged" : "\\Seen";
      await withFolder(path, async (client) => {
        const ok = state.startsWith("no-")
          ? await client.messageFlagsRemove(uid, [flagName], { uid: true })
          : await client.messageFlagsAdd(uid, [flagName], { uid: true });
        console.log(
          ok ? `Hecho: uid ${uid} → ${state}. Míralo en Outlook.` : "El servidor no lo aplicó.",
        );
      });
    },
  },

  mover: {
    help: "mover <uid> <carpeta destino> [carpeta origen=INBOX]",
    run: async ([uid, destination, path = "INBOX"]) => {
      if (!uid || !destination) throw new Error("Faltan argumentos: mover <uid> <destino>");
      await withFolder(path, async (client) => {
        console.log(
          `El servidor ${client.capabilities.has("MOVE") ? "soporta" : "NO soporta"} MOVE.`,
        );
        const result = await client.messageMove(uid, destination, { uid: true });
        if (!result) return console.log("El servidor no lo movió. ¿Existe la carpeta de destino?");
        const mapped = result.uidMap ? [...result.uidMap.entries()] : [];
        console.log(
          `Movido a «${destination}».` +
            (mapped.length ? ` uid nuevo: ${mapped.map(([a, b]) => `${a}→${b}`).join(", ")}` : ""),
        );
      });
    },
  },

  borrar: {
    help: "borrar <uid> [carpeta=INBOX] — lo manda a la papelera",
    run: async ([uid, path = "INBOX"]) => {
      if (!uid) throw new Error("Falta el uid.");
      await withClient(async (client) => {
        const trash = await findFolder(client, "trash");
        const lock = await client.getMailboxLock(path);
        try {
          const result = await client.messageMove(uid, trash.path, { uid: true });
          console.log(result ? `Enviado a «${trash.path}».` : "El servidor no lo movió.");
        } finally {
          lock.release();
        }
      });
    },
  },

  "crear-carpeta": {
    help: "crear-carpeta <nombre> — para ver si Outlook la muestra",
    run: async ([name]) => {
      if (!name) throw new Error("Falta el nombre.");
      await withClient(async (client) => {
        const result = await client.mailboxCreate(name);
        console.log(`Carpeta «${result.path}» ${result.created ? "creada" : "ya existía"}.`);
      });
    },
  },

  borrador: {
    help: "borrador [destinatario] — sube un borrador a la carpeta de borradores",
    run: async ([to = from]) => {
      const { raw, messageId } = await buildRaw({
        to,
        subject: `Borrador de prueba ${now()}`,
        text: SAMPLE_TEXT,
        html: SAMPLE_HTML,
      });
      await withClient(async (client) => {
        const drafts = await findFolder(client, "drafts");
        const result = await client.append(drafts.path, raw, ["\\Draft", "\\Seen"]);
        console.log(
          `Borrador subido a «${drafts.path}»${result && result.uid ? ` con uid ${result.uid}` : ""} (${messageId}).`,
        );
        console.log(
          "Comprueba en Outlook: ¿aparece en Borradores?, ¿se puede abrir, editar y enviar?",
        );
      });
    },
  },

  enviar: {
    help: "enviar <destinatario> — envía un correo HTML de muestra y deja copia en Enviados",
    run: async ([to]) => {
      if (!to) throw new Error("Falta el destinatario.");
      const { raw, messageId } = await buildRaw({
        to,
        subject: `Prueba de reflejo ${now()}`,
        text: SAMPLE_TEXT,
        html: SAMPLE_HTML,
      });
      await sendAndFile(raw, messageId, [to]);
      console.log("Comprueba en Outlook: Enviados (¿una sola copia?) y el aspecto del correo.");
    },
  },

  responder: {
    help: "responder <uid> [carpeta=INBOX] — responde citando el original al estilo Outlook",
    run: async ([uid, path = "INBOX"]) => {
      if (!uid) throw new Error("Falta el uid.");
      const original = await withFolder(path, async (client) => {
        const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!message || !message.source) throw new Error(`No existe el uid ${uid} en «${path}».`);
        return simpleParser(message.source);
      });

      const replyTo = original.replyTo?.value[0]?.address ?? original.from?.value[0]?.address;
      if (!replyTo) throw new Error("El original no tiene remitente.");
      const subject = /^re:/i.test(original.subject ?? "")
        ? (original.subject ?? "")
        : `RE: ${original.subject ?? ""}`;
      const sentOn = original.date?.toLocaleString("es-ES", {
        dateStyle: "full",
        timeStyle: "short",
      });
      const toList = Array.isArray(original.to)
        ? original.to.map((entry) => entry.text).join("; ")
        : (original.to?.text ?? "");
      const header = [
        `<b>De:</b> ${escapeHtml(original.from?.text ?? "")}`,
        `<b>Enviado el:</b> ${escapeHtml(sentOn ?? "")}`,
        `<b>Para:</b> ${escapeHtml(toList)}`,
        `<b>Asunto:</b> ${escapeHtml(original.subject ?? "")}`,
      ].join("<br>");
      const quotedBody =
        original.html ||
        `<pre style="font-family:inherit">${escapeHtml(original.text ?? "")}</pre>`;

      const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">
<p>Recibido, gracias. Respuesta de prueba enviada desde nuestra aplicación.</p></div>
<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm;font-family:Calibri,Arial,sans-serif;font-size:11pt">
<p>${header}</p></div>
<div>${quotedBody}</div>`;
      const text = `Recibido, gracias. Respuesta de prueba enviada desde nuestra aplicación.

De: ${original.from?.text ?? ""}
Enviado el: ${sentOn ?? ""}
Asunto: ${original.subject ?? ""}

${(original.text ?? "").replace(/^/gm, "> ")}`;

      const references = [original.references ?? [], original.messageId ?? []].flat();
      const { raw, messageId } = await buildRaw({
        to: replyTo,
        subject,
        text,
        html,
        ...(original.messageId ? { inReplyTo: original.messageId } : {}),
        references,
      });
      await sendAndFile(raw, messageId, [replyTo]);

      await withFolder(path, async (client) => {
        await client.messageFlagsAdd(uid, ["\\Answered"], { uid: true });
      });
      console.log("Original marcado como respondido. Comprueba en Outlook el icono y el hilo.");
    },
  },

  vigilar: {
    help: "vigilar [carpeta=INBOX] — muestra en vivo lo que cambia (haz cambios en Outlook)",
    run: async ([path = "INBOX"]) => {
      const client = newClient();
      await client.connect();
      await client.mailboxOpen(path);
      console.log(
        `Vigilando «${path}». Haz cambios en Outlook y anota la hora. Ctrl+C para salir.`,
      );
      console.log(
        `IDLE ${client.capabilities.has("IDLE") ? "disponible" : "NO disponible (sondeo)"}.`,
      );
      client.on("exists", (event) => {
        console.log(`${now()}  correos: ${event.prevCount} → ${event.count}`);
      });
      client.on("expunge", (event) => {
        const which = event.uid ? `uid ${event.uid}` : `posición ${event.seq}`;
        console.log(`${now()}  ya no está en la carpeta: ${which}`);
      });
      client.on("flags", (event) => {
        const flags = [...event.flags].join(" ") || "(sin marcas)";
        console.log(`${now()}  marcas de uid ${event.uid ?? "?"}: ${flags}`);
      });
      client.on("close", () => {
        console.log(`${now()}  el servidor cerró la conexión.`);
        process.exit(1);
      });
      process.on("SIGINT", () => {
        void client.logout().finally(() => process.exit(0));
      });
      // IDLE explícito: sin él la librería tarda unos segundos en empezar a escuchar.
      for (;;) await client.idle();
    },
  },

  conexiones: {
    help: "conexiones [máximo=20] — cuántas conexiones simultáneas admite el buzón (con Outlook abierto)",
    run: async ([max = "20"]) => {
      const open: ImapFlow[] = [];
      try {
        for (let index = 1; index <= Number(max); index++) {
          const client = newClient();
          try {
            await client.connect();
            await client.mailboxOpen("INBOX");
            open.push(client);
            console.log(`Conexión ${index}: abierta`);
          } catch (error) {
            console.log(`Conexión ${index}: RECHAZADA — ${(error as Error).message}`);
            console.log(
              `Límite práctico: ${open.length} conexiones nuestras, además de las de Outlook.`,
            );
            return;
          }
        }
        console.log(`Sin límite alcanzado con ${open.length} conexiones.`);
      } finally {
        await Promise.all(open.map((client) => client.logout().catch(() => undefined)));
      }
    },
  },
};

async function main(): Promise<void> {
  const [name = "ayuda", ...args] = process.argv.slice(2);
  const command = commands[name];
  if (!command) {
    console.log("Órdenes disponibles:\n");
    for (const entry of Object.values(commands)) console.log(`  ${entry.help}`);
    console.log(`\nBuzón actual: ${config.REFLEJO_USER} en ${config.REFLEJO_IMAP_HOST}`);
    return;
  }
  await command.run(args);
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
