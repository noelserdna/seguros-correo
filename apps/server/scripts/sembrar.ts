/**
 * Envía correos de prueba con adjuntos de muchos tipos, repartidos entre los buzones
 * conectados: cada uno escribe al siguiente. Sirve para ver cómo se comporta el procesado
 * con lo que se sabe leer y con lo que no.
 *
 *   pnpm sembrar <carpeta> [cuántos]      Envía (por defecto, 100)
 *   pnpm sembrar <carpeta> 100 --simular  Solo enseña lo que enviaría
 *
 * La carpeta trae las fotos, planos y escaneados (jpg, png, pdf, tiff, webp, gif, bmp).
 * El resto de adjuntos se generan aquí.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAuth } from "../src/accounts/auth.ts";
import { accounts } from "../src/db/schema.ts";
import { smtpTransportFor } from "../src/outbound/mime.ts";
import { openRuntime } from "../src/runtime.ts";
import { makeDocx, makePdf, makeXlsx } from "../test/documents.ts";

type File = { filename: string; content: Buffer; contentType?: string };

const [folder, countArg] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const dryRun = process.argv.includes("--simular");
const total = Number(countArg ?? 100);
if (!folder || !Number.isInteger(total) || total < 1) {
  console.error("Uso: pnpm sembrar <carpeta con imágenes y escaneados> [cuántos] [--simular]");
  process.exit(1);
}

const samples = readdirSync(folder).sort();
const sample = (prefix: string, extension: string, index: number): File => {
  const matches = samples.filter((name) => name.startsWith(prefix) && name.endsWith(extension));
  if (matches.length === 0) throw new Error(`Faltan ficheros ${prefix}*${extension} en ${folder}`);
  const name = matches[index % matches.length]!;
  return { filename: name, content: readFileSync(join(folder, name)) };
};

const CLIENTES = [
  "Transportes Río Cinca",
  "Cooperativa Somontano",
  "Talleres Monzón",
  "Cerámicas Turia",
  "Distribuciones Moncayo",
  "Almacenes Ebro",
  "Frutas del Jalón",
  "Hormigones Gállego",
];
const ASEGURADORAS = ["Seguros Albor", "Mutua del Ebro", "Aseguradora Pirineo"];
const MATRICULAS = ["4471-KLM", "9920-HTR", "1830-JCD", "6612-LBN", "3057-MFG"];
const pick = <T>(list: T[], index: number): T => list[index % list.length]!;
const euros = (index: number) => `${(480 + ((index * 137) % 9000)).toLocaleString("es-ES")},00 €`;

/** Adjuntos que la aplicación sabe leer. Cada uno lleva el número para que no se repitan. */
const READABLE: ((index: number) => File | Promise<File>)[] = [
  (i) => ({
    filename: `Presupuesto_${2026000 + i}.pdf`,
    content: makePdf([
      `Presupuesto de reparacion ${2026000 + i} para ${pick(CLIENTES, i)}`,
      `Vehiculo ${pick(MATRICULAS, i)}. Sustitucion de panel lateral y pintura. Total ${euros(i)}`,
    ]),
  }),
  (i) => ({
    filename: `Poliza_${88000 + i}.pdf`,
    content: makePdf([
      `Condiciones particulares de la poliza 88/${223000 + i} de ${pick(ASEGURADORAS, i)}`,
      `Tomador ${pick(CLIENTES, i)}. Cobertura de danos propios y responsabilidad civil.`,
      `Franquicia de ${euros(i)} por siniestro. Vencimiento anual el 1 de marzo.`,
    ]),
  }),
  (i) => ({
    filename: `Informe_pericial_${i}.docx`,
    content: makeDocx([
      `Informe pericial del siniestro 2026/${1400 + i}`,
      `El perito visitó las instalaciones de ${pick(CLIENTES, i)} y valoró los daños en ${euros(i)}.`,
      "Se recomienda la reparación en taller concertado.",
    ]),
  }),
  async (i) => ({
    filename: `Relacion_de_danos_${i}.xlsx`,
    content: await makeXlsx({
      Daños: [
        ["Concepto", "Unidades", "Importe"],
        ["Panel lateral derecho", 1, 480 + i],
        ["Pintura", 1, 310 + i],
        ["Mano de obra (horas)", 6 + (i % 5), 45],
      ],
      Resumen: [
        ["Siniestro", `2026/${1400 + i}`],
        ["Cliente", pick(CLIENTES, i)],
      ],
    }),
  }),
  (i) => ({
    filename: `notas_llamada_${i}.txt`,
    content: Buffer.from(
      `Llamada con ${pick(CLIENTES, i)} sobre el siniestro 2026/${1400 + i}.\n` +
        `Confirman que el vehículo ${pick(MATRICULAS, i)} sigue parado. Piden fecha para el perito.\n`,
    ),
    contentType: "text/plain; charset=utf-8",
  }),
  (i) => ({
    filename: `movimientos_${i}.csv`,
    content: Buffer.from(
      `fecha;concepto;importe\n2026-11-${String((i % 27) + 1).padStart(2, "0")};Indemnización siniestro 2026/${1400 + i};${480 + i}\n2026-11-28;Franquicia;-300\n`,
    ),
    contentType: "text/csv; charset=utf-8",
  }),
  (i) => ({
    filename: `comunicado_${i}.html`,
    content: Buffer.from(
      `<html><body><h1>Comunicado de ${pick(ASEGURADORAS, i)}</h1><p>Hemos registrado el siniestro <b>2026/${1400 + i}</b> con la referencia 88/${223000 + i}.</p></body></html>`,
    ),
    contentType: "text/html; charset=utf-8",
  }),
  (i) => ({
    filename: `correo_original_${i}.eml`,
    content: Buffer.from(
      `From: taller@example.test\r\nTo: siniestros@example.test\r\nSubject: Recogida del vehículo ${pick(MATRICULAS, i)}\r\n` +
        `Date: Mon, 16 Nov 2026 09:00:00 +0100\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n` +
        `El vehículo estará listo el viernes. Importe final ${euros(i)}.\r\n`,
    ),
    contentType: "message/rfc822",
  }),
];

