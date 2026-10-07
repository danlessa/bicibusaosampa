# Bici Busão Sampa

Live map of the buses and metro/train lines in Greater São Paulo that carry bicycles,
served at https://busao.bicisampa.info. A static Leaflet site plus two Cloudflare Pages
Functions. No framework and no build step for the site.

## Commands

```sh
npm run dev          # wrangler pages dev → http://localhost:8788 (reads SPTRANS_TOKEN from .env)
npm test             # node --test: schedule rules, holidays, headings, lanes, function helpers
npm run build:data   # regenerate public/data/*.geojson (`npm run build:data -- rail` or `-- bus` for one)
```

To check UI changes, run the dev server and take screenshots with Playwright. Use
`page.clock.install()` to test other times of day; the colours depend on the clock.

## Layout

- `public/`: the site, deployed as-is.
  - `js/app.js`: map, layers, panel, polling (rail status 60 s, buses 20 s).
  - Pure modules, imported by the tests too:
    - `time.js`: São Paulo time and holidays.
    - `schedule.js`: time-window engine.
    - `rail.js`: line status = timetable plus live override.
    - `heading.js`: bus direction of travel.
    - `offset.js`: pixel-offset polylines and lane assignment.
    - `hatch.js`: canvas hatch-pattern renderer.
  - `data/rail-lines.json`, `data/bike-buses.json`: **hand-edited** config (lines,
    colours, operating hours, bike rules, which bus lines carry bikes, `electric` flag).
  - `data/*.geojson`: **generated** by `scripts/build-data.mjs`. Never edit by hand.
- `functions/api/buses.js`: Olho Vivo proxy. Logs in with `SPTRANS_TOKEN` and filters
  `/Posicao` down to the configured lines and prefixes.
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
- **`SPTRANS_TOKEN`** lives in `.env` locally (gitignored) and as a Pages production
  secret. Pages only picks up a new secret on the next deployment.
- **Olho Vivo** (`api.olhovivo.sptrans.com.br/v2.1`):
  - No CORS; the login cookie only works server-side.
  - `/Login/Autenticar` returns `false` for any bad token, with no detail.
  - `/Posicao` has no vehicle-type or bike-rack field.
  - `sl` 1/2 equals GTFS `direction_id` 0/1. The destination is `lt0` when `sl` is 1,
    and `lt1` otherwise.
- **The Motiva status feed** (`webapi.grupoccr.com.br`) returns an empty body to any
  browser Origin, so it must be called server-side.
- **Overpass is often overloaded.** The build script tries several mirrors and keeps the
  existing file if all of them fail. Downloads are cached in `.cache/` for a day.
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
  lines, so `bike-buses.json` is curated by hand.
- **Intercity buses (Artesp, formerly EMTU)** don't carry bikes and are out of scope.

## Visual conventions (chosen by the maintainer)

- **Rail lines:** thin continuous lines in the status colour: green when bikes are
  allowed now, yellow when the line runs but it's outside bike hours, red when the line
  is closed or stopped.
- **Stations:** official Metrô or CPTM icons (`public/icons/`, from Wikimedia Commons),
  chosen by each line's `mode`.
- **Bus icons:** a side view with chevrons pointing the direction of travel. The body
  is green for conventional buses and yellow for electric ones. The outline is black
  when bikes are allowed and red when they aren't.
- **Bus routes:** green, or yellow if electric, hatched black. They're offset into
  lanes so both directions and shared corridors show side by side; the offset shrinks
  when zoomed out.
- **Bus stops:** a front-view bus icon, shown from zoom 14.
- **Layer control:** toggles rail lines, stations, bus routes, live buses and bus stops.

## Style

- UI text, the README and data-file comments are in Portuguese. Code comments are in
  English.
- Plain ES modules with no dependencies in the browser. Leaflet is loaded from cdnjs.
