// The user's position: the locate button, the blue dot, and the starting view.
//
// The map opens on Terminal Bandeira. If the browser already has permission to share
// the location, it follows the user from the start (zoom 16); the permission prompt only
// appears when the user taps the button or asks the planner for "my location".

import { toast } from './ui.js';

export const DEFAULT_VIEW = { center: [-23.5496, -46.6396], zoom: 16 }; // Terminal Bandeira
const ZOOM = 16;

export function initLocate(map) {
  const button = document.getElementById('locate-btn');
  map.createPane('me').style.zIndex = 630;
  let watching = false;
  let centred = false;
  let last = null; // L.LatLng of the latest fix
  let dot = null, ring = null;
  const waiting = []; // resolvers of position() calls made before the first fix

  function start() {
    if (!navigator.geolocation) { toast('Este navegador não informa a localização'); return; }
    watching = true;
    centred = false;
    button.setAttribute('aria-pressed', 'true');
    button.classList.add('busy');
    map.locate({ watch: true, setView: false, enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  }

  function stop() {
    watching = false;
    map.stopLocate();
    button.setAttribute('aria-pressed', 'false');
    button.classList.remove('busy');
    dot?.remove(); ring?.remove();
    dot = ring = null;
  }

  map.on('locationfound', (e) => {
    if (!watching) return;
    button.classList.remove('busy');
    last = e.latlng;
    if (ring) ring.setLatLng(e.latlng).setRadius(e.accuracy);
    else ring = L.circle(e.latlng, { pane: 'me', radius: e.accuracy, color: '#2563eb', weight: 1, opacity: 0.5, fillOpacity: 0.1, interactive: false }).addTo(map);
    if (dot) dot.setLatLng(e.latlng);
    else dot = L.circleMarker(e.latlng, { pane: 'me', radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1, interactive: false }).addTo(map);
    if (!centred) {
      centred = true;
      map.setView(e.latlng, Math.max(map.getZoom(), ZOOM));
    }
    while (waiting.length) waiting.shift().resolve(e.latlng);
  });

  map.on('locationerror', (e) => {
    if (!watching) return;
    if (last) return; // a hiccup after a good fix: keep the last one
    toast(e.code === 1 ? 'Permita a localização nas configurações do navegador' : 'Não consegui achar sua localização');
    while (waiting.length) waiting.shift().reject(new Error('sem localização'));
    stop();
  });

  button.addEventListener('click', () => {
    if (!watching) return start();
    // Already following: bring the dot back into view first, stop on a second tap.
    if (last && !map.getBounds().pad(-0.2).contains(last)) map.setView(last, Math.max(map.getZoom(), ZOOM));
    else stop();
  });

  // Follow from the start only if the user already said yes before (no prompt on load).
  navigator.permissions?.query({ name: 'geolocation' })
    .then((s) => { if (s.state === 'granted') start(); })
    .catch(() => {});

  return {
    /** Latest position, asking for it (and the permission) if needed. */
    position() {
      if (last && watching) return Promise.resolve(last);
      if (!watching) start();
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}