const noise = (index: number, size: number) =>
  Buffer.from(Array.from({ length: size }, (_, at) => (index * 31 + at * 17) % 256));

/** Adjuntos que hoy no se saben leer: imágenes, escaneados y formatos sin soporte. */
const UNREADABLE: ((index: number) => File)[] = [
  (i) => sample("foto_", ".jpg", i),
  (i) => sample("plano_", ".png", i),
  (i) => sample("escaneado_", ".pdf", i),
  (i) => sample("foto_", ".webp", i),
  (i) => sample("plano_", ".tiff", i),
  (i) => sample("captura_", ".gif", i),
  (i) => sample("croquis_", ".bmp", i),
  (i) => sample("foto_", ".jpg", i + 5),
  (i) => sample("escaneado_", ".pdf", i + 3),
  // Formatos sin soporte: el contenido es de relleno, solo importa el tipo.
  (i) => ({
    filename: `documentacion_${i}.zip`,
    content: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), noise(i, 600)]),
    contentType: "application/zip",
  }),
  (i) => ({
    filename: `Contrato_antiguo_${i}.doc`,
    content: Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      noise(i, 900),
    ]),
    contentType: "application/msword",
  }),
  (i) => ({
    filename: `plano_nave_${i}.dwg`,
    content: Buffer.concat([Buffer.from("AC1027", "latin1"), noise(i, 1200)]),
    contentType: "application/acad",
  }),
  (i) => ({
    filename: `nota_de_voz_${i}.mp3`,
    content: Buffer.concat([Buffer.from("ID3", "latin1"), noise(i, 2000)]),
    contentType: "audio/mpeg",
  }),
  // Un PDF roto: empieza como PDF pero no se puede abrir.
  (i) => ({
    filename: `factura_danada_${i}.pdf`,
    content: Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), noise(i, 400)]),
    contentType: "application/pdf",
  }),
];

