/**
 * Hace de Meta en local para probar el módulo de WhatsApp sin número ni cuenta de verdad:
 * sirve las fotos, documentos y notas de voz como su API de adjuntos, y manda al servidor
 * avisos firmados con conversaciones inventadas de clientes de la demo.
 *
 *   pnpm whatsapp-simulador
 *
 * El servidor tiene que estar en marcha con el módulo `whatsapp` y, en su `.env`,
 * WHATSAPP_GRAPH_URL=http://127.0.0.1:3098 y el mismo WHATSAPP_APP_SECRET que lee este script.
 * Al terminar sigue haciendo de Meta (para contestar desde la aplicación) hasta Ctrl+C;
 * con --salir, termina en cuanto los avisos están guardados.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openRuntime } from "../src/runtime.ts";
import { signBody } from "../src/plugins/whatsapp/meta.ts";
import {
  echoes,
  history,
  incoming,
  location,
  media,
  text,
} from "../src/plugins/whatsapp/simulate.ts";
import { makePdf } from "../test/documents.ts";

const APP = process.env.DEMO_URL ?? "http://127.0.0.1:3055";
const GRAPH_PORT = 3098;
const IMAGES = join(import.meta.dirname, "../../../bench/ocr/casos");
const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);
const secret = env.WHATSAPP_APP_SECRET;
const token = env.WHATSAPP_TOKEN;
if (!secret || !token) {
  console.error(
    "Faltan WHATSAPP_APP_SECRET y WHATSAPP_TOKEN en .env (los mismos que usa el servidor).",
  );
  process.exit(1);
}

/** Una nota de voz de un segundo: un tono, en WAV. */
function tone(): Buffer {
  const rate = 8000;
  const samples = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++)
    samples.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

// El expediente de Construcciones Biel, si la demo está montada: su DNI entra solo por el número.
const runtime = await openRuntime();
const claim =
  (
    await runtime.db.execute<{ claimRef: string | null }>(
      sql`select claim_ref as "claimRef" from exp_cases where title like 'Construcciones Biel%' limit 1`,
    )
  ).rows[0]?.claimRef ?? "ME-26-80269";

const FILES: Record<string, { mime: string; content: Buffer }> = {
  "M-GOLPE-1": {
    mime: "image/jpeg",
    content: readFileSync(join(IMAGES, "d101-camion-blanco-detras.jpg")),
  },
  "M-GOLPE-2": {
    mime: "image/jpeg",
    content: readFileSync(join(IMAGES, "d102-camion-rojo-delante.jpg")),
  },
  "M-PARTE": {
    mime: "image/png",
    content: readFileSync(join(IMAGES, "t308-parte-con-casillas.png")),
  },
  "M-VOZ": { mime: "audio/wav", content: tone() },
  "M-DNI": {
    mime: "application/pdf",
    content: makePdf([
      `DOCUMENTO NACIONAL DE IDENTIDAD (copia). Conductor de Construcciones Biel. Siniestro ${claim}.`,
    ]),
  },
};

// La API de adjuntos de Meta: primero da una dirección, después el fichero (las dos con permiso).
const NAMES: Record<string, string> = {};
const graph = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  // Lo que se contesta desde la aplicación: se acepta y, al poco, el cliente responde.
  if (request.method === "POST" && /\/messages$/.test(request.url ?? "")) {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const sent = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        to: string;
        type: string;
        text?: { body: string };
      };
      const id = `wamid.SIM${Date.now().toString(36).toUpperCase()}`;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages: [{ id }] }));
      console.log(`← la aplicación envía a +${sent.to} (${sent.type}): ${sent.text?.body ?? ""}`);
      if (sent.type === "text") {
        setTimeout(() => {
          void send(
            `+${sent.to} contesta`,
            incoming(
              BUSINESS,
              [{ phone: sent.to, name: NAMES[sent.to] ?? "" }],
              [text(sent.to, new Date(), "Perfecto, muchas gracias.")],
            ),
          );
        }, 4000);
      }
    });
    return;
  }
  if (request.method === "POST" && /\/media$/.test(request.url ?? "")) {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `MEDIA-${Date.now()}` }));
    });
    return;
  }
  const [, first, second] = (request.url ?? "").split("/");
  if (first === "fichero" && second && FILES[second]) {
    response.writeHead(200, { "content-type": FILES[second].mime }).end(FILES[second].content);
  } else if (first && FILES[first]) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        url: `http://127.0.0.1:${GRAPH_PORT}/fichero/${first}`,
        mime_type: FILES[first].mime,
      }),
    );
  } else response.writeHead(404).end();
});
await new Promise<void>((resolve) => graph.listen(GRAPH_PORT, "127.0.0.1", resolve));

