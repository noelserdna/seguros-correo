import { describe, expect, it } from "vitest";
import { makeDocx, makePdf, makeXlsx } from "../../test/documents.ts";
import { detectKind, extractDocument } from "./extract.ts";

const pdfType = "application/pdf";

describe("texto de los documentos adjuntos", () => {
  it("lee un PDF página a página y marca las que están escaneadas", async () => {
    const result = await extractDocument({
      filename: "Poliza.pdf",
      contentType: pdfType,
      content: makePdf([
        "Condiciones particulares de la poliza 88/2231907 de Seguros Albor",
        "",
        "Franquicia de 300 euros en danos propios del vehiculo 4471-KLM",
      ]),
    });
    expect(result.status).toBe("ok");
    expect(result.method).toBe("pdf_texto");
    expect(result.pagesNeedingOcr).toBe(1);
    expect(result.pages.map((page) => [page.page, page.method])).toEqual([
      [1, "capa_texto"],
      [2, "sin_texto"],
      [3, "capa_texto"],
    ]);
    expect(result.pages[0]?.text).toContain("poliza 88/2231907");
    expect(result.pages[2]?.text).toContain("Franquicia de 300 euros");
  });

  it("un PDF sin ninguna página con texto queda pendiente de reconocimiento", async () => {
    const result = await extractDocument({
      filename: "Parte escaneado.pdf",
      contentType: pdfType,
      content: makePdf(["", ""]),
    });
    expect(result).toMatchObject({ status: "needs_ocr", pagesNeedingOcr: 2, pages: [] });
  });

  it("lee Word y Excel, con una página por hoja", async () => {
    const word = await extractDocument({
      filename: "Informe pericial.docx",
      contentType: "application/octet-stream",
      content: makeDocx(["Informe pericial", "Daños en el lateral derecho."]),
    });
    expect(word).toMatchObject({ status: "ok", method: "docx" });
    expect(word.pages[0]?.text).toBe("Informe pericial\n\nDaños en el lateral derecho.");

    const excel = await extractDocument({
      filename: "Flota.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content: await makeXlsx({
        Vehículos: [
          ["Matrícula", "Póliza"],
          ["4471-KLM", "88/2231907"],
        ],
        Vacía: [],
        Siniestros: [["2026/0142", 1240.5]],
      }),
    });
    expect(excel.status).toBe("ok");
    expect(excel.pages.map((page) => [page.page, page.label, page.text])).toEqual([
      [1, "Vehículos", "Matrícula\tPóliza\n4471-KLM\t88/2231907"],
      [2, "Siniestros", "2026/0142\t1240.5"],
    ]);
  });

  it("lee un correo adjunto y los ficheros de texto", async () => {
    const eml = await extractDocument({
      filename: "reenviado.eml",
      contentType: "message/rfc822",
      content: Buffer.from(
        "From: Perito <perito@gabinete.test>\r\nSubject: Visita\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPasaré el jueves a las 10.\r\n",
      ),
    });
    expect(eml.pages[0]?.text).toContain("Asunto: Visita");
    expect(eml.pages[0]?.text).toContain("Pasaré el jueves a las 10.");

    const text = await extractDocument({
      filename: "notas.txt",
      contentType: "text/plain",
      content: Buffer.from("Llamar al taller.\r\n\r\n\r\n\r\nPedir presupuesto.  \n"),
    });
    expect(text.pages[0]?.text).toBe("Llamar al taller.\n\nPedir presupuesto.");
  });

  it("deja las imágenes pendientes de reconocimiento y no intenta lo que no conoce", async () => {
    const photo = await extractDocument({
      filename: "golpe.jpg",
      contentType: "image/jpeg",
      content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
    });
    expect(photo).toMatchObject({ status: "needs_ocr", pagesNeedingOcr: 1 });
    const unknown = await extractDocument({
      filename: "datos.bin",
      contentType: "application/octet-stream",
      content: Buffer.from("contenido cualquiera"),
    });
    expect(unknown.status).toBe("unsupported");
    const empty = await extractDocument({
      filename: "vacio.pdf",
      contentType: pdfType,
      content: Buffer.alloc(0),
    });
    expect(empty.status).toBe("empty");
  });

  it("un fichero roto se anota como fallido, sin lanzar", async () => {
    const broken = await extractDocument({
      filename: "roto.pdf",
      contentType: pdfType,
      content: Buffer.from("%PDF-1.4\nesto no es un PDF de verdad"),
    });
    expect(broken.status).toBe("failed");
    expect(broken.error).toBeTruthy();
  });

  it("se fía del contenido antes que del nombre", () => {
    expect(detectKind("factura.txt", "text/plain", makePdf(["x"]))).toBe("pdf");
    expect(detectKind("documento.pdf", pdfType, Buffer.from("solo texto"))).toBe("unknown");
    expect(detectKind("foto.JPG", "application/octet-stream", Buffer.from([1, 2, 3, 4]))).toBe(
      "image",
    );
  });
});