const SUBJECTS = [
  (i: number) => `Siniestro 2026/${1400 + i} · Parte de daños del vehículo ${pick(MATRICULAS, i)}`,
  (i: number) => `Ref. 88/${223000 + i} · Documentación solicitada`,
  (i: number) => `Presupuesto de reparación ${pick(MATRICULAS, i)}`,
  (i: number) => `Fotos del golpe · ${pick(CLIENTES, i)}`,
  (i: number) => `Informe pericial del siniestro 2026/${1400 + i}`,
  (i: number) => `Plano de la nave y relación de daños · ${pick(CLIENTES, i)}`,
  (i: number) => `Renovación de la póliza 88/${223000 + i}`,
];
const BODIES = [
  (i: number) =>
    `Buenos días:\n\nOs envío la documentación del siniestro 2026/${1400 + i} de ${pick(CLIENTES, i)}. ` +
    `El vehículo ${pick(MATRICULAS, i)} sigue parado; ¿sabéis cuándo podrá pasar el perito?\n\nUn saludo.`,
  (i: number) =>
    `Hola:\n\nAdjunto lo que nos pedía ${pick(ASEGURADORAS, i)} para la referencia 88/${223000 + i}. ` +
    `Si falta algo, decídmelo y lo reclamo al cliente.\n\nGracias.`,
  (i: number) =>
    `Buenas tardes:\n\nVa el presupuesto del taller, por ${euros(i)}, y las fotos que hicimos en la visita. ` +
    `Quedamos a la espera de la conformidad.\n\nSaludos.`,
];

/** Qué adjuntos lleva cada correo: mezcla de legibles, ilegibles y los dos a la vez. */
async function attachmentsFor(index: number): Promise<File[]> {
  const readable = () => READABLE[index % READABLE.length]!(index);
  const unreadable = (shift = 0) => UNREADABLE[(index + shift) % UNREADABLE.length]!(index);
  switch (index % 5) {
    case 0:
      return [await readable()];
    case 1:
      return [unreadable()];
    case 2:
      return [await readable(), unreadable()];
    case 3:
      return [unreadable(), unreadable(4), await readable()];
    default:
      return [await READABLE[(index + 3) % READABLE.length]!(index + 500), await readable()];
  }
}

const runtime = await openRuntime();
try {
  const mailboxes = (await runtime.db.select().from(accounts)).filter(
    (account) => account.state !== "auth_error",
  );
  if (mailboxes.length < 2) throw new Error("Hacen falta al menos dos buzones conectados.");
  console.log(`Buzones: ${mailboxes.map((account) => account.email).join(", ")}`);

  const sent = new Map<string, number>();
  const kinds = new Map<string, number>();
  let failed = 0;
  for (let index = 0; index < total; index++) {
    const from = mailboxes[index % mailboxes.length]!;
    const to = mailboxes[(index + 1) % mailboxes.length]!;
    const files = await attachmentsFor(index);
    for (const file of files) {
      const extension = file.filename.split(".").pop()!;
      kinds.set(extension, (kinds.get(extension) ?? 0) + 1);
    }
    const subject = `[Prueba ${String(index + 1).padStart(3, "0")}] ${pick(SUBJECTS, index)(index)}`;
    if (dryRun) {
      console.log(
        `${from.email} → ${to.email} · ${subject} · ${files.map((f) => f.filename).join(", ")}`,
      );
      continue;
    }
    try {
      // El permiso se pide en cada envío: los de Google y Microsoft caducan en una hora.
      const transport = smtpTransportFor(from, await resolveAuth(runtime, from));
      await transport.sendMail({
        from: from.email,
        to: to.email,
        subject,
        text: pick(BODIES, index)(index),
        attachments: files,
      });
      transport.close();
      sent.set(to.email, (sent.get(to.email) ?? 0) + 1);
      process.stdout.write(`\r${index + 1}/${total} enviados`);
    } catch (error) {
      failed++;
      console.error(`\nNo se pudo enviar el ${index + 1} desde ${from.email}:`, String(error));
    }
    // Sin prisa: los proveedores frenan las ráfagas.
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  console.log(`\nRecibidos por buzón: ${JSON.stringify(Object.fromEntries(sent))}`);
  console.log(`Adjuntos por tipo: ${JSON.stringify(Object.fromEntries(kinds))}`);
  console.log(`Con error: ${failed}`);
} finally {
  await runtime.close();
}
