/**
 * Datos de demostración: un buzón «Siniestros» en el servidor de correo de Docker con
 * decenas de siniestros inventados, cada uno con sus correos, documentos y fotos, y su
 * tramitación llevada hasta distintos puntos, con notas, esperas, pruebas y cierres.
 *
 *   pnpm demo correos       Crea el buzón, lo llena (fechas de las últimas semanas) y lo conecta
 *   pnpm demo expedientes   Con el servidor en marcha: abre y lleva los expedientes
 *
 * Todo es inventado: personas, empresas, matrículas, direcciones (.example) y documentos.
 * Volver a lanzarlo vacía el buzón de demostración y empieza de cero.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { createAccount } from "../src/accounts/accounts.ts";
import { createUser } from "../src/auth/users.ts";
import { accountAccess, accounts, users } from "../src/db/schema.ts";
import { addCalendarDays, type Day } from "../src/plugins/tramitacion/days.ts";
import { openRuntime } from "../src/runtime.ts";
import { runSyncCycle } from "../src/sync/cycle.ts";
import { makeDocx, makePdf, makeXlsx } from "../test/documents.ts";

const MAILBOX = "siniestros@correo.test";
const MAILBOX_PASS = process.env.TEST_MAIL_PASSWORD ?? "prueba-1234";
const OFFICE = { name: "Siniestros · Correduría Albar", address: MAILBOX };
const APP = process.env.DEMO_URL ?? "http://127.0.0.1:3055";
const IMAGES = join(import.meta.dirname, "../../../bench/ocr/casos");

// ------------------------------------------------------------------ fechas

/** Hoy en España. Los correos y los pasos se fechan hacia atrás desde aquí. */
const TODAY: Day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(
  new Date(),
);
/** Una hora de un día; nunca más tarde que ahora (los correos de hoy llegan antes de este momento). */
const at = (day: Day, hour: number, minute = 0) => {
  const date = new Date(
    `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+01:00`,
  );
  const latest = Date.now() - 10 * 60_000;
  return date.getTime() > latest ? new Date(latest - (23 - hour) * 60_000) : date;
};

// ------------------------------------------------------------------ el mundo inventado

type Party = { name: string; address: string };
const party = (name: string, address: string): Party => ({ name, address });

const INSURERS = [
  party("Seguros Albor", "siniestros@segurosalbor.example"),
  party("Mutua del Ebro", "tramitacion@mutuaebro.example"),
  party("Aseguradora Pirineo", "autos@pirineoseguros.example"),
];
const OPPOSING = [
  party("Levante Seguros", "reclamaciones@levanteseguros.example"),
  party("Atlántica Mutual", "siniestros@atlanticamutual.example"),
  party("Cantábrica de Seguros", "autos@cantabrica.example"),
];
const EXPERTS = [
  party("Peritaciones Norte", "peritaciones@peritacionesnorte.example"),
  party("Gabinete Pericial Ebro", "gabinete@gabineteebro.example"),
  party("Tasaciones Moncayo", "peritos@tasacionesmoncayo.example"),
];
const GARAGES = [
  party("Talleres Ebro", "taller@tallereseebro.example"),
  party("Carrocerías Delicias", "citas@carroceriasdelicias.example"),
  party("Auto Gállego", "recepcion@autogallego.example"),
  party("Chapa y Pintura Cinca", "taller@chapacinca.example"),
];
const POLICE = [
  party("Policía Local de Zaragoza", "atestados@policialocal-zgz.example"),
  party("Guardia Civil · Tráfico Huesca", "trafico-huesca@guardiacivil.example"),
];
const LAWYER = party("Bufete Lanuza", "despacho@bufetelanuza.example");
const TOW = party("Grúas Rápidas", "avisos@gruasrapidas.example");

type Client = { company: string; person: string; address: string; plate: string; car: string };
const CLIENTS: Client[] = [
  [
    "Transportes Río Cinca",
    "Pilar Ferrer",
    "pilar.ferrer@riocinca.example",
    "4471-KLM",
    "Iveco Daily",
  ],
  [
    "Cooperativa Somontano",
    "Javier Lasierra",
    "jlasierra@coopsomontano.example",
    "9920-HTR",
    "Renault Master",
  ],
  ["Talleres Monzón", "Elena Puyol", "elena@tallermonzon.example", "1830-JCD", "Ford Transit"],
  [
    "Cerámicas Turia",
    "Andrés Cebrián",
    "acebrian@ceramicasturia.example",
    "6612-LBN",
    "Citroën Jumper",
  ],
  [
    "Distribuciones Moncayo",
    "Raquel Ibáñez",
    "raquel.ibanez@distmoncayo.example",
    "3057-MFG",
    "Mercedes Sprinter",
  ],
  [
    "Almacenes Ebro",
    "Luis Arnal",
    "larnal@almacenesebro.example",
    "7724-KZP",
    "Volkswagen Crafter",
  ],
  [
    "Frutas del Jalón",
    "Marisa Gracia",
    "marisa@frutasjalon.example",
    "2290-LCT",
    "Iveco Eurocargo",
  ],
  [
    "Hormigones Gállego",
    "Tomás Bielsa",
    "tbielsa@hormigonesgallego.example",
    "5518-JRW",
    "MAN TGS",
  ],
  [
    "Panadería Lacasa",
    "Carmen Lacasa",
    "carmen@panaderialacasa.example",
    "8045-KDN",
    "Peugeot Partner",
  ],
  [
    "Fontanería Ballarín",
    "Sergio Ballarín",
    "sergio@fontaneriaballarin.example",
    "3381-LGF",
    "Renault Kangoo",
  ],
  [
    "Mensajería Ordesa",
    "Nuria Sancho",
    "nsancho@mensajeriaordesa.example",
    "6127-MBX",
    "Fiat Ducato",
  ],
  ["Viveros Alcañiz", "Ramón Celma", "rcelma@viverosalcaniz.example", "1904-KHL", "Nissan Cabstar"],
  [
    "Electricidad Tena",
    "Laura Tena",
    "laura@electricidadtena.example",
    "4402-LPS",
    "Citroën Berlingo",
  ],
  [
    "Construcciones Biel",
    "Óscar Biel",
    "obiel@construccionesbiel.example",
    "7781-JVM",
    "Toyota Hilux",
  ],
  [
    "Lavandería Calatayud",
    "Rosa Millán",
    "rosa@lavanderiacalatayud.example",
    "2654-MCK",
    "Opel Vivaro",
  ],
  [
    "Autocares Aínsa",
    "Daniel Coscujuela",
    "dcoscujuela@autocaresainsa.example",
    "9013-KTB",
    "Setra S 515",
  ],
  ["Farmacia Ruiz Escó", "Beatriz Escó", "beatriz@farmaciaesco.example", "5560-LWD", "Seat Arona"],
  [
    "Gestoría Andrade",
    "Pablo Andrade",
    "pablo@gestoriaandrade.example",
    "1278-MDH",
    "Skoda Octavia",
  ],
  [
    "Bodegas Valdejalón",
    "Inés Pardo",
    "ipardo@bodegasvaldejalon.example",
    "6639-JZK",
    "Renault Trafic",
  ],
  ["Limpiezas Huerva", "Alberto Royo", "aroyo@limpiezashuerva.example", "3315-LNR", "Dacia Dokker"],
  [
    "Imprenta Lalueza",
    "Silvia Lalueza",
    "silvia@imprentalalueza.example",
    "8876-KCV",
    "Ford Transit Connect",
  ],
  ["Cárnicas Jaca", "Fernando Abadía", "fabadia@carnicasjaca.example", "2047-MFT", "Mercedes Vito"],
  [
    "Mudanzas Tarazona",
    "Patricia Sanz",
    "psanz@mudanzastarazona.example",
    "7192-LKX",
    "Iveco Daily 70C",
  ],
  [
    "Clínica Dental Arguis",
    "Marta Arguis",
    "marta@dentalarguis.example",
    "4825-KPB",
    "Tesla Model 3",
  ],
  [
    "Ferretería Barbastro",
    "José Lacoma",
    "jlacoma@ferreteriabarbastro.example",
    "6390-JMN",
    "Citroën Nemo",
  ],
  ["Granja Castejón", "Ana Castejón", "ana@granjacastejon.example", "1156-LTG", "John Deere 6R"],
  ["Catering Moncayo", "Víctor Gil", "victor@cateringmoncayo.example", "9478-MBR", "Fiat Talento"],
  [
    "Ascensores Ebro",
    "Lucía Marín",
    "lmarin@ascensoresebro.example",
    "3704-KWS",
    "Volkswagen Caddy",
  ],
  ["Papelera del Cinca", "Héctor Laplana", "hlaplana@papeleracinca.example", "5281-LDC", "DAF XF"],
  [
    "Hotel Peña Oroel",
    "Cristina Oliván",
    "cristina@hotelpenaoroel.example",
    "8613-JGF",
    "Mercedes Clase V",
  ],
  [
    "Huevos Monegros",
    "Rubén Lafuente",
    "rlafuente@huevosmonegros.example",
    "2532-MHN",
    "Isuzu NPR",
  ],
  [
    "Ortopedia Zaragoza",
    "Teresa Alcubierre",
    "teresa@ortopediazgz.example",
    "7046-LBV",
    "Renault Zoe",
  ],
].map(([company, person, address, plate, car]) => ({
  company: company!,
  person: person!,
  address: address!,
  plate: plate!,
  car: car!,
}));

