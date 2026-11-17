/**
 * Límite de intentos fallidos de acceso, en memoria. Suficiente para un servidor
 * único en la red del cliente; se reinicia al reiniciar el servicio.
 */
export class AttemptLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #failures = new Map<string, number[]>();

  constructor(max = 5, windowMs = 15 * 60_000) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  #recent(key: string, now: number): number[] {
    const recent = (this.#failures.get(key) ?? []).filter((time) => now - time < this.#windowMs);
    if (recent.length === 0) this.#failures.delete(key);
    else this.#failures.set(key, recent);
    return recent;
  }

  isBlocked(key: string, now = Date.now()): boolean {
    return this.#recent(key, now).length >= this.#max;
  }

  recordFailure(key: string, now = Date.now()): void {
    this.#failures.set(key, [...this.#recent(key, now), now]);
  }

  reset(key: string): void {
    this.#failures.delete(key);
  }
}
