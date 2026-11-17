import { describe, expect, it } from "vitest";
import { renderEmailHtml, renderEmailText } from "./render.ts";

const render = (html: string, options = {}) => renderEmailHtml(html, options).html;

describe("renderEmailHtml", () => {
  it("elimina todo lo que puede ejecutar código", () => {
    const html = render(`
      <p onclick="robar()">Hola</p>
      <script>robar()</script>
      <img src="x" onerror="robar()">
      <a href="javascript:robar()">pulsa</a>
      <iframe src="https://malo.test"></iframe>
      <object data="x"></object><embed src="x">
      <svg><script>robar()</script></svg>
      <math><mtext><script>robar()</script></mtext></math>
    `);
    expect(html).not.toMatch(/script|onclick|onerror|javascript:|iframe|object|embed|svg|math/i);
    expect(html).not.toContain("robar");
    expect(html).toContain("Hola");
  });

  it("elimina formularios, hojas de estilo y etiquetas que cambian la página", () => {
    const html = render(`
      <style>body { background: url(https://rastreo.test/a.gif) }</style>
      <link rel="stylesheet" href="https://malo.test/x.css">
      <meta http-equiv="refresh" content="0;url=https://malo.test">
      <base href="https://malo.test/">
      <form action="https://malo.test"><input name="clave"><button>Enviar</button></form>
      <p>Texto</p>
    `);
    expect(html).not.toMatch(/<style|<link|<meta|<base|<form|<input|<button/i);
    expect(html).not.toContain("rastreo.test");
    expect(html).toContain("Texto");
  });

  it("filtra los estilos en línea que cargan recursos o tapan la pantalla", () => {
    const html = render(`
      <p style="color: red; background-image: url(https://rastreo.test/p.gif)">uno</p>
      <p style="background-color: rgb(10, 20, 30); width: expression(alert(1))">dos</p>
      <div style="position: fixed; top: 0; left: 0; font-size: 14px">tres</div>
      <p style="color: var(--x); margin: 4px">cuatro</p>
    `);
    expect(html).not.toMatch(/url\(|expression|position|var\(/i);
    expect(html).toContain("color:red");
    expect(html).toContain("background-color:rgb(10, 20, 30)");
    expect(html).toContain("font-size:14px");
    expect(html).toContain("margin:4px");
  });

  it("bloquea las imágenes externas por defecto y las cuenta", () => {
    const source = `<img src="https://rastreo.test/pixel.gif" alt="logo"><img src="http://otro.test/a.png">`;
    const blocked = renderEmailHtml(source);
    expect(blocked.blockedImages).toBe(2);
    expect(blocked.html).not.toContain("rastreo.test");
    expect(blocked.html).toContain('data-blocked="1"');
    expect(blocked.html).toContain('alt="logo"');

    const allowed = renderEmailHtml(source, { allowRemoteImages: true });
    expect(allowed.blockedImages).toBe(0);
    expect(allowed.html).toContain('src="https://rastreo.test/pixel.gif"');
  });

  it("incrusta las imágenes del propio correo y descarta las que no reconoce", () => {
    const inlineImages = new Map([
      ["logo@correo", { contentType: "image/png", content: Buffer.from("png-de-prueba") }],
      ["raro@correo", { contentType: "image/svg+xml", content: Buffer.from("<svg/>") }],
    ]);
    const html = render(
      `<img src="cid:logo@correo"><img src="cid:raro@correo"><img src="cid:no-existe">`,
      { inlineImages },
    );
    expect(html).toContain(
      `src="data:image/png;base64,${Buffer.from("png-de-prueba").toString("base64")}"`,
    );
    expect(html).not.toContain("svg");
    expect(html).not.toContain("cid:");
  });

  it("no admite imágenes de datos que no sean imágenes corrientes", () => {
    const html = render(
      `<img src="data:text/html;base64,PHNjcmlwdD4="><img src="data:image/svg+xml;base64,PHN2Zz4=">`,
    );
    expect(html).not.toContain("data:");
  });

  it("abre los enlaces en otra pestaña, sin referencia, y enseña su destino real", () => {
    const html = render(`<a href="https://banco-falso.test/entrar">www.mibanco.es</a>`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('title="https://banco-falso.test/entrar"');
  });

  it("conserva el formato habitual de un correo de oficina", () => {
    const html = render(`
      <table cellpadding="6" style="border-collapse: collapse"><tr>
        <td style="border: 1px solid #999"><b>Siniestro</b></td><td>SIN-2026-0142</td>
      </tr></table>
      <ul><li>Póliza y <i>daños</i></li></ul>
      <blockquote>Cita</blockquote>
      <font color="#333333" face="Calibri">Texto</font>
    `);
    for (const fragment of ["<table", "cellpadding", "<b>Siniestro</b>", "<li>", "<blockquote>"]) {
      expect(html).toContain(fragment);
    }
    expect(html).toContain('color="#333333"');
  });
});

describe("renderEmailText", () => {
  it("escapa el texto y enlaza las direcciones web", () => {
    const { html } = renderEmailText(`Mira <b>esto</b>:\nhttps://ejemplo.test/doc?a=1&b=2.`);
    expect(html).toContain("&lt;b&gt;esto&lt;/b&gt;");
    expect(html).toContain('<a href="https://ejemplo.test/doc?a=1&amp;b=2"');
    expect(html).toContain("white-space: pre-wrap");
  });
});