const PHOTOS = [
  "d101-camion-blanco-detras.jpg",
  "d102-camion-rojo-delante.jpg",
  "d202-luna-rota.jpg",
  "d401-camion-de-noche.jpg",
  "t301-foto-movil.jpg",
];
const image = (name: string) => readFileSync(join(IMAGES, name));
/** El PDF mínimo solo lleva texto sin acentos. */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ºª€]/g, (c) => ({ º: "o", ª: "a", "€": "EUR" })[c]!);
const pdf = (...pages: string[]) => makePdf(pages.map(plain));
const euros = (n: number) => `${n.toLocaleString("es-ES")},00 €`;

// ------------------------------------------------------------------ los casos

/**
 * Hasta dónde llega cada caso:
 * 0 atestado sin tramitar · 1 abierto, se pide documentación · 2 llega una parte · 3 documentación
 * completa y comunicado · 4 número de siniestro · 5 perito designado · 6 informe pericial ·
 * 7 reclamación y taller · 8 oferta y reparación · 9 cobrado y cerrado
 */
type Variant =
  | "normal"
  | "convenio" // con convenio entre aseguradoras: no se reclama al contrario
  | "total" // siniestro total
  | "rehuse" // la contraria rehúsa: pasa al abogado
  | "desiste" // el cliente desiste
  | "telefono" // la comunicación se hizo por teléfono: fase sin correo que la valide
  | "informe-sin-marcar" // el informe del perito llegó y aún no se ha marcado
  | "policia"; // el atestado lo manda la policía

type Case = {
  client: Client;
  stage: number;
  variant: Variant;
  pace: number;
  idle: number;
  insurer: Party;
  opposing: Party;
  expert: Party;
  garage: Party;
  police: Party;
  owner: number;
};

const SPEC: [number, Variant, number, number][] = [
  // [etapa, variante, días entre pasos, días quieto al final]
  [0, "normal", 0, 0],
  [0, "policia", 0, 1],
  [0, "normal", 0, 2],
  [0, "normal", 0, 0],
  [1, "normal", 2, 0],
  [1, "normal", 2, 3],
  [1, "policia", 2, 1],
  [2, "normal", 3, 1],
  [2, "normal", 3, 6],
  [2, "normal", 2, 12],
  [3, "normal", 3, 1],
  [3, "telefono", 3, 2],
  [3, "desiste", 3, 1],
  [4, "normal", 3, 2],
  [4, "convenio", 4, 4],
  [4, "normal", 3, 11],
  [5, "normal", 3, 3],
  [5, "policia", 3, 1],
  [5, "normal", 4, 9],
  [6, "informe-sin-marcar", 3, 1],
  [6, "normal", 3, 2],
  [6, "informe-sin-marcar", 4, 3],
  [6, "convenio", 3, 5],
  [7, "normal", 4, 2],
  [7, "total", 4, 3],
  [7, "normal", 5, 14],
  [8, "normal", 4, 2],
  [8, "rehuse", 4, 3],
  [8, "convenio", 4, 1],
  [9, "normal", 4, 0],
  [9, "convenio", 5, 0],
  [9, "total", 4, 0],
];
const CASES: Case[] = SPEC.map(([stage, variant, pace, idle], i) => ({
  client: CLIENTS[i]!,
  stage,
  variant,
  pace,
  idle,
  insurer: INSURERS[i % INSURERS.length]!,
  opposing: OPPOSING[i % OPPOSING.length]!,
  expert: EXPERTS[i % EXPERTS.length]!,
  garage: GARAGES[i % GARAGES.length]!,
  police: POLICE[i % POLICE.length]!,
  owner: i % 3,
}));

/** El número de atestado y el de siniestro de la aseguradora de cada caso. */
const reportNo = (i: number) => `AT-${2026}-${String(3100 + i * 7).padStart(5, "0")}`;
const claimNo = (c: Case, i: number) =>
  ({ "Seguros Albor": "SA", "Mutua del Ebro": "ME", "Aseguradora Pirineo": "AP" })[c.insurer.name] +
  `-26-${80100 + i * 13}`;

