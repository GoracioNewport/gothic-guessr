# Gothic Guessr

A GeoGuessr-style browser game set in the world of Gothic II: Khorinis, the Valley of Mines and Jharkendar. You are
dropped at a random spot, look around in a 360° panorama, walk along the paths the NPCs use, and place your guess on
the map. 3, 5 or 10 rounds, up to 5000 points each.

**Live demo: https://gothicguessr.goracionewport.fyi**

This repository holds the code only. The panoramas, maps, textures and fonts are rendered or extracted from the
original game files, which are not distributed here. With your own copy of Gothic II you can rebuild all of it; see
[Reproduce from your own copy of the game](#reproduce-from-your-own-copy-of-the-game).

## Features

- About 5600 pre-rendered panoramas over three worlds, connected by the game's waypoint network: you move by
  jumping between neighbouring waypoints, like Street View.
- Three start modes: Classic (open air only), Mixed (about a third of the rounds in caves, houses or deep woods; the
  default) and Hardcore (any spot).
- Solo games, each of which doubles as a challenge link friends can replay; a daily challenge (same rounds for
  everyone, one attempt per UTC day) with a leaderboard; party rooms for up to 16 players; 1-on-1 duels with health
  points.
- English, German, Polish and Russian UI in the game's own fonts and menu art.
- The server owns the answers: the client never sees where a panorama is until the guess is in (SPEC §10.3), and the
  e2e suite crawls every response for leaks.
- An admin panel at a secret path with statistics, player reports, the daily and moderation tools.

## Tech stack

- Client: Vite + TypeScript, no framework; [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/) with tiled
  cubemaps for the panoramas, [Leaflet](https://leafletjs.com/) for the map.
- Server: Node 24, [Hono](https://hono.dev/), `ws` for the room WebSocket hub, SQLite through `better-sqlite3`. The
  REST/WS contract is shared with the client in `shared/api.ts`.
- Pipeline: Python 3.12 with [ZenKit](https://github.com/GothicKit/ZenKit) (`zenkit` on PyPI) to read the game
  archives and moderngl for headless OpenGL rendering; Pillow and fontTools for the UI assets.
- Tests: Vitest (unit + HTTP/WebSocket integration), Playwright (end-to-end, several browsers per room).
- Deployment: nginx in front of a single Node process under systemd, Let's Encrypt, nightly SQLite backups.

`SPEC.md` is the full specification (data contract, API, rooms protocol, admin) and `RECON.md` the research behind
the rendering approach (in Russian).

## Quick start

Requirements: Node 22 or newer (24 LTS recommended). The game also needs the UI assets and a rendered dataset, which
come from your copy of the game (next section); without them `npm run build` stops with a hint, and the dev server
starts but cannot create games.

```bash
npm install
npm run setup      # once: writes .env.local with a random admin password, admin path and server secret
npm run dev        # Vite on http://localhost:5173 + API on :8787 (tsx watch); Vite proxies /api and /ws
```

`npm run setup` never prints the values it generates. To log in to the admin, open `.env.local` in your editor and
copy `ADMIN_PATH` and `ADMIN_PASSWORD` from there: the admin lives at `http://localhost:5173/<ADMIN_PATH>`. Do not
`cat` the file into a terminal, a chat or a log. In development an unset `ADMIN_PATH` falls back to `admin`;
production refuses to start without one or with `admin`.

Other scripts:

```bash
npm run dev:client # only Vite        npm run dev:server   # only the API (API_PORT, default 8787)
npm run typecheck  # tsc over src/, server/, shared/, tests/
npm run build      # typecheck + dist/ (client with the UI assets, without the dataset) + dist-server/main.js
npm start          # production: one Node process on PORT serving dist/, /data (DATA_DIR), /api and /ws
```

## Reproduce from your own copy of the game

The repository holds code only. Every texture, font, icon, map and panorama the game shows is extracted or rendered
from the original game files, and those are not distributed here: you need your own copy of Gothic II.

### Requirements

- **Gothic II Gold** (Gothic II + Night of the Raven), e.g. Steam app 39510 "Gothic II: Gold Classic" (English). Any
  install with `Data/*.vdf` and `System/` works; Wine/CrossOver installs too.
- **Python via [uv](https://docs.astral.sh/uv/)**: the tools run with `uv run --with ...`, nothing is installed into
  the repository. Tested on macOS (Apple Silicon) with Python 3.12; the renderer needs the `zenkit` wheel for your
  platform and a headless OpenGL context (moderngl).
- **Node 24** LTS (22 or newer) for the client and the API.
- About 18 GB of free disk for the three rendered worlds (5600 panoramas), 8 GB more for the optional release copy.

### Environment

| Variable | Needed by | Value |
|---|---|---|
| `GOTHIC2_DIR` | `npm run assets`, `tools/g2pipeline.py` and the other game readers | the install root, the folder with `Data/` and `System/` |
| `GOTHIC2_RU_DIR` | `npm run assets` (optional) | Russian Steam language depot 39518, for the Russian game fonts |
| `GOTHIC2_PL_DIR` | `npm run assets` (optional) | Polish Steam language depot 39516, for the Polish game fonts |

Without the language depots Russian and Polish pages fall back to Alegreya. How to download only a depot
(`download_depot 39510 39518` in the Steam console) is in `docs/FONTS.md`. `tools/build_assets.sh --help` lists the
remaining knobs (`ASSETS_OUT` / `--out` for another output folder, `DATA_DIR`, `SERVER_DATA_DIR`).

### Steps

```bash
export GOTHIC2_DIR="$HOME/.steam/steam/steamapps/common/Gothic II"      # your install
export GOTHIC2_RU_DIR=".../steamapps/content/app_39510/depot_39518"     # optional
export GOTHIC2_PL_DIR=".../steamapps/content/app_39510/depot_39516"     # optional
npm install

# 1. UI assets -> public/ui/gothic/ (textures, menu art, maps, fonts, web fonts, icons; ~20 s)
npm run assets

# 2. Render the three worlds -> out/<slug>/ (Khorinis ~25 min on an M4 Pro, ~2800 panoramas)
PY="uv run --with-requirements tools/requirements.txt python"
$PY tools/g2pipeline.py --world NEWWORLD.ZEN   --slug khorinis   --name "Khorinis"        --out out
$PY tools/g2pipeline.py --world OLDWORLD.ZEN   --slug valley     --name "Valley of Mines" --out out
$PY tools/g2pipeline.py --world ADDONWORLD.ZEN --slug jharkendar --name "Jharkendar"      --out out
for w in khorinis valley jharkendar; do python3 tools/check_dataset.py out/$w; done

# 3. Publish: public tiles -> public/data/, private manifests -> server-data/ (both git-ignored)
python3 tools/publish_dataset.py --from out khorinis valley jharkendar --dry-run
python3 tools/publish_dataset.py --from out khorinis valley jharkendar
python3 tools/check_dataset.py
npm run assets          # again, now that the dataset exists: adds the link-preview image og-image.jpg

# 4. Optional: a smaller copy for deployment (1536 px faces, WebP q70) -> out/release-f1536q70/
uv run --with pillow python tools/make_release.py   # serve it with DATA_DIR=out/release-f1536q70 npm start

# 5. Run
npm run setup           # once: .env.local with random secrets (values are not printed)
npm run dev             # http://localhost:5173
```

Pipeline flags: `--near WAYPOINT:RADIUS_M` renders a small cluster for development, `--face/--tile/--base/--quality`
control the panorama resolution, `--skip-map` / `--skip-panos` split the work. To eyeball random spots:
`$PY tools/qa_contact_sheet.py out/khorinis --n 24 --starts-only --out qa.jpg` (before publishing).

The server must be the only one that knows where a panorama is (SPEC §10.3), so `tools/publish_dataset.py` (Python
stdlib only, idempotent, restartable) splits a rendered world into `server-data/<slug>/manifest.json` (the full
manifest with a random 12-char key per node) and `public/data/<slug>/world.json` + `map/`, `public/data/panos/<key>/`
(one flat folder for all worlds) and `public/data/worlds.json`; no full manifest stays under `public/`. Keys stay
stable per waypoint name across re-publishes, so links and the daily history survive a re-render. Displaced folders go
to `server-data/<slug>/backup/<stamp>/` (delete them once the new data is fine), `--rollback <slug>` undoes the last
publish, and the API has to be restarted afterwards because it loads the private manifests at start.

## Configuration

The server reads `.env.local` in the project root first; real environment variables override it (see
`server/config.ts`).

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | written by `npm run setup` | admin login |
| `ADMIN_PATH` | `admin` in dev only | the admin UI is served at `/<ADMIN_PATH>`, its API at `/api/<ADMIN_PATH>/*`; `/admin` answers 404 when it differs |
| `SERVER_SECRET` | written by `npm run setup` | seeds the daily rounds and signs admin sessions; changing it changes every future daily |
| `PORT` / `API_PORT`, `HOST` | `8787`, `localhost` in dev | where the API listens |
| `DATA_DIR` | `public/data` | the public dataset (tiles, maps, `worlds.json`) |
| `SERVER_DATA_DIR` | `server-data` | private manifests (`<slug>/manifest.json`) |
| `DB_PATH` | `server-data/db.sqlite` | SQLite database: players, challenges, games, statistics |
| `DIST_DIR` | `dist` | built client for `npm start` |
| `TRUST_PROXY` | off | `1` behind a reverse proxy that overwrites `X-Forwarded-For` |
| `PUBLIC_ORIGIN` | none | origin used in share texts, e.g. `https://example.org` |
| `PUBLIC_CONTACT` | none | optional contact shown in the in-game legal notice |

`.env.local`, `server-data/`, `public/data/`, `public/ui/gothic/` and `out/` are git-ignored. Rooms live in memory;
on start the API finishes room games that a previous process left running, so their challenge links still open.

## Tests

```bash
npm test                         # vitest: client tests + tests/server/** (HTTP/WebSocket integration on synthetic worlds)
npx playwright install chromium  # once, for the e2e suite
npm run e2e                      # Playwright: solo, daily, challenge, party (3 browsers), duel, languages, admin, leaks
```

The server suites run on synthetic fixture worlds. Five client suites (`tests/graph`, `rounds`, `state`,
`starts-in-frame`, `worlds`) still read the published Khorinis manifest from `server-data/`, and `npm run e2e` needs
the UI assets and the dataset. The e2e run starts its own API on :9787 and Vite on :6173 (override with
`E2E_API_PORT` / `E2E_PORT`) with a fresh database in a temporary directory and a random admin password and path, so
it neither touches `server-data/db.sqlite` nor reads the secrets of `.env.local`. Its last project crawls every
recorded `/api`, `/data` and WebSocket body for leaked coordinates, waypoint names and seeds.

## Deployment

[`deploy/`](deploy/README.md) is a self-contained kit for one Debian 13 server: nginx (TLS, caching, rate limits,
security headers) in front of Node under a sandboxed systemd unit, Let's Encrypt, daily database backups, resumable
dataset upload and releases with automatic rollback. The scripts run from your machine over ssh; the target is set
with `DEPLOY_HOST`, secrets are generated on the server and never leave it. The step-by-step guide, traffic
measurements and capacity estimates are in [deploy/README.md](deploy/README.md) (in Russian).

```bash
export DEPLOY_HOST=my-server     # ssh alias or root@host
deploy/scripts/bootstrap.sh --yes
deploy/scripts/secrets.sh
deploy/scripts/push-data.sh
deploy/scripts/push-app.sh
deploy/scripts/tls.sh example.org admin@example.org
```

## Project layout

- `src/`: the game client (`pages/`, `play/`, `ui/`, `net/`, `i18n/` dictionaries); `src/admin/` + `admin.html`: the
  admin SPA.
- `server/`: the backend. `core/` is pure game logic, `db/` SQLite, `routes/` REST, `rooms/` the WebSocket hub.
- `shared/api.ts`: the REST/WS contract shared by client and server.
- `tools/`: the Python pipeline. `g2pipeline.py` renders a world into panoramas and a map, `publish_dataset.py` and
  `check_dataset.py` publish and validate it, `build_assets.sh` (`npm run assets`) extracts the UI assets,
  `render.py` is the original proof of concept.
- `tests/` (Vitest), `e2e/` (Playwright), `dev/` (standalone harness pages for UI modules).
- `deploy/`: nginx templates, systemd units and the deploy scripts.
- `docs/`: notes on fonts, i18n, the panorama viewer and the backlog. The renders and screenshots they mention stay
  local and are git-ignored.

## Legal

Gothic II and all its assets (textures, fonts, maps, worlds, icons) belong to THQ Nordic / Piranha Bytes. This is a
non-commercial fan project that is not affiliated with or endorsed by them. The repository contains no game files and
none of the files built from them: the UI assets and the panorama dataset are produced locally from your own,
legally obtained copy of the game, and are yours to use privately, not to redistribute.

## Author

GoracioNewport

- E-mail: [bdfyljkub@gmail.com](mailto:bdfyljkub@gmail.com)
- Telegram: [t.me/GoracioNewport](https://t.me/GoracioNewport)
- GitHub: [github.com/GoracioNewport](https://github.com/GoracioNewport)
