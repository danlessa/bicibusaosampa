# Bici Busão Sampa

Live map of the buses and metro/train lines in Greater São Paulo that carry bicycles,
and of the places to park a bike, served at https://busao.bicisampa.info. A static
Leaflet site plus three Cloudflare Pages Functions. No framework and no build step for
the site.

It's the first piece of a planned *bicycling digital twin* of São Paulo: a PWA (later
native apps) for everyday cyclists, aggregating many stakeholders' data, with
intermodal routing (bike + bus + train) and feedback later. Favour mobile-friendly,
light, reusable-data choices.

## Commands

```sh
npm run dev          # wrangler pages dev → http://localhost:8788 (reads SPTRANS_TOKEN from .env)
npm test             # node --test: schedule rules, holidays, headings, lanes, bike parking, function helpers
npm run build:data   # regenerate data files (`-- rail`, `-- bus`, `-- parking` or `-- fleet` for one)
node scripts/suggest-lines.mjs [--write]   # compare live rack buses with the expected lines
```

To check UI changes, run the dev server and take screenshots with Playwright. Use
`page.clock.install()` to test other times of day; the colours depend on the clock.
`map` isn't global: to move the view, intercept `js/app.js` with `page.route()` and
append `window.__map = map;`.

## Layout

- `public/`: the site, deployed as-is.
  - `js/app.js`: map, layers, panel, polling (rail status 60 s, buses 20 s).
  - Pure modules, imported by the tests too:
    - `time.js`: São Paulo time and holidays.
    - `schedule.js`: time-window engine.
    - `rail.js`: line status = timetable plus live override.
    - `heading.js`: bus direction of travel.
    - `offset.js`: polylines offset sideways by a zoom-dependent number of pixels.
    - `parking.js`: bike parking access labels and open/closed status.
  - `data/rail-lines.json`, `data/bike-buses.json`: **hand-edited** config (lines,
    colours, operating hours, bike rules, the *expected* lines of the rack buses).
  - `data/*.geojson`: **generated** by `scripts/build-data.mjs`. Never edit by hand.
    Bus routes carry a precomputed `lane` (`scripts/lanes.mjs`).
  - `data/bike-parking.geojson`: **generated** bicicletários and paraciclos in the
    RMSP: OSM `amenity=bicycle_parking` (inside OSM relation 2661855) merged with the
    GeoSampa `bicicletario_paraciclo` layer. Classified by `scripts/parking.mjs`;
    OSM `opening_hours` become schedule.js schedules (`scripts/opening-hours.mjs`,
    simple forms only, else unknown).
  - `data/lines/<code>.json`: **generated** route and stops of every SPTrans bus line
    (from the GTFS, ~1,350 files, ≤32 KB each), loaded when a rack bus runs off its
    expected lines.
- `data/bike-fleet.json`: **generated** from `assets/00_businfo_consolidado.csv`
  (SPTrans fleet register): prefixes of `cidade=SP`, `tipo=A23` ("Articulado 23m")
  buses. Electric `eA3` buses have no rack and are excluded. Server-side only.
  `assets/` is gitignored: only the bus numbers are tracked. Rebuild the list locally
  (`npm run build:data -- fleet`) when the CSV is updated; elsewhere the step is skipped.
- `functions/api/buses.js`: keeps the `/Posicao` vehicles whose prefix is in the fleet
  list, wherever they run; each gets `expected: false` when its line isn't in
  `bike-buses.json`. In production the snapshot comes from the relay
  (`OLHOVIVO_RELAY_URL` + `OLHOVIVO_RELAY_KEY`); without those (local dev) it logs in
  to Olho Vivo directly with `SPTRANS_TOKEN`.
- `relay/`: tiny Node service on Cloud Run (GCP project `bicisampa`,
  `southamerica-east1`, service `olhovivo-relay`). `GET /posicao` with `X-Relay-Key`
  returns the raw `/Posicao` JSON, cached 15 s. Secrets in Secret Manager:
  `sptrans-token`, `relay-key`. Deploy command in `relay/README.md`.
- `functions/api/route.js`: route of any line from GeoSampa WFS (`geoportal:linha_onibus`),
  the fallback for off-route lines missing from `data/lines/`. Cached a day.
- `functions/api/rail-status.js`: proxy for the Motiva line-status feed, which covers
  every operator.
- `functions/_lib/`: shared function code.
  - `cache.js`: edge cache with stale-while-revalidate.
  - `vehicles.js`: the vehicle filter, kept separate so Node can test it.

## Gotchas

- **Cloudflare's Pages build compiles Functions with wrangler 3.x.** Its bundler rejects
  JSON import attributes (`with { type: 'json' }`), even though local wrangler 4 accepts
  them. Keep JSON imports plain inside `functions/`. Logic that Node tests need goes in
  `functions/_lib/` without JSON imports. To check that a change builds:
  `npx wrangler@3.114.17 pages functions build --outdir /tmp/x`.
- **Pushing to `main` deploys to production** through the Pages Git integration. Only
  commit or push when asked.
- **A GitHub Action commits regenerated data** ("Atualiza camadas do mapa") every Monday
  and whenever a config file changes. Pull before you push.