// ------------------------------------------------------------------ los correos de cada caso

type Mail = {
  key: string; // identificador dentro del caso: a1, a2…
  day: Day;
  hour: number;
  from: Party;
  to: Party;
  subject: string;
  text: string;
  files?: { filename: string; content: Buffer }[];
  replyTo?: string; // clave del correo al que responde
  sent?: boolean; // lo envía la correduría: va a Enviados
};

/** Los días de cada paso: el caso se abre un día después del siniestro y avanza a su ritmo. */
function stepDays(c: Case): Day[] {
  const steps = Math.max(c.stage, 1);
  const span = (steps - 1) * c.pace + c.idle;
  const open = addCalendarDays(TODAY, -span);
  return Array.from({ length: 10 }, (_, k) => addCalendarDays(open, k * c.pace));
}

const sign = "\n\nUn saludo,\nMarta Gil\nTramitación de siniestros · Correduría Albar\n976 000 100";

async function mailsOf(c: Case, i: number): Promise<Mail[]> {
  const d = stepDays(c);
  const loss = addCalendarDays(d[0]!, -1);
  const lossText = loss.split("-").reverse().join("/");
  const { client } = c;
  const who = party(`${client.person} · ${client.company}`, client.address);
  const claim = claimNo(c, i);
  const atestado = pdf(
    `ATESTADO No ${reportNo(i)}. ${c.police.name}. Diligencias por accidente de circulacion ocurrido el ${lossText}. Vehiculo A: ${client.car} matricula ${client.plate}, titular ${client.company}. Vehiculo B: turismo asegurado en ${c.opposing.name}.`,
    `Manifestaciones: el conductor del vehiculo B no respeto la preferencia y colisiono con el lateral del vehiculo A. Danos materiales. Sin heridos.`,
  );
  const mails: Mail[] = [];
  const add = (mail: Mail) => mails.push(mail);

  // Paso 0: llega el atestado
  if (c.variant === "policia") {
    add({
      key: "a1",
      day: d[0]!,
      hour: 9,
      from: c.police,
      to: OFFICE,
      subject: `Remisión de atestado ${reportNo(i)} · vehículo ${client.plate}`,
      text: `Se remite copia del atestado ${reportNo(i)} instruido por accidente de circulación el ${lossText} en el que interviene el vehículo ${client.plate}, asegurado por su mediación.\n\nAtentamente,\n${c.police.name}`,
      files: [
        { filename: `Atestado_${reportNo(i)}.pdf`, content: atestado },
        { filename: "parte_amistoso.png", content: image("t308-parte-con-casillas.png") },
      ],
    });
  } else {
    add({
      key: "a1",
      day: d[0]!,
      hour: 9,
      from: who,
      to: OFFICE,
      subject: `Siniestro ${client.plate} · atestado y fotos`,
      text: `Buenos días:\n\nAyer (${lossText}) tuvimos un accidente con la ${client.car} ${client.plate}. Os mando el atestado de la ${c.police.name} y unas fotos del golpe. El otro conductor va asegurado en ${c.opposing.name}.\n\n¿Qué necesitáis?\n\n${client.person}\n${client.company}`,
      files: [
        { filename: `Atestado_${reportNo(i)}.pdf`, content: atestado },
        {
          filename: `foto_golpe_${client.plate}_1.jpg`,
          content: image(PHOTOS[i % PHOTOS.length]!),
        },
        {
          filename: `foto_golpe_${client.plate}_2.jpg`,
          content: image(PHOTOS[(i + 2) % PHOTOS.length]!),
        },
      ],
    });
  }
  if (c.stage === 0) return mails;

  // Paso 1: se abre y se pide documentación
  add({
    key: "a2",
    day: d[0]!,
    hour: 11,
    from: OFFICE,
    to: who,
    replyTo: "a1",
    sent: true,
    subject: `Re: Siniestro ${client.plate} · documentación`,
    text: `Hola, ${client.person.split(" ")[0]}:\n\nAbrimos el expediente. Para comunicarlo a ${c.insurer.name} necesitamos:\n- DNI del conductor\n- Permiso de circulación y ficha técnica\n- Carta verde o póliza en vigor${sign}`,
  });
  if (c.stage === 1) return mails;

  // Paso 2: llega una parte
  add({
    key: "a3",
    day: d[1]!,
    hour: 10,
    from: who,
    to: OFFICE,
    replyTo: "a2",
    subject: `Re: Siniestro ${client.plate} · documentación`,
    text: `Os mando el DNI del conductor. El permiso lo tengo en la nave, os lo paso mañana.\n\n${client.person}`,
    files: [
      {
        filename: "DNI_conductor.pdf",
        content: pdf(
          `DOCUMENTO NACIONAL DE IDENTIDAD (copia). Titular: conductor de ${client.company}. Valido hasta 2031.`,
        ),
      },
    ],
  });
  if (c.stage === 2) return mails;

  // Paso 3: documentación completa y comunicación a la aseguradora
  add({
    key: "a4",
    day: d[2]!,
    hour: 9,
    from: who,
    to: OFFICE,
    replyTo: "a3",
    subject: `Re: Siniestro ${client.plate} · documentación`,
    text: `Ahí va el permiso de circulación y la ficha técnica.\n\n${client.person}`,
    files: [
      {
        filename: `Permiso_circulacion_${client.plate}.jpg`,
        content: image("t102-presupuesto-tabla.png"),
      },
      {
        filename: `Ficha_tecnica_${client.plate}.pdf`,
        content: pdf(
          `FICHA TECNICA. Vehiculo ${client.car}, matricula ${client.plate}. ITV en vigor.`,
        ),
      },
    ],
  });
  if (c.variant === "desiste") {
    add({
      key: "z1",
      day: d[2]!,
      hour: 17,
      from: who,
      to: OFFICE,
      replyTo: "a4",
      subject: `Re: Siniestro ${client.plate} · lo dejamos`,
      text: `Hemos hablado con el otro conductor y lo arreglamos entre nosotros. No queremos seguir con el parte.\n\n${client.person}`,
    });
    return mails;
  }
  if (c.variant !== "telefono") {
    add({
      key: "b1",
      day: d[2]!,
      hour: 12,
      from: OFFICE,
      to: c.insurer,
      sent: true,
      subject: `Comunicación de siniestro · ${client.company} · ${client.plate}`,
      text: `Buenos días:\n\nComunicamos el siniestro del vehículo ${client.plate} (${client.company}) ocurrido el ${lossText}. Adjuntamos atestado ${reportNo(i)} y documentación del conductor.${sign}`,
      files: [{ filename: `Atestado_${reportNo(i)}.pdf`, content: atestado }],
    });
  }
  if (c.stage === 3) return mails;

  // Paso 4: número de siniestro
  add({
    key: "b2",
    day: d[3]!,
    hour: 13,
    from: c.insurer,
    to: OFFICE,
    replyTo: c.variant === "telefono" ? undefined : "b1",
    subject: `Siniestro ${claim} · ${client.plate} · alta`,
    text: `Le informamos de que el siniestro del vehículo ${client.plate} queda registrado con el número ${claim}. Indique este número en todas las comunicaciones.\n\nDepartamento de Siniestros\n${c.insurer.name}`,
  });
  if (c.stage === 4) return mails;

  // Paso 5: perito designado y cita
  add({
    key: "b3",
    day: d[4]!,
    hour: 10,
    from: c.insurer,
    to: OFFICE,
    subject: `Siniestro ${claim} · designación de perito`,
    text: `Para el siniestro ${claim} se designa a ${c.expert.name}, que contactará para la peritación del vehículo ${client.plate}.\n\n${c.insurer.name}`,
  });
  add({
    key: "c1",
    day: d[4]!,
    hour: 16,
    from: c.expert,
    to: OFFICE,
    subject: `Cita de peritación · ${claim} · ${client.plate}`,
    text: `Pasaremos a ver el vehículo ${client.plate} en ${c.garage.name} el próximo jueves a las 10:00. Rogamos confirmen.\n\n${c.expert.name}`,
  });
  if (c.stage === 5) return mails;

  // Paso 6: informe pericial
  const amount = 900 + ((i * 431) % 6200);
  add({
    key: "c2",
    day: d[5]!,
    hour: 12,
    from: c.expert,
    to: OFFICE,
    replyTo: "c1",
    subject: `Informe pericial · ${claim} · ${client.plate}`,
    text: `Adjuntamos informe pericial del siniestro ${claim}. Valoración de daños: ${euros(amount)}.${c.variant === "total" ? " El importe supera el valor venal: se propone siniestro total." : ""}\n\n${c.expert.name}`,
    files: [
      {
        filename: `Informe_pericial_${claim}.pdf`,
        content: pdf(
          `INFORME PERICIAL ${claim}. Vehiculo ${client.plate}. Danos en lateral izquierdo, puerta y aleta. Valoracion: ${amount} EUR (mano de obra y piezas).`,
          c.variant === "total"
            ? `Valor venal estimado: ${Math.round(amount * 0.7)} EUR. Se propone siniestro total.`
            : "Reparacion viable.",
        ),
      },
      {
        filename: `Valoracion_${claim}.xlsx`,
        content: await makeXlsx({
          Valoracion: [
            ["Concepto", "Importe"],
            ["Piezas", Math.round(amount * 0.55)],
            ["Mano de obra", Math.round(amount * 0.3)],
            ["Pintura", Math.round(amount * 0.15)],
          ],
        }),
      },
    ],
  });
  if (c.variant !== "informe-sin-marcar") {
    add({
      key: "d1",
      day: d[5]!,
      hour: 15,
      from: OFFICE,
      to: who,
      sent: true,
      subject: `Siniestro ${claim} · informe del perito`,
      text: `Hola, ${client.person.split(" ")[0]}:\n\nOs pasamos el informe del perito: valora los daños en ${euros(amount)}. ¿Estáis conformes?${sign}`,
    });
    add({
      key: "d2",
      day: d[5]!,
      hour: 18,
      from: who,
      to: OFFICE,
      replyTo: "d1",
      subject: `Re: Siniestro ${claim} · informe del perito`,
      text: `Conformes. Adelante.\n\n${client.person}`,
    });
  }
  if (c.stage === 6) return mails;

  // Paso 7: reclamación al contrario y taller
  if (c.variant !== "convenio") {
    add({
      key: "e1",
      day: d[6]!,
      hour: 10,
      from: OFFICE,
      to: c.opposing,
      sent: true,
      subject: `Reclamación de daños · ${claim} · ${client.plate}`,
      text: `Reclamamos los daños sufridos por el vehículo ${client.plate} en el accidente del ${lossText}, causado por su asegurado. Adjuntamos atestado e informe pericial. Importe: ${euros(amount)}.${sign}`,
      files: [
        {
          filename: `Reclamacion_${claim}.docx`,
          content: makeDocx([
            `Reclamacion de danos ${claim}`,
            `Importe reclamado: ${amount} EUR`,
            "Se adjunta atestado e informe pericial.",
          ]),
        },
      ],
    });
  }
  add({
    key: "f1",
    day: d[6]!,
    hour: 17,
    from: c.garage,
    to: OFFICE,
    subject: `Presupuesto ${client.plate}`,
    text:
      c.variant === "total"
        ? `El vehículo ${client.plate} no compensa repararlo según el perito. Queda en nuestras instalaciones a la espera de lo que decidáis.\n\n${c.garage.name}`
        : `Adjuntamos presupuesto de reparación del ${client.plate}. Podemos empezar en cuanto nos deis el visto bueno.\n\n${c.garage.name}`,
    files: [
      {
        filename: `Presupuesto_${client.plate}.pdf`,
        content: pdf(
          `PRESUPUESTO DE REPARACION. ${c.garage.name}. Vehiculo ${client.plate}. Total ${amount} EUR.`,
        ),
      },
    ],
  });
  if (c.stage === 7) return mails;

  // Paso 8: oferta o rehúse, y reparación
  if (c.variant === "rehuse") {
    add({
      key: "e2",
      day: d[7]!,
      hour: 11,
      from: c.opposing,
      to: OFFICE,
      replyTo: "e1",
      subject: `Respuesta motivada · ${claim}`,
      text: `En relación con su reclamación ${claim}, rehusamos el siniestro: nuestro asegurado declara que el vehículo ${client.plate} invadió el carril. Adjuntamos respuesta motivada.\n\n${c.opposing.name}`,
      files: [
        {
          filename: `Respuesta_motivada_${claim}.pdf`,
          content: pdf(
            `RESPUESTA MOTIVADA ${claim}. Se rehusa la reclamacion por discrepancia en la dinamica del accidente.`,
          ),
        },
      ],
    });
    add({
      key: "h1",
      day: d[7]!,
      hour: 16,
      from: OFFICE,
      to: LAWYER,
      sent: true,
      subject: `Encargo · ${claim} · ${client.company}`,
      text: `Os pasamos el siniestro ${claim}: la contraria rehúsa. Adjuntamos atestado, informe y respuesta motivada para que valoréis la reclamación judicial.${sign}`,
    });
  } else if (c.variant !== "convenio") {
    add({
      key: "e2",
      day: d[7]!,
      hour: 11,
      from: c.opposing,
      to: OFFICE,
      replyTo: "e1",
      subject: `Oferta motivada · ${claim}`,
      text: `Aceptamos la responsabilidad y ofrecemos ${euros(amount)} por los daños del vehículo ${client.plate}. Adjuntamos oferta motivada.\n\n${c.opposing.name}`,
      files: [
        {
          filename: `Oferta_motivada_${claim}.pdf`,
          content: pdf(`OFERTA MOTIVADA ${claim}. Importe ofrecido: ${amount} EUR.`),
        },
      ],
    });
  }
  add({
    key: "f2",
    day: d[7]!,
    hour: 18,
    from: c.garage,
    to: OFFICE,
    replyTo: "f1",
    subject: `Re: Presupuesto ${client.plate} · ${c.variant === "total" ? "baja del vehículo" : "reparado"}`,
    text:
      c.variant === "total"
        ? `Damos de baja el ${client.plate}. Adjuntamos el certificado de destrucción.\n\n${c.garage.name}`
        : `El ${client.plate} está reparado. Adjuntamos factura y fotos del vehículo terminado.\n\n${c.garage.name}`,
    files: [
      {
        filename:
          c.variant === "total"
            ? `Certificado_destruccion_${client.plate}.pdf`
            : `Factura_${client.plate}.pdf`,
        content: pdf(
          c.variant === "total"
            ? `CERTIFICADO DE DESTRUCCION. Vehiculo ${client.plate}.`
            : `FACTURA ${c.garage.name}. Reparacion vehiculo ${client.plate}. Total ${amount} EUR IVA incluido.`,
        ),
      },
      ...(c.variant === "total"
        ? []
        : [
            {
              filename: `reparado_${client.plate}.jpg`,
              content: image("d103-camion-sin-danos.jpg"),
            },
          ]),
    ],
  });
  if (c.stage === 8) return mails;

  // Paso 9: cobro y cierre
  add({
    key: "g1",
    day: d[8]!,
    hour: 10,
    from: c.insurer,
    to: OFFICE,
    subject: `Siniestro ${claim} · pago`,
    text: `Le comunicamos el pago de ${euros(amount)} correspondiente al siniestro ${claim}. Adjuntamos justificante de transferencia.\n\n${c.insurer.name}`,
    files: [
      {
        filename: `Justificante_pago_${claim}.pdf`,
        content: pdf(`JUSTIFICANTE DE TRANSFERENCIA. Siniestro ${claim}. Importe ${amount} EUR.`),
      },
    ],
  });
  add({
    key: "g2",
    day: d[8]!,
    hour: 13,
    from: OFFICE,
    to: who,
    sent: true,
    subject: `Siniestro ${claim} · cerrado`,
    text: `Hola, ${client.person.split(" ")[0]}:\n\n${c.insurer.name} ha pagado ${euros(amount)}. Damos el expediente por cerrado. Cualquier cosa, aquí estamos.${sign}`,
  });
  return mails;
}

