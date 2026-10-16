// EMTU seletivo lines: routes and stops from rest-emtu.noxxonsat.com.br (lineDetails),
// the feed behind EMTU's own apps. Used by build-data.mjs (`emtu`).

import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

import { EMTU_SENTIDO } from '../functions/_lib/emtu.js';
import { decodePolyline, round, simplify } from '../functions/_lib/geometry.js';

const EMTU_HOST = 'rest-emtu.noxxonsat.com.br';

/**
 * GET from the EMTU feed. Its certificate expired in April 2025: that one error is
 * accepted, for this host only. The chain and the host name are still checked.
 * (relay/server.mjs has the same function: the relay is deployed on its own.)
 */
export function emtuGet(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: EMTU_HOST, path, agent: false, rejectUnauthorized: false, timeout: 30_000, headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`EMTU ${path}: HTTP ${res.statusCode}`));
        resolve(Buffer.concat(chunks));
      });
    });
    // A fresh connection per request (agent: false), so every one goes through this check.
    req.on('socket', (socket) => socket.once('secureConnect', () => {
      const err = socket.authorized ? null
        : socket.authorizationError !== 'CERT_HAS_EXPIRED' ? new Error(`EMTU TLS: ${socket.authorizationError}`)
        : checkServerIdentity(EMTU_HOST, socket.getPeerCertificate());
      if (err) req.destroy(err);
    }));
    req.on('timeout', () => req.destroy(new Error(`EMTU ${path}: timeout`)));
    req.on('error', reject);
    req.end();
  });
}

/** "Rua X, 130 - Centro, Osasco - SP, 06020-012, Brasil" -> "Rua X, 130 - Centro, Osasco". */
export function stopName(address) {
  return String(address ?? '')
    .replace(/,\s*Brasil\s*$/i, '')
    .replace(/,?\s*\d{5}-?\d{3}\s*$/, '')
    .replace(/\s*-\s*SP\s*$/, '')
    .trim();
}

/**
 * `details` maps line code to its lineDetails answer; `config` is
 * public/data/emtu-seletivo.json. Returns GeoJSON features (routes without lanes yet,
 * stops), and the configured lines the feed doesn't know.
 */
export function emtuFeatures(details, config) {
  const routes = [], stops = new Map(), missing = [];
  for (const { code, name, operator } of config.lines) {
    const line = details[code]?.linhas?.find((l) => l.codigo === code);
    if (!line?.rotas?.length) {
      missing.push(code);
      continue;
    }
    for (const r of line.rotas) {
      const coordinates = simplify(decodePolyline(r.encode ?? '').map(([lon, lat]) => [round(lon), round(lat)]));
      if (coordinates.length < 2) continue;
      routes.push({
        type: 'Feature',
        properties: {
          code, name, operator, agency: 'emtu', fare: line.tarifa ?? null,
          sentido: EMTU_SENTIDO[r.sentido] ?? 1,
          headsign: r.destino,
        },
        geometry: { type: 'LineString', coordinates },
      });
      for (const p of r.pontos ?? []) {
        const id = `emtu-${p.id}`;
        if (!stops.has(id)) {
          stops.set(id, {
            type: 'Feature',
            properties: { id, name: stopName(p.endereco), lines: [] },
            geometry: { type: 'Point', coordinates: [round(p.longitude), round(p.latitude)] },
          });
        }
        const lines = stops.get(id).properties.lines;
        if (!lines.includes(code)) lines.push(code);
      }
    }
  }
  return { routes, stops: [...stops.values()], missing };
}
