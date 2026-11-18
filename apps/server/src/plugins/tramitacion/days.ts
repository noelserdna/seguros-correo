/**
 * Fechas de calendario (`AAAA-MM-DD`) y días hábiles. Sin horas ni zonas: un plazo vence
 * un día, no a una hora.
 */

export type Day = string;

const toDate = (day: Day) => new Date(`${day}T00:00:00Z`);
const toDay = (date: Date): Day => date.toISOString().slice(0, 10);

export const dayOf = (value: Date | string): Day =>
  typeof value === "string" ? value.slice(0, 10) : toDay(value);

export function addCalendarDays(day: Day, n: number): Day {
  const date = toDate(day);
  date.setUTCDate(date.getUTCDate() + n);
  return toDay(date);
}

/** Días de calendario de `from` a `to` (negativo si `to` es anterior). */
export const daysBetween = (from: Day, to: Day) =>
  Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher). */
function easter(year: number): Day {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const dayOfMonth = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
}

/**
 * Festivos nacionales de España. Los autonómicos y locales no están: cuando haga falta se
 * añadirán por oficina. Viernes Santo es nacional; Jueves Santo y el lunes de Pascua no.
 */
const FIXED = ["01-01", "01-06", "05-01", "08-15", "10-12", "11-01", "12-06", "12-08", "12-25"];
const cache = new Map<number, Set<Day>>();

export function nationalHolidays(year: number): Set<Day> {
  let holidays = cache.get(year);
  if (!holidays) {
    holidays = new Set(FIXED.map((monthDay) => `${year}-${monthDay}`));
    holidays.add(addCalendarDays(easter(year), -2));
    cache.set(year, holidays);
  }
  return holidays;
}

export function isBusinessDay(day: Day): boolean {
  const weekday = toDate(day).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !nationalHolidays(Number(day.slice(0, 4))).has(day);
}

/** `n` días hábiles después de `day` (sin contar ese día). */
export function addBusinessDays(day: Day, n: number): Day {
  let current = day;
  let left = n;
  while (left > 0) {
    current = addCalendarDays(current, 1);
    if (isBusinessDay(current)) left--;
  }
  return current;
}

/** Días hábiles desde `from` hasta `to`, sin contar `from`. Cero o negativo si ya ha pasado. */
export function businessDaysUntil(from: Day, to: Day): number {
  if (to <= from) return -daysBetween(to, from);
  let count = 0;
  let current = from;
  while (current < to) {
    current = addCalendarDays(current, 1);
    if (isBusinessDay(current)) count++;
  }
  return count;
}
