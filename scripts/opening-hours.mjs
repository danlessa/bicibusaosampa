// Converts the simple OpenStreetMap `opening_hours` values found on bike parking
// ("24/7", "Mo-Su 04:00-23:59", "Mo-Fr 07:00-19:00; Sa 08:00-12:00", "Mo-Su,PH 04:00-24:00")
// into the schedule format of public/js/schedule.js: { weekday, saturday, sunday, holiday }.
//
// Returns null for anything it can't represent faithfully (unknown syntax, or Monday
// to Friday with different hours), so the map says "hours unknown" rather than guess.
// Without a PH rule, holidays get Sunday's hours (schedule.js's own fallback).

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const TIME_RANGE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${m}`;

/** "Mo-Fr,Su,PH" -> ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Su', 'PH'], or null. */
function parseDays(selector) {
  const days = [];
  for (const part of selector.split(',')) {
    if (part === 'PH') { days.push('PH'); continue; }
    const [from, to = from] = part.split('-');
    const a = DAYS.indexOf(from), b = DAYS.indexOf(to);
    if (a < 0 || b < 0) return null;
    for (let i = a; ; i = (i + 1) % 7) {
      days.push(DAYS[i]);
      if (i === b) break;
    }
  }
  return days;
}

/** "06:00-12:00,13:00-22:00" -> [["06:00", "12:00"], ["13:00", "22:00"]], or null. */
function parseTimes(text) {
  const windows = [];
  for (const range of text.split(',')) {
    const m = TIME_RANGE.exec(range.trim());
    if (!m) return null;
    const [, h1, m1, h2, m2] = m;
    let end = +h2 * 60 + +m2;
    const start = +h1 * 60 + +m1;
    if (end <= start) end += 1440; // "22:00-02:00" runs past midnight
    windows.push([hhmm(+h1, m1), hhmm(Math.floor(end / 60), String(end % 60).padStart(2, '0'))]);
  }
  return windows;
}

export function parseOpeningHours(value) {
  const text = value?.trim();
  if (!text) return null;
  if (text === '24/7') return { weekday: [['00:00', '24:00']], saturday: [['00:00', '24:00']], sunday: [['00:00', '24:00']], holiday: [['00:00', '24:00']] };

  // Later rules override earlier ones for the days they name, as in OSM.
  const byDay = {};
  for (const rule of text.split(';').map((r) => r.trim()).filter(Boolean)) {
    const m = /^([A-Za-z,-]+)\s+(.+)$/.exec(rule);
    const days = m ? parseDays(m[1]) : null;
    if (!days) return null;
    const windows = m[2] === 'off' || m[2] === 'closed' ? [] : parseTimes(m[2]);
    if (!windows) return null;
    for (const d of days) byDay[d] = windows;
  }

  const key = (d) => JSON.stringify(byDay[d] ?? []);
  if (!['Tu', 'We', 'Th', 'Fr'].every((d) => key(d) === key('Mo'))) return null;
  const schedule = { weekday: byDay.Mo ?? [], saturday: byDay.Sa ?? [], sunday: byDay.Su ?? [] };
  if (byDay.PH) schedule.holiday = byDay.PH;
  return schedule;
}
