// Bike parking (bicicletários and paraciclos): what the map says about each one.
// Properties come from scripts/parking.mjs; `hours` is "24h", a schedule.js schedule,
// or absent when unknown.

import { activeUntil, describeTime, isActive, nextStart } from './schedule.js';
import { spParts } from './time.js';

export const ACCESS = {
  livre: { label: 'Livre', detail: 'Gratuito e sem cadastro.' },
  cadastro: { label: 'Com cadastro', detail: 'Gratuito, com cadastro no local: leve um documento com foto (a CPTM pede também comprovante de residência).' },
  pago: { label: 'Pago', detail: 'Cobra pelo uso.' },
  clientes: { label: 'Só clientes', detail: 'Reservado a clientes ou usuários autorizados.' },
};

function until(end, now) {
  const p = spParts(end);
  return p.hour === 0 && p.minute === 0 ? 'meia-noite' : describeTime(end, now);
}

/**
 * Whether a parking spot is open at `date`.
 * Returns { open: true | false | null (unknown), detail }; `colorKey` is its access,
 * or 'closed' when it's closed now.
 */
export function parkingStatus({ access, hours, kind }, date = new Date()) {
  if (hours === '24h') return { open: true, colorKey: access, detail: 'Aberto 24 horas' };
  if (!hours) {
    // Street stands are always reachable; station and terminal bicicletários follow the station.
    const detail = access === 'cadastro' ? 'Horário não informado (em geral, o da estação ou terminal)'
      : kind === 'bicicletario' ? 'Horário não informado' : null;
    return { open: null, colorKey: access, detail };
  }
  if (isActive(hours, date)) return { open: true, colorKey: access, detail: `Aberto até ${until(activeUntil(hours, date), date)}` };
  const opens = nextStart(hours, date);
  return { open: false, colorKey: 'closed', detail: opens ? `Fechado · abre ${describeTime(opens, date)}` : 'Fechado' };
}
