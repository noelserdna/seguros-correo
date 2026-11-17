import { describe, expect, it } from "vitest";
import { AttemptLimiter } from "./rate-limit.ts";

describe("AttemptLimiter", () => {
  it("bloquea al alcanzar el máximo y solo a esa clave", () => {
    const limiter = new AttemptLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) limiter.recordFailure("ana", 1000 + i);
    expect(limiter.isBlocked("ana", 2000)).toBe(true);
    expect(limiter.isBlocked("luis", 2000)).toBe(false);
  });

  it("deja de bloquear cuando pasa la ventana de tiempo", () => {
    const limiter = new AttemptLimiter(2, 60_000);
    limiter.recordFailure("ana", 0);
    limiter.recordFailure("ana", 1);
    expect(limiter.isBlocked("ana", 59_000)).toBe(true);
    expect(limiter.isBlocked("ana", 61_000)).toBe(false);
  });

  it("se reinicia tras un acceso correcto", () => {
    const limiter = new AttemptLimiter(1, 60_000);
    limiter.recordFailure("ana", 0);
    limiter.reset("ana");
    expect(limiter.isBlocked("ana", 1)).toBe(false);
  });
});