- **Secrets:** `SPTRANS_TOKEN` lives in `.env` locally (gitignored), in Secret Manager
  (`sptrans-token`, for the relay) and as a Pages secret. Pages also has
  `OLHOVIVO_RELAY_URL` and `OLHOVIVO_RELAY_KEY`. Pages only picks up a new secret on
  the next deployment.
- **Cloud Run reserves paths ending in `z`** (e.g. `/healthz`); the relay uses `/health`.
- **Olho Vivo** (`api.olhovivo.sptrans.com.br/v2.1`):
  - Blocks requests from Cloudflare Workers since ~2026-10 (HTTP 403, Cloudflare error
    1106), hence the relay on GCP. Google Cloud egress isn't blocked.
  - No CORS; the login cookie only works server-side.
  - `/Login/Autenticar` returns `false` for any bad token, with no detail.
  - `/Posicao` has no vehicle-type or bike-rack field.
  - `sl` 1/2 equals GTFS `direction_id` 0/1. The destination is `lt0` when `sl` is 1,
    and `lt1` otherwise.
- **The Motiva status feed** (`webapi.grupoccr.com.br`) returns an empty body to any
  browser Origin, so it must be called server-side.
- **Overpass is often overloaded.** The build script tries several mirrors and keeps the
  existing file if all of them fail. Downloads are cached in `.cache/` for a day.
  Mirrors can lag weeks behind the main server (check `osm3s.timestamp_osm_base`).
- **GeoSampa bike parking** (`geoportal:bicicletario_paraciclo`) covers only the city
  of São Paulo, and its points sit 50–200 m from the same parking in OSM. The build
  merges a GeoSampa point into an OSM spot of the same kind within 250 m.
- **Other Claude sessions may share this working tree.** Check `git status` and
  `git diff` before committing, and commit only your own changes.
- **All times are `America/Sao_Paulo`.** Schedules are `"HH:MM"` windows per day type
  (`weekday`, `saturday`, `sunday`, `holiday`). An end time past `24:00` spills into the
  next day; the Metrô's Saturday-night 24h service uses this. A `service` entry can
  carry an `until` date.
- **Holidays:** national, state (9/7) and city (25/1, Corpus Christi). Carnival is left
  out on purpose, because it's only *ponto facultativo*.

## Domain rules (verify before changing)

- **Rail (all operators):** regular bikes are allowed on weekdays 10:00–16:00 and from
  21:00 to closing, and all day on weekends and holidays. Folding bikes are allowed at
  any time.
- **SPTrans buses:** only superarticulated 23 m buses have a bike rack (Portaria SMT
  32/2016). Bikes are allowed on weekdays 10:01–15:59 and 19:01–05:59, on Saturdays
  from 14:00, and all day on Sundays and holidays. SPTrans publishes no list of these
  buses or lines; we use the fleet register CSV for buses and `suggest-lines.mjs` for
  the expected lines (3+ rack buses that are 20%+ of the line's buses).
- **Intercity buses (Artesp, formerly EMTU)** don't carry bikes and are out of scope.
- **Bike parking:** station and terminal bicicletários (Metrô, CPTM, ViaQuatro,
  ViaMobilidade, SPTrans terminals run by Socicam, EMTU, Tembici) are free but need an
  on-site sign-up with a photo ID (CPTM also asks for proof of address). They're
  classed `cadastro` even when OSM tags them private. Paraciclos need no sign-up.
  Private parking is left out.

## Visual conventions (chosen by the maintainer)

- **Rail lines:** thin continuous lines in the status colour: green when bikes are
  allowed now, yellow when the line runs but it's outside bike hours, red when the line
  is closed or stopped.
- **Stations:** official Metrô or CPTM icons (`public/icons/`, from Wikimedia Commons),
  chosen by each line's `mode`.
- **Bus colours** (icons, routes, badges) combine two questions: bikes allowed on buses
  at this hour, and is this one of the line's usual superarticulated lines?
  Allowed + usual = green, allowed + off-route = purple, outside hours + usual =
  yellow, outside hours + off-route = orange.
- **Bus icons:** a rounded box in the bus colour with a white arrow pointing the
  direction of travel.
- **Bus routes:** solid lines in the bus colour, 10 m wide on the ground (never under
  1.5 px). They're offset into lanes so both directions and shared corridors lie side
  by side.
- **Bus stops:** a front-view bus icon, shown from zoom 14; downloaded on first zoom-in
  and only the ones in view are on the map.
- **Bike parking:** a house for a bicicletário (from zoom 12), a circle for a paraciclo
  (from zoom 14), with a white inverted-U stand and a dark outline. Colour: green =
  free, no sign-up; blue = free with sign-up; pink = paid; grey = customers only;
  red = closed now (overrides the others).
- **Layer control:** toggles rail lines, stations, bus routes, live buses, bus stops
  and bike parking.

## Style

- UI text, the README and data-file comments are in Portuguese. Code comments are in
  English.
- Plain ES modules with no dependencies in the browser. Leaflet is loaded from cdnjs.
