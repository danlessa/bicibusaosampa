// Evaluates weekly time windows ("service hours", "bike hours") in São Paulo local time.
//
// A schedule maps a day type to a list of [start, end] windows written as "HH:MM".
// Day types: "weekday" (Mon–Fri), "saturday", "sunday", "holiday".
// An end past midnight is written as e.g. "24:30" and spills into the next calendar day,
// so a Saturday window "04:40"–"25:00" still counts at 00:30 on Sunday.
// A day type left out of a schedule falls back to "sunday" for holidays and to
// "weekday" otherwise.

import { spParts, previousDay, weekdayOf, holidayName } from './time.js';

const MINUTE = 60_000;

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function dayType(iso) {
  if (holidayName(iso)) return 'holiday';
  const wd = weekdayOf(iso);
  if (wd === 0) return 'sunday';
  if (wd === 6) return 'saturday';
  return 'weekday';
}

export function windowsFor(schedule, type) {
  if (schedule[type]) return schedule[type];
  if (type === 'holiday') return schedule.sunday ?? [];
  return schedule.weekday ?? [];
}

/** Minutes until the window containing `date` ends, or null when `date` is outside every window. */
function minutesLeft(schedule, date) {
  const parts = spParts(date);
  const now = parts.minutes;
  let best = null;
  const consider = (windows, shift) => {
    for (const [s, e] of windows) {
      const start = toMinutes(s) + shift, end = toMinutes(e) + shift;
      if (now >= start && now < end) best = Math.max(best ?? 0, end - now);
    }
  };
  consider(windowsFor(schedule, dayType(parts.iso)), 0);
  consider(windowsFor(schedule, dayType(previousDay(parts.iso))), -1440);
  return best;
}

export function isActive(schedule, date = new Date()) {
  return minutesLeft(schedule, date) != null;
}

/** When the stretch of back-to-back windows containing `date` ends, or null if inactive. */
export function activeUntil(schedule, date = new Date()) {
  let t = date;
  let left = minutesLeft(schedule, t);
  if (left == null) return null;
  for (let i = 0; i < 14 && left != null; i++) {
    t = new Date(t.getTime() + left * MINUTE);
    left = minutesLeft(schedule, t);
  }
  return t;
}

/** Start of the next window after `date`, searching up to 8 days ahead, or null. */
export function nextStart(schedule, date = new Date()) {
  const parts = spParts(date);
  let iso = parts.iso;
  for (let offset = 0; offset < 9; offset++) {
    const starts = windowsFor(schedule, dayType(iso))
      .map(([s]) => toMinutes(s) + offset * 1440 - parts.minutes)
      .filter((m) => m > 0);
    if (starts.length) return new Date(date.getTime() + Math.min(...starts) * MINUTE);
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    iso = d.toISOString().slice(0, 10);
  }
  return null;
}

const WEEKDAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Short Portuguese label for `target` as seen from `now`: "20:30", "amanhã 04:40", "sáb 14:00". */
export function describeTime(target, now = new Date()) {
  const a = spParts(now), b = spParts(target);
  const hhmm = `${String(b.hour).padStart(2, '0')}:${String(b.minute).padStart(2, '0')}`;
  const days = Math.round((Date.parse(`${b.iso}T12:00:00Z`) - Date.parse(`${a.iso}T12:00:00Z`)) / 86_400_000);
  if (days === 0) return hhmm;
  if (days === 1) return `amanhã ${hhmm}`;
  return `${WEEKDAY_NAMES[b.weekday]} ${hhmm}`;
}

/**
 * Bike status of a line with `service` hours and `bikes` hours at `date`.
 * Omit `service` for vehicles known to be running (live buses).
 * Returns { status: 'ok' | 'wait' | 'closed', detail }.
 */
export function bikeStatus({ service, bikes }, date = new Date()) {
  if (service && !isActive(service, date)) {
    const opens = nextStart(service, date);
    return { status: 'closed', detail: opens ? `Fechada · abre ${describeTime(opens, date)}` : 'Fechada' };
  }
  if (isActive(bikes, date)) {
    const bikeEnd = activeUntil(bikes, date);
    const serviceEnd = service && activeUntil(service, date);
    if (serviceEnd && serviceEnd <= bikeEnd) {
      return { status: 'ok', detail: `Bici liberada até o fechamento (${describeTime(serviceEnd, date)})` };
    }
    return { status: 'ok', detail: `Bici liberada até ${describeTime(bikeEnd, date)}` };
  }
  const next = nextStart(bikes, date);
  return { status: 'wait', detail: next ? `Bici liberada a partir de ${describeTime(next, date)}` : 'Bici não permitida' };
}