/** Correos que no son de ningún siniestro: para expedientes sin plan y para el ruido de un buzón real. */
function otherMails(): (Mail & { group?: string })[] {
  const day = (n: number) => addCalendarDays(TODAY, -n);
  const flota = party(
    "Raquel Ibáñez · Distribuciones Moncayo",
    "raquel.ibanez@distmoncayo.example",
  );
  const hotel = party("Cristina Oliván · Hotel Peña Oroel", "cristina@hotelpenaoroel.example");
  return [
    {
      key: "r1",
      group: "flota",
      day: day(21),
      hour: 9,
      from: flota,
      to: OFFICE,
      subject: "Renovación póliza de flota 2027",
      text: "Hola: nos vence la póliza de flota en enero. ¿Podéis pedir precio a varias compañías? Os paso la relación de vehículos.\n\nRaquel",
      files: [
        {
          filename: "Relacion_vehiculos_2027.pdf",
          content: pdf("RELACION DE VEHICULOS 2027. 12 furgonetas y 3 camiones."),
        },
      ],
    },
    {
      key: "r2",
      group: "flota",
      day: day(20),
      hour: 12,
      from: OFFICE,
      to: flota,
      sent: true,
      replyTo: "r1",
      subject: "Re: Renovación póliza de flota 2027",
      text: `Perfecto, pedimos precio a Seguros Albor, Mutua del Ebro y Aseguradora Pirineo.${sign}`,
    },
    {
      key: "r3",
      group: "flota",
      day: day(8),
      hour: 10,
      from: INSURERS[1]!,
      to: OFFICE,
      subject: "Oferta flota Distribuciones Moncayo 2027",
      text: "Adjuntamos oferta para la flota de Distribuciones Moncayo.\n\nMutua del Ebro",
      files: [
        {
          filename: "Oferta_flota_Moncayo.pdf",
          content: pdf("OFERTA FLOTA 2027. Prima total 18.400 EUR."),
        },
      ],
    },
    {
      key: "s1",
      group: "hotel",
      day: day(15),
      hour: 11,
      from: hotel,
      to: OFFICE,
      subject: "Daños por agua en la cocina del hotel",
      text: "Se nos ha roto una tubería en la cocina y ha mojado el falso techo del comedor. ¿Esto lo cubre el seguro del establecimiento?\n\nCristina",
      files: [{ filename: "techo_comedor.jpg", content: image("d201-techo-con-humedad.jpg") }],
    },
    {
      key: "s2",
      group: "hotel",
      day: day(14),
      hour: 9,
      from: OFFICE,
      to: hotel,
      sent: true,
      replyTo: "s1",
      subject: "Re: Daños por agua en la cocina del hotel",
      text: `Sí, entra en la cobertura de daños por agua. Lo comunicamos y te llamará un perito.${sign}`,
    },
    {
      key: "n1",
      day: day(6),
      hour: 8,
      from: party("Boletín ADECOSE", "boletin@adecose.example"),
      to: OFFICE,
      subject: "Boletín semanal del sector asegurador",
      text: "Novedades normativas de la semana y agenda de formación.",
    },
    {
      key: "n2",
      day: day(2),
      hour: 8,
      from: party("Boletín ADECOSE", "boletin@adecose.example"),
      to: OFFICE,
      subject: "Boletín semanal del sector asegurador",
      text: "Jornada sobre el baremo de tráfico 2027.",
    },
  ];
}

