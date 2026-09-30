// Time helpers pinned to São Paulo local time, regardless of the viewer's timezone.

const TZ = 'America/Sao_Paulo';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `date` in São Paulo. */
export function spParts(date = new Date()) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute,
    weekday: WEEKDAYS[p.weekday],
    iso: `${p.year}-${p.month}-${p.day}`,
    minutes: +p.hour * 60 + +p.minute,
  };
}

/** ISO date (YYYY-MM-DD) of the calendar day before `iso`. */
export function previousDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of an ISO date. */
export function weekdayOf(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/** Easter Sunday (Gregorian, anonymous algorithm) as ISO date. */
export function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shift(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Holidays observed in the city of São Paulo (national + state + municipal),
 * as a Map of ISO date -> name. Carnival is only "ponto facultativo", so it is left out.
 */
export function holidays(year) {
  const fixed = [
    ['01-01', 'Confraternização Universal'],
    ['01-25', 'Aniversário de São Paulo'],
    ['04-21', 'Tiradentes'],
    ['05-01', 'Dia do Trabalho'],
    ['07-09', 'Revolução Constitucionalista'],
    ['09-07', 'Independência do Brasil'],
    ['10-12', 'Nossa Senhora Aparecida'],
    ['11-02', 'Finados'],
    ['11-15', 'Proclamação da República'],
    ['11-20', 'Dia da Consciência Negra'],
    ['12-25', 'Natal'],
  ];
  const e = easter(year);
  const map = new Map(fixed.map(([md, name]) => [`${year}-${md}`, name]));
  map.set(shift(e, -2), 'Sexta-feira Santa');
  map.set(shift(e, 60), 'Corpus Christi');
  return map;
}

/** Name of the holiday on `iso`, or null. */
export function holidayName(iso) {
  return holidays(+iso.slice(0, 4)).get(iso) ?? null;
}
