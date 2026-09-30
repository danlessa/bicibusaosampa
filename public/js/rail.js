// Bike status of a metro/train line: timetable rules, overridden by the live operational status.

import { bikeStatus } from './schedule.js';
import { spParts } from './time.js';

// Live status codes (Motiva feed) that mean no trains are running.
const LIVE_CLOSED = new Set(['Paralisada', 'OperacaoParalisada', 'OperacaoEncerrada']);
// Codes not worth mentioning next to the timetable status.
const LIVE_QUIET = new Set(['OperacaoNormal', 'OperacaoTransitoria']);

/** First service schedule still valid on `date` (entries may carry an inclusive `until` date). */
export function currentService(line, date = new Date()) {
  const today = spParts(date).iso;
  return line.service.find((s) => !s.until || today <= s.until) ?? line.service.at(-1);
}

/**
 * { status: 'ok' | 'wait' | 'closed', detail, live?, note? } for `line`, given the
 * default `bikes` schedule and the line's `live` status ({ code, status, description }).
 */
export function railStatus(line, bikes, live, date = new Date()) {
  const service = currentService(line, date);
  const result = bikeStatus({ service, bikes: line.bikes ?? bikes }, date);
  if (live?.code && result.status !== 'closed') {
    if (LIVE_CLOSED.has(live.code)) {
      return { status: 'closed', detail: live.status, live: live.description ?? undefined };
    }
    if (!LIVE_QUIET.has(live.code)) {
      return { ...result, live: [live.status, live.description].filter(Boolean).join(': ') };
    }
  }
  return { ...result, note: service.note };
}