// ------------------------------------------------------------------ fase 1: el buzón

const messageId = (caseIndex: number | string, key: string) =>
  `<demo-${caseIndex}-${key}@correduria-albar.example>`;

async function buildRaw(mail: Mail, id: string, parent: string | undefined): Promise<Buffer> {
  const date = at(mail.day, mail.hour, (id.length * 7) % 50);
  return new MailComposer({
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    date,
    messageId: id,
    ...(parent ? { inReplyTo: parent, references: [parent] } : {}),
    attachments: mail.files?.map((file) => ({ filename: file.filename, content: file.content })),
  })
    .compile()
    .build();
}

async function correos(): Promise<void> {
  // El buzón en el servidor de Docker (si ya existe, el comando falla y no pasa nada).
  try {
    execFileSync(
      "docker",
      ["exec", "seguros-correo-dev-mail-1", "setup", "email", "add", MAILBOX, MAILBOX_PASS],
      { stdio: "ignore" },
    );
    console.log(`Buzón ${MAILBOX} creado; esperando a que el servidor lo active…`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  } catch {
    console.log(`El buzón ${MAILBOX} ya existía.`);
  }
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: 1993,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: MAILBOX, pass: MAILBOX_PASS },
    logger: false,
  });
  await client.connect();
  for (const folder of ["INBOX", "Sent"]) {
    const lock = await client.getMailboxLock(folder).catch(async () => {
      await client.mailboxCreate(folder);
      return client.getMailboxLock(folder);
    });
    try {
      if (client.mailbox && client.mailbox.exists > 0) await client.messageDelete("1:*");
    } finally {
      lock.release();
    }
  }
  let total = 0;
  const append = async (mail: Mail, id: string, parent: string | undefined) => {
    const raw = await buildRaw(mail, id, parent);
    await client.append(
      mail.sent ? "Sent" : "INBOX",
      raw,
      mail.sent || mail.day < addCalendarDays(TODAY, -3) ? ["\\Seen"] : [],
      at(mail.day, mail.hour),
    );
    total++;
  };
  for (const [i, c] of CASES.entries()) {
    for (const mail of await mailsOf(c, i))
      await append(
        mail,
        messageId(i, mail.key),
        mail.replyTo ? messageId(i, mail.replyTo) : undefined,
      );
  }
  for (const mail of otherMails())
    await append(
      mail,
      messageId("x", mail.key),
      mail.replyTo ? messageId("x", mail.replyTo) : undefined,
    );
  await client.logout();
  console.log(`${total} correos en ${MAILBOX}.`);

  // Conectarlo a la aplicación, con acceso para todos los usuarios, y traerlo.
  const runtime = await openRuntime();
  try {
    // Se rehace desde cero: fuera el buzón de demo de la aplicación, con sus correos y expedientes.
    await runtime.db.delete(accounts).where(eq(accounts.email, MAILBOX));
    let [account] = await runtime.db.select().from(accounts).where(eq(accounts.email, MAILBOX));
    if (!account) {
      account = await createAccount(runtime.db, runtime.secrets, {
        name: "Siniestros (demo)",
        email: MAILBOX,
        imapHost: "127.0.0.1",
        imapPort: 1993,
        smtpHost: "127.0.0.1",
        smtpPort: 1587,
        tlsInsecure: true,
        username: MAILBOX,
        password: MAILBOX_PASS,
      });
      console.log("Buzón conectado a la aplicación.");
    }
    // Dos tramitadores más, para repartir el trabajo (sin contraseña conocida: no entran).
    for (const [email, name] of [
      ["marta.gil@correduria.example", "Marta Gil"],
      ["jorge.sanz@correduria.example", "Jorge Sanz"],
    ] as const) {
      const [exists] = await runtime.db.select().from(users).where(eq(users.email, email));
      if (!exists)
        await createUser(runtime.db, {
          email,
          name,
          password: crypto.randomUUID() + crypto.randomUUID(),
        });
    }
    for (const user of await runtime.db.select().from(users)) {
      await runtime.db
        .insert(accountAccess)
        .values({ userId: user.id, accountId: account.id })
        .onConflictDoNothing();
    }
    for (let cycle = 0; cycle < 50; cycle++) {
      const result = await runSyncCycle(runtime, account);
      if (!result.pending) break;
    }
    console.log("Buzón sincronizado. Reinicia el servidor y lanza «pnpm demo expedientes».");
  } finally {
    await runtime.close();
  }
}

