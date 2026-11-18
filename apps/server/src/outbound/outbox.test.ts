import { describe, expect, it } from "vitest";
import { sendFailureText } from "./outbox.ts";

describe("motivo de un envío rechazado", () => {
  it("explica qué hacer cuando Microsoft 365 tiene el envío por SMTP desactivado", () => {
    const text = sendFailureText(
      "Invalid login: 535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant. Visit https://aka.ms/smtp_auth_disabled",
    );
    expect(text).toContain("SMTP autenticado");
    expect(text).not.toContain("535");
  });

  it("en los demás casos enseña lo que dijo el servidor", () => {
    expect(sendFailureText("550 Mailbox full")).toBe(
      "El servidor de salida no lo ha aceptado: 550 Mailbox full",
    );
  });
});