const BUSINESS = "34976000100";
const PILAR = { phone: "34600111222", name: "Pilar Ferrer" };
const OSCAR = { phone: "34600555666", name: "Óscar Biel" };
const UNKNOWN = { phone: "34611222333", name: "" };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
NAMES[PILAR.phone] = PILAR.name;
NAMES[OSCAR.phone] = OSCAR.name;

const send = async (label: string, payload: object) => {
  const body = JSON.stringify(payload);
  const response = await fetch(`${APP}/api/plugins/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signBody(body, secret) },
    body,
  });
  console.log(
    `${response.status === 200 ? "✓" : "✗"} ${label}${response.status === 200 ? "" : ` (${response.status})`}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
};

// 1. Al conectar el número llega el historial de los últimos meses.
await send(
  "historial de Pilar (de hace dos meses)",
  history(BUSINESS, [
    {
      phone: PILAR.phone,
      messages: [
        text(
          PILAR.phone,
          ago(60 * 24 * 58),
          "Hola, ¿me podéis mandar el recibo de la flota de este trimestre?",
        ),
        text(
          BUSINESS,
          ago(60 * 24 * 58 - 30),
          "Claro Pilar, te lo mandamos por correo esta tarde.",
          PILAR.phone,
        ),
        text(PILAR.phone, ago(60 * 24 * 58 - 35), "Gracias!"),
      ],
    },
  ]),
);
// 2. Pilar escribe hoy por un golpe; la oficina contesta desde el móvil.
await send(
  "Pilar: golpe en el parking, con fotos, ubicación y nota de voz",
  incoming(
    BUSINESS,
    [PILAR],
    [
      text(
        PILAR.phone,
        ago(95),
        "Buenos días, nos han dado un golpe en el parking del polígono con la Iveco",
      ),
      media(PILAR.phone, ago(94), "image", "M-GOLPE-1", "image/jpeg", {
        caption: "Así ha quedado por detrás",
      }),
      media(PILAR.phone, ago(94), "image", "M-GOLPE-2", "image/jpeg"),
      location(PILAR.phone, ago(93), 41.6177, -0.9465, "Polígono Plaza, calle Turiaso"),
      media(PILAR.phone, ago(92), "audio", "M-VOZ", "audio/wav", { voice: true }),
    ],
  ),
);
await send(
  "respuesta desde el móvil de la oficina",
  echoes(BUSINESS, [
    text(
      BUSINESS,
      ago(80),
      "Recibido Pilar. ¿Os hicisteis el parte amistoso con el otro conductor? Mándanos foto si lo tenéis.",
      PILAR.phone,
    ),
  ]),
);
await send(
  "Pilar: el parte amistoso",
  incoming(
    BUSINESS,
    [PILAR],
    [
      media(PILAR.phone, ago(60), "image", "M-PARTE", "image/png", {
        caption: "Ahí va el parte, firmado por los dos",
      }),
    ],
  ),
);
// 3. Un cliente con expediente abierto manda el DNI citando su número de siniestro.
await send(
  `Óscar: DNI del conductor para el siniestro ${claim}`,
  incoming(
    BUSINESS,
    [OSCAR],
    [
      media(OSCAR.phone, ago(40), "document", "M-DNI", "application/pdf", {
        filename: "DNI_conductor.pdf",
        caption: `Os mando el DNI del conductor para el siniestro ${claim}`,
      }),
    ],
  ),
);
// 4. Un número que no está en la agenda.
await send(
  "número desconocido que pregunta por un seguro",
  incoming(
    BUSINESS,
    [{ phone: UNKNOWN.phone, name: "" }],
    [
      text(
        UNKNOWN.phone,
        ago(20),
        "Buenas tardes, ¿hacéis seguros de hogar? Me ha pasado vuestro número un vecino",
      ),
    ],
  ),
);
await send(
  "respuesta desde el móvil al número desconocido",
  echoes(BUSINESS, [
    text(
      BUSINESS,
      ago(12),
      "Hola, sí. ¿Nos dices tu nombre y la dirección de la vivienda y te preparamos precio?",
      UNKNOWN.phone,
    ),
  ]),
);

// Se sirven los adjuntos hasta que el servidor los haya guardado todos.
for (let waited = 0; waited < 60; waited++) {
  const rows = await runtime.db.execute<{ n: number }>(
    sql`select count(*)::int as n from wa_events where processed_at is null and attempts < 5`,
  );
  if (rows.rows[0]!.n === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const failed = await runtime.db.execute<{ error: string }>(
  sql`select error from wa_events where processed_at is null order by id desc limit 1`,
);
console.log(
  failed.rows[0]
    ? `Quedan avisos sin guardar: ${failed.rows[0].error}`
    : "Todo guardado como correo en la carpeta WhatsApp.",
);
if (process.argv.includes("--salir")) {
  graph.close();
  await runtime.close();
} else {
  console.log(
    "Sigue haciendo de Meta: contesta a un WhatsApp desde la aplicación y el cliente responderá. Ctrl+C para parar.",
  );
}