// ------------------------------------------------------------------ fase 2: los expedientes

async function expedientes(): Promise<void> {
  const env = Object.fromEntries(
    readFileSync(".env", "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  const login = await fetch(`${APP}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: env.DEMO_USER, password: env.DEMO_PASS }),
  });
  if (!login.ok)
    throw new Error(`No se ha podido entrar con el usuario de demo (${login.status}).`);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const api = async <T = Record<string, never>>(
    method: string,
    path: string,
    body?: object,
  ): Promise<T> => {
    const response = await fetch(`${APP}/api${path}`, {
      method,
      headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : method === "GET" ? undefined : "{}",
    });
    const data = (await response.json().catch(() => ({}))) as T;
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const T = "/plugins/tramitacion";
  const E = "/plugins/expedientes";

  const runtime = await openRuntime();
  const { db } = runtime;
  try {
    const [account] = await db.select().from(accounts).where(eq(accounts.email, MAILBOX));
    if (!account) throw new Error("Falta el buzón de demo: lanza antes «pnpm demo correos».");
    // Se empieza de cero: fuera los expedientes de este buzón.
    await db.execute(sql`delete from exp_cases where account_id = ${account.id}`);
    await db.execute(sql`
      select setval('exp_case_seq', greatest(1, coalesce((select max(split_part(number, '-', 3)::int) from exp_cases), 0)))`);

    const idOf = async (header: string) => {
      const rows = await db.execute<{ id: string }>(
        sql`select id from messages where account_id = ${account.id} and message_id_header = ${header} limit 1`,
      );
      if (!rows.rows[0]) throw new Error(`No encuentro el correo ${header}`);
      return rows.rows[0].id;
    };
    const userIds = await db.execute<{ id: string; email: string }>(
      sql`select id, email from users order by created_at`,
    );
    const owners = [
      env.DEMO_USER ?? "",
      "marta.gil@correduria.example",
      "jorge.sanz@correduria.example",
    ].map(
      (email) =>
        userIds.rows.find((row) => row.email.toLowerCase() === email.toLowerCase())?.id ?? null,
    );

    // Catálogos y directorio
    const insurers = await api<{ insurers: { id: string; name: string }[] }>(
      "GET",
      `${E}/insurers`,
    );
    for (const insurer of INSURERS)
      if (!insurers.insurers.some((row) => row.name === insurer.name))
        await api("POST", `${E}/insurers`, { name: insurer.name });
    const insurerIds = new Map(
      (
        await api<{ insurers: { id: string; name: string }[] }>("GET", `${E}/insurers`)
      ).insurers.map((row) => [row.name, row.id]),
    );
    const directory: [string, Party][] = [
      ...INSURERS.map((p) => ["aseguradora", p] as [string, Party]),
      ...OPPOSING.map((p) => ["aseguradora", p] as [string, Party]),
      ...EXPERTS.map((p) => ["perito", p] as [string, Party]),
      ...GARAGES.map((p) => ["taller", p] as [string, Party]),
      ["abogado", LAWYER],
      ...POLICE.map((p) => ["policia", p] as [string, Party]),
      ["grua", TOW],
    ];
    // La agenda de contactos: los terceros y, para cada cliente, su empresa y su persona.
    const C = "/plugins/contactos";
    const ensureContact = async (body: {
      kind: "persona" | "empresa";
      name: string;
      roles: string[];
      email?: string;
      phone?: string;
      companyId?: string;
    }) => {
      const found = body.email
        ? await api<{ contact: { id: string } | null }>(
            "GET",
            `${C}/by-address?address=${encodeURIComponent(body.email)}`,
          )
        : null;
      if (found?.contact) return found.contact.id;
      const list = await api<{ contacts: { id: string; name: string }[] }>(
        "GET",
        `${C}/contacts?q=${encodeURIComponent(body.name)}`,
      );
      const same = list.contacts.find((row) => row.name === body.name);
      if (same) return same.id;
      const channels = [
        ...(body.email ? [{ kind: "email", value: body.email }] : []),
        ...(body.phone ? [{ kind: "phone", value: body.phone, label: "móvil" }] : []),
      ];
      return (
        await api<{ contact: { id: string } }>("POST", `${C}/contacts`, {
          kind: body.kind,
          name: body.name,
          roles: body.roles,
          companyId: body.companyId ?? null,
          channels,
        })
      ).contact.id;
    };
    const contacts = new Map<string, string>();
    for (const [role, p] of directory) {
      contacts.set(
        p.name,
        await ensureContact({ kind: "empresa", name: p.name, roles: [role], email: p.address }),
      );
    }
    const clientIds = new Map<string, string>();
    for (const [index, client] of CLIENTS.entries()) {
      if (clientIds.has(client.address)) continue;
      const companyId = await ensureContact({
        kind: "empresa",
        name: client.company,
        roles: ["cliente"],
      });
      // Móviles inventados (rango 600 000 1xx), para que se vean en la ficha.
      const phone = `600000${String(100 + index).padStart(3, "0")}`;
      clientIds.set(
        client.address,
        await ensureContact({
          kind: "persona",
          name: client.person,
          roles: ["cliente"],
          email: client.address,
          phone,
          companyId,
        }),
      );
    }
    const templates = await api<{ templates: { id: string; active: boolean; name: string }[] }>(
      "GET",
      `${T}/templates`,
    );
    const templateId = templates.templates.find(
      (row) => row.active && row.name.includes("atestado"),
    )!.id;

    type View = {
      case: { id: string; number: string };
      tasks: { id: string; key: string | null; status: string }[];
    };
    const clock = async () =>
      (await db.execute<{ now: string }>(sql`select clock_timestamp()::text as now`)).rows[0]!.now;
    /** Pone la fecha del paso a todo lo que acaba de cambiar en el expediente. */
    const backdate = async (caseId: string, mark: string, day: Day, hour: number) => {
      const when = at(day, hour).toISOString();
      const shift = sql`(current_date - ${day}::date)`;
      await db.execute(
        sql`update tra_events set at = ${when}::timestamptz + (id % 50) * interval '1 minute' where case_id = ${caseId} and at > ${mark}::timestamptz`,
      );
      await db.execute(
        sql`update tra_tasks set done_at = ${day}::date where case_id = ${caseId} and done_at = current_date and updated_at > ${mark}::timestamptz`,
      );
      await db.execute(
        sql`update tra_tasks set chase_at = chase_at - ${shift}, waiting_since = ${day}::date where case_id = ${caseId} and waiting_since = current_date and updated_at > ${mark}::timestamptz`,
      );
      await db.execute(
        sql`update tra_task_evidence set added_at = ${when}::timestamptz where added_at > ${mark}::timestamptz and task_id in (select id from tra_tasks where case_id = ${caseId})`,
      );
    };

    let opened = 0;
    for (const [i, c] of CASES.entries()) {
      if (c.stage === 0) continue;
      const d = stepDays(c);
      const loss = addCalendarDays(d[0]!, -1);
      const mails = new Map((await mailsOf(c, i)).map((mail) => [mail.key, mail]));
      const msg = async (key: string) => idOf(messageId(i, key));
      let view: View;
      let caseId = "";
      const id = (key: string) => view.tasks.find((task) => task.key === key)!.id;
      const step = async (day: Day, hour: number, work: () => Promise<void>) => {
        const mark = await clock();
        await work();
        await backdate(caseId, mark, day, hour);
      };
      const status = (key: string) => view.tasks.find((task) => task.key === key)!.status;
      const patch = async (key: string, body: object) => {
        view = await api<View>("PATCH", `${T}/tasks/${id(key)}`, body);
      };
      const proof = async (key: string, keys: string[], complete = true) => {
        view = await api<View>("POST", `${T}/tasks/${id(key)}/evidence`, {
          messageIds: await Promise.all(keys.map(msg)),
          complete,
        });
      };
      const addMail = async (key: string) => {
        if (mails.has(key))
          await api("POST", `${E}/cases/${caseId}/messages`, { messageId: await msg(key) });
      };

      // Paso 1: se abre con su plan y se pide la documentación
      const mark = await clock();
      view = await api<View>("POST", `${T}/open`, {
        messageId: await msg("a1"),
        templateId,
        lossDate: loss,
        ownerId: owners[c.owner],
        insurerId: insurerIds.get(c.insurer.name),
        title: `${c.client.company} · ${c.client.plate}`,
      });
      caseId = view.case.id;
      await api("PUT", `${C}/cases/${caseId}/client`, {
        contactId: clientIds.get(c.client.address),
      });
      opened++;
      await db.execute(
        sql`update exp_cases set created_at = ${at(d[0]!, 10).toISOString()}::timestamptz where id = ${caseId}`,
      );
      await db.execute(
        sql`update tra_case_plans set applied_at = ${at(d[0]!, 10).toISOString()}::timestamptz where case_id = ${caseId}`,
      );
      await proof("T1", ["a1"]);
      await addMail("a2");
      await patch("T2", { waiting: { client: true } });
      await backdate(caseId, mark, d[0]!, 11);
      if (c.stage >= 2)
        await step(d[1]!, 10, async () => {
          await proof("T2", ["a3"], false);
          await patch("T2", {
            note: "Llamé al cliente: el permiso lo manda mañana desde la nave.",
          });
        });
      if (c.stage === 2 && c.idle > 5)
        await step(addCalendarDays(d[1]!, 4), 9, async () => {
          await api("POST", `${T}/tasks/${id("T2")}/chased`);
        });
      if (c.stage >= 3)
        await step(d[2]!, 12, async () => {
          await proof("T2", ["a4"]);
          if (c.variant === "telefono") {
            await patch("T3", { status: "hecha" });
            await patch("T3", {
              note: "Comunicado por teléfono a la aseguradora; quedan en mandar el número por correo.",
            });
          } else if (c.variant !== "desiste") {
            await proof("T3", ["b1"]);
          }
          if (c.variant !== "desiste")
            await patch("T4", { waiting: { contactId: contacts.get(c.insurer.name) } });
        });
      if (c.variant === "desiste") {
        await step(d[2]!, 17, async () => {
          await addMail("z1");
          view = await api<View>("POST", `${T}/cases/${caseId}/close`, {
            reason: "desistido",
            force: true,
          });
        });
        await db.execute(
          sql`update exp_cases set closed_at = ${at(d[2]!, 17).toISOString()}::timestamptz where id = ${caseId}`,
        );
        continue;
      }
      if (c.stage >= 4)
        await step(d[3]!, 13, async () => {
          await addMail("b2");
          if (c.variant === "telefono") {
            await patch("T4", { status: "hecha" });
          } else await proof("T4", ["b2"]);
          await api("PUT", `${E}/cases/${caseId}`, { claimRef: claimNo(c, i) });
          await patch("T5", { status: "hecha" });
          if (c.variant === "convenio") {
            // Con convenio lo resuelven las aseguradoras entre ellas: no se reclama al contrario.
            await patch("T10", { status: "omitida" });
            await patch("T11", { status: "omitida" });
          }
          await patch("T5", {
            note:
              c.variant === "convenio"
                ? "Aplica convenio CIDE: lo gestiona nuestra aseguradora, no se reclama al contrario."
                : "No aplica convenio: se reclamará a la aseguradora contraria.",
          });
          await patch("T6", { waiting: { contactId: contacts.get(c.insurer.name) } });
        });
      if (c.stage >= 5)
        await step(d[4]!, 16, async () => {
          await addMail("b3");
          await addMail("c1");
          await proof("T6", ["b3"]);
          await patch("T7", { waiting: { contactId: contacts.get(c.expert.name) } });
          await proof("T7", ["c1"], false);
        });
      if (c.stage >= 6)
        await step(d[5]!, 18, async () => {
          await addMail("c2");
          if (c.variant === "informe-sin-marcar") return;
          await proof("T7", ["c2"]);
          await addMail("d1");
          await proof("T8", ["d1", "d2"]);
        });
      if (c.stage >= 7)
        await step(d[6]!, 17, async () => {
          await addMail("f1");
          if (c.variant !== "convenio") {
            await addMail("e1");
            if (status("T10") === "omitida") await patch("T10", { status: "pendiente" });
            await proof("T10", ["e1"]);
            await patch("T11", { waiting: { contactId: contacts.get(c.opposing.name) } });
          }
          await patch("T12", { waiting: { contactId: contacts.get(c.garage.name) } });
          await proof("T12", ["f1"], false);
          if (c.variant === "total")
            await patch("T12", {
              note: "El perito propone siniestro total: se negocia el valor venal con el cliente.",
            });
        });
      if (c.stage >= 8)
        await step(d[7]!, 18, async () => {
          await addMail("f2");
          if (c.variant !== "convenio") {
            await addMail("e2");
            await proof("T11", ["e2"]);
          }
          await proof("T12", ["f2"]);
          if (c.variant === "rehuse") {
            await addMail("h1");
            if (status("T13") === "omitida") await patch("T13", { status: "pendiente" });
            await patch("T13", { waiting: { contactId: contacts.get(LAWYER.name) } });
            await patch("T13", {
              note: "La contraria rehúsa. Encargado al Bufete Lanuza: estudian la vía judicial.",
            });
          } else {
            await patch("T14", { waiting: { contactId: contacts.get(c.insurer.name) } });
          }
        });
      if (c.stage >= 9) {
        await step(d[8]!, 13, async () => {
          await addMail("g1");
          await addMail("g2");
          await proof("T14", ["g1"]);
          await proof("T15", ["g2"]);
          await patch("T16", { status: "hecha" });
          view = await api<View>("POST", `${T}/cases/${caseId}/close`, {
            reason: "pagado",
            force: true,
          });
        });
        await db.execute(
          sql`update exp_cases set closed_at = ${at(d[8]!, 13).toISOString()}::timestamptz where id = ${caseId}`,
        );
      }
    }

    // Notas de lo que contienen algunas fotos y planos, como las deja un tramitador.
    const photos = await db.execute<{ id: string; filename: string }>(sql`
      select a.id, a.filename from attachments a join messages m on m.id = a.message_id
       where m.account_id = ${account.id} and (a.filename like 'foto_golpe%_1.jpg' or a.filename = 'parte_amistoso.png' or a.filename like 'reparado_%')
       order by a.filename limit 40`);
    for (const photo of photos.rows) {
      const text = photo.filename.startsWith("parte")
        ? "Parte amistoso firmado por los dos conductores. Casilla 12: el contrario reconoce no respetar la preferencia."
        : photo.filename.startsWith("reparado")
          ? "Vehículo ya reparado, sin daños visibles en el lateral."
          : "Golpe en el lateral izquierdo; puerta y aleta hundidas. Se ve la matrícula.";
      await api("PUT", `/attachments/${photo.id}/note`, { text }).catch(() => undefined);
    }

    // Expedientes sin plan: agrupan correos que no son un siniestro de tráfico.
    for (const [group, first, title] of [
      ["flota", "r1", "Renovación flota 2027 · Distribuciones Moncayo"],
      ["hotel", "s1", "Daños por agua · Hotel Peña Oroel"],
    ] as const) {
      const created = await api<{ case: { id: string } }>("POST", `${E}/cases`, {
        messageId: await idOf(messageId("x", first)),
      });
      for (const key of otherMails()
        .filter((mail) => mail.group === group)
        .map((mail) => mail.key)) {
        await api("POST", `${E}/cases/${created.case.id}/messages`, {
          messageId: await idOf(messageId("x", key)),
        });
      }
      await api("PUT", `${E}/cases/${created.case.id}`, { title });
      void group;
    }
    // Un boletín metido por error en un expediente, y marcado fuera del contexto.
    const target = await db.execute<{ id: string }>(
      sql`select id from exp_cases where account_id = ${account.id} and title like 'Renovación flota%' limit 1`,
    );
    const bulletin = await idOf(messageId("x", "n1"));
    await api("POST", `${E}/cases/${target.rows[0]!.id}/messages`, { messageId: bulletin });
    await api("PUT", `${E}/cases/${target.rows[0]!.id}/messages/${bulletin}`, { excluded: true });

    console.log(
      `${opened} expedientes en tramitación, 2 sin plan y ${CASES.filter((c) => c.stage === 0).length} atestados sin tramitar todavía.`,
    );
  } finally {
    await runtime.close();
  }
}

const command = process.argv[2];
if (command === "correos") await correos();
else if (command === "expedientes") await expedientes();
else {
  console.error("Uso: pnpm demo correos | pnpm demo expedientes");
  process.exit(1);
}
