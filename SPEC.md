# Gothic II Guessr — MVP specification

GeoGuessr-style browser game for Gothic II (Khorinis). Reference: https://lostgamer.io/. This document is the
contract between the data pipeline (`tools/g2pipeline.py`, Python, produces static files) and the frontend
(Vite + TypeScript, static site, no backend). UI language: English.

## 1. Product scope (MVP)

- Single player. One world: **Khorinis** (`NEWWORLD.ZEN`). Architecture must allow more worlds later (one manifest per world).
- Game = **5 rounds**. Each round: a random start node (from `manifest.starts`, no repeats within a game), a 360° panorama,
  free look (drag / wheel zoom), **movement** along the waypoint graph via clickable arrows (Street-View style),
  a **"Return to start"** button, a collapsible **guess map** (bottom-right, expands on hover/click like GeoGuessr),
  a **"Guess"** button enabled once a marker is placed.
- After a guess: result overlay with distance (metres), round score, the map showing guess marker, answer marker and a
  dashed line between them, "Next round" button. After round 5: summary with per-round scores and total, "Play again".
- No accounts, no multiplayer, no timer. Scores are computed client-side.
- Keyboard: Space/Enter = Guess when a marker is placed; R = return to start.
- Should look decent on a 1280×720 laptop window and a 1920×1080 desktop. Mobile is out of scope.

## 2. Static data layout (served by Vite from `public/`)

```
public/data/khorinis/manifest.json
public/data/khorinis/map/{z}/{x}/{y}.webp            # XYZ tiles, 256 px, z = 0..maxZoom, y grows downward (north = top)
public/data/khorinis/panos/{id}/base_{face}.webp      # 512×512 low-res face (6 per node) for instant display
public/data/khorinis/panos/{id}/{face}_{col}_{row}.webp   # 1024×1024 tiles; nbTiles×nbTiles per face (2×2 for faceSize 2048)
```

`face` ∈ `front, right, back, left, top, bottom`. `col`, `row` are 0-based, row 0 = top of the face image.

### manifest.json

```jsonc
{
  "world": "khorinis", "name": "Khorinis", "units": "cm", "eyeHeight": 180,
  "pano": { "faceSize": 2048, "tileSize": 1024, "nbTiles": 2, "baseSize": 512,
            "path": "panos/{id}", "base": "base_{face}.webp", "tile": "{face}_{col}_{row}.webp",
            "faces": ["front","right","back","left","top","bottom"] },
  "map":  { "path": "map/{z}/{x}/{y}.webp", "tileSize": 256, "width": 16384, "height": 12337, "maxZoom": 6,
            "frame": { "x0": -28000, "z0": 50500, "x1": 95500, "z1": -42500 } },
  "scoring": { "maxScore": 5000, "perfectRadiusM": 15, "diagonalM": 1546.3 },
  "nodes": [ { "id": 0, "wp": "NW_CITY_HABOUR_SHIP_01", "x": 1385.1, "y": 46.5, "z": 3172.4, "outdoor": true,
               "links": [ { "to": 7, "yaw": 83.2, "pitch": -1.2, "dist": 6.8 } ] } ],
  "starts": [0, 3, 9]
}
```

- `nodes[i].id === i` (array index). `x, y, z` are **original game coordinates in centimetres**, Y is up.
- `links` are symmetric (if A→B exists, B→A exists). `yaw` is **degrees clockwise from north** (0 = north = +Z,
  90 = east = +X, 180 = south, 270 = west). `pitch` is degrees above the horizon (negative = below). `dist` in metres.
- `starts` is the list of node ids eligible as round starts (outdoor, connected, not a monster spawn).
- `map.frame` maps game coordinates to map pixels at `maxZoom` (full resolution `width × height`):

  ```
  px = (x - frame.x0) / (frame.x1 - frame.x0) * map.width
  py = (frame.z0 - z) / (frame.z0 - frame.z1) * map.height      // north (larger z) is at the top
  ```
  Points outside the frame are allowed (clamp when drawing).

## 3. Cube faces and the viewer

The pipeline renders a cube map per node. **Front face centre = north (+Z of the game)**, right = east, back = south,
left = west. The `top` face is rendered with image-up pointing south (so its bottom edge continues the top edge of the
front face); the `bottom` face is rendered with image-up pointing north. This is the usual "cross" layout; if the
viewer shows seams or a flipped top/bottom, fix it in the viewer configuration (e.g. swap/flip) — **verify visually**
with the sample dataset: the harbour node `NW_CITY_HABOUR_SHIP_01` (id 2045 in the full dataset; node 0 there is an isolated
technical waypoint named `TOT`) has a crane arm directly above the camera and
boats to one side; adjacent faces must line up at the edges without mirror artefacts.

Viewer: **Photo Sphere Viewer 5** (`@photo-sphere-viewer/core`), adapter `@photo-sphere-viewer/cubemap-tiles-adapter`
(`faceSize`, `nbTiles`, `baseUrl: {left, front, right, back, top, bottom}`, `tileUrl(face, col, row)`), plugin
`@photo-sphere-viewer/virtual-tour-plugin` in `dataMode: 'client'` (all nodes known) or `'server'` with `getNode`
(preferred: build node objects lazily from the manifest, the manifest alone is ~3 MB for 3000 nodes).

**Link positions**: convert our `yaw` (degrees clockwise from north, where north is the front-face centre) into the
viewer's yaw convention. In Photo Sphere Viewer `yaw = 0` is the panorama centre (= front face centre), range
`0..2π`; **determine empirically whether positive yaw goes right or left** by loading the harbour sample and checking
that the arrow for a link along the quay points along the quay (compare `dist`/`yaw` of links to what is visible),
then encode the rule in one function `gameYawToViewerYaw(deg)` with a unit test and a comment stating the finding.

Arrows: use the plugin's 3D arrows (`renderMode: '3d'`), `arrowsPosition.minPitch` low enough that links at
`pitch ≈ 0` are visible on the ground (the plugin places arrows below the horizon). Hide the plugin's gallery and
compass. Transition between nodes: short fade, keep the camera direction.

## 4. Guess map

**Leaflet 1.9** with `L.CRS.Simple`, tile layer `data/khorinis/map/{z}/{x}/{y}.webp`, `tileSize: 256`,
`maxNativeZoom: map.maxZoom`, `maxZoom: map.maxZoom + 1`, `noWrap: true`, `bounds` from the image size,
background colour `#2a4d73` (sea). Coordinates: use the standard raster trick: a full-resolution pixel `(px, py)` is
`map.unproject([px, py], map.maxZoom)`; the reverse with `map.project(latlng, map.maxZoom)`. Fit the whole island on
open. Click places/moves the guess marker. Do not show node markers or the waypoint graph on the map.

## 5. Scoring

```
dMetres  = euclidean distance in the X/Z plane between guess and answer, in metres (game units / 100)
score    = dMetres <= perfectRadiusM ? maxScore : round(maxScore * exp(-10 * dMetres / diagonalM))
```
With `diagonalM = 1546` a 155 m miss scores 1835, 50 m scores 3618, 300 m scores 718. Total = sum over 5 rounds (max 25000).
Pure function in `src/game/scoring.ts` with unit tests (vitest).

## 6. Game state

`src/game/state.ts`: a small state machine — `idle → round(n) → result(n) → … → summary`. Round state: `startNodeId`,
`currentNodeId`, `guess: {x, z} | null` (game coordinates), `answer` = start node position, `visited` count.
Picking starts depends on the **game mode** (`classic | mixed | hardcore`, default `mixed`), chosen on the start screen
and carried in the URL as `?mode=…` next to `?seed=…`. `manifest.starts` splits into an outdoor pool (`node.outdoor`)
and an indoor pool (caves, cellars, houses, dense canopy); both are shuffled with a seedable PRNG, then:

- `classic` — the first `count` of the shuffled outdoor pool (the old behaviour);
- `hardcore` — the first `count` of all starts shuffled together;
- `mixed` — per round draw `r = rng()`: `r < 0.35` takes the next unused indoor id, otherwise the next unused outdoor
  id; an exhausted pool falls back to the other one.

Ids never repeat within a game; the result is deterministic for `(seed, mode)`. The summary screen shows
"Game #<seed> · <Mode>" and a replay link with both parameters; "Play again" keeps the mode and draws a new seed.
Persist nothing except an optional `localStorage` best score.

## 7. Project layout

```
package.json  vite.config.ts  tsconfig.json  index.html
src/main.ts              # bootstraps the app, routes screens
src/data/manifest.ts     # types + loader for manifest.json
src/game/scoring.ts      # pure scoring
src/game/state.ts        # state machine + round picking
src/game/graph.ts        # node lookup, link helpers, yaw conversion
src/ui/panorama.ts       # Photo Sphere Viewer wrapper (cubemap tiles + virtual tour), events: node-changed
src/ui/guessmap.ts       # Leaflet wrapper, events: guess-placed
src/ui/screens.ts        # start / round HUD / result / summary DOM
src/style.css
tests/*.test.ts          # vitest
```

Plain TypeScript + DOM, no UI framework. `npm run dev` (Vite, port 5173, strictPort), `npm run build`, `npm test`.
Data path base is configurable (`VITE_DATA_BASE`, default `/data`).

## 8. Definition of done

- `npm run build` and `npm test` pass; `npm run dev` serves the game at http://localhost:5173.
- A full 5-round game can be played in the browser against the real dataset: look around, walk at least 3 nodes,
  return to start, place a guess, see distance/score, finish and see the summary.
- No console errors during a full game. Tiles load progressively (base faces first).
- Arrow directions verified visually at the harbour sample (documented in `docs/VIEWER_NOTES.md`).

## 9. Stage 2: several worlds, difficulty toggles, Gothic look

This section extends sections 1–8; where they conflict, section 9 wins.

### 9.1 Worlds

Three worlds, each with its own dataset in the format of §2: `khorinis` (Khorinis), `valley` (Valley of Mines, `OLDWORLD.ZEN`),
`jharkendar` (Jharkendar, `ADDONWORLD.ZEN`). The index `public/data/worlds.json`:

```jsonc
{ "worlds": [ { "slug": "khorinis", "name": "Khorinis", "description": "…", "manifest": "khorinis/manifest.json", "thumbnail": "khorinis/map/2/0/0.webp" }, … ] }
```

The frontend loads the index, then the manifests of the worlds the player enabled (in parallel). A world whose manifest fails to load
is shown as unavailable on the start screen (greyed, unchecked, with the error) and never used; the game still starts with the others.
Node ids are per world; everywhere in the app a location is `{ world: slug, nodeId }`, a guess is `{ world: slug, x, z }`.

### 9.2 Session settings (start screen)

- **Worlds**: a checkbox per world, all three enabled by default; at least one must stay enabled (Start disabled otherwise).
- **Mode**: classic / mixed / hardcore as in §6 (now applied inside the world chosen for the round).
- **No move**: movement disabled — no arrows, no "Return to start", `R` does nothing; the player only looks around.
- **No look** (requires No move): the camera is frozen at the initial direction and zoom — no drag, wheel, keyboard or touch rotation,
  the zoom control hidden. Enabling No look enables No move; disabling No move disables No look (the No look toggle is disabled while
  No move is off).
- URL carries everything, so a link replays the same game: `?seed=…&mode=…&worlds=khorinis,valley&nomove=1&nolook=1`
  (`worlds` omitted = all three; `nomove`/`nolook` omitted = off). The replay link on the summary includes all of it.

### 9.3 Round picking across worlds

Deterministic for (seed, settings). For each of the 5 rounds the world is drawn uniformly among the enabled worlds (so a 3-world
game has ~1.7 rounds per world on average), then the start inside that world follows the mode rules of §6 with that world's pools,
never repeating a node within a game. If a world has fewer usable starts than needed, fall back to the other worlds.

### 9.4 Guess map with world tabs

The guess map shows tabs (one per enabled world, in the order of worlds.json) above the map; the active tab decides which tile
layer, frame and bounds are shown. Switching tabs keeps each world's own view (zoom/center) and keeps a marker placed on another
world: the guess is the last marker placed, with its world. Default tab = the world of the current round? **No** — that would leak
the answer. The default tab is the first enabled world, and the tab order never depends on the round. The guess button is enabled
once a marker exists on any tab.

### 9.5 Scoring across worlds

- Same world: `distanceM` and `score` as in §5 with that world's `scoring.diagonalM`.
- Wrong world: `score = 0`, `distanceM = null`, and the result overlay says "Wrong world — it was <World name>" instead of a
  distance; its map shows the correct world's tab with the answer marker and, on the guessed world's tab, the guess marker
  (no line). `RoundResult` gets `guessWorld`, `answerWorld`, `distanceM: number | null`.

### 9.6 Gothic look

Assets extracted from the game live in `public/ui/gothic/` (see `index.json` there; produced by `tools/extract_ui_assets.py`):
- Bitmap fonts with metrics: `FONT_OLD_20_WHITE` (32 px tall, the golden "Gothic" display font used for menus), `FONT_OLD_10_WHITE`
  (18 px), `FONT_DEFAULT` (18 px, the in-game text font), `FONT_20_BOOK` / `FONT_10_BOOK` (journal fonts). Each has `<name>.png`
  (RGBA atlas, glyph pixels in the RGB, shape in alpha) and `<name>.json` with per-charcode `{width, u0, v0, u1, v1}` (uv in 0..1,
  v from the top). A vector web font (`public/ui/gothic/fonts/GothicOld.woff2` + `GothicDefault.woff2`) is built from the atlases by
  `tools/build_webfont.py` (potracer + fontTools) so ordinary CSS can use `font-family: "Gothic Old"` for headings/buttons and
  `"Gothic Default"` for text. If a glyph is missing in the game font (Cyrillic etc.) the CSS falls back to a serif.
- Panels and controls: `MENU_INGAME.png` (dark translucent panel with a golden frame — the in-game menu background),
  `MENU_CHOICE_BACK.png`, `MENU_BUTTONBACK.png`, `MENU_INPUT_BACK.png`, `MENU_SLIDER_BACK.png`/`MENU_SLIDER_POS.png`,
  `MENU_GOTHIC.png` (the Gothic logo), `LOG_PAPER.png`/`LOG_BACK.png` (journal), `BOOK_*_L/R.png` (book pages),
  `BAR_BACK.png` + `BAR_HEALTH.png`/`BAR_MANA.png`/`BAR_MISC.png` (the HUD bars: use for the score bar), `INV_SLOT*.png`
  (inventory slots: use for toggles/checkboxes), `DLG_*.png` (dialogue box backgrounds), `MAP_*.png` (the painted in-game maps:
  use as world thumbnails on the start screen).
- Direction: the in-game menu of Gothic II — dark panels with golden frames, golden uncial headings, text in the game font,
  selected items highlighted like the menu does (brighter gold), the HUD bars for score. Use 9-slice `border-image` for frames and
  `image-rendering: pixelated` only where the asset is meant to be crisp pixels. Keep layout and behaviour of §1 and 9.2; this is a
  re-skin plus the new controls, not a new layout. Readability first: the game font for headings, buttons, labels and numbers;
  longer explanatory text may use `"Gothic Default"` or the serif fallback at a comfortable size.

### 9.7 Definition of done (stage 2)

- Build/tests pass. A game with all three worlds, Mixed, No move + No look plays through in the browser: no arrows, camera frozen,
  world tabs on the map, a wrong-world guess scores 0 with the explanatory result, the summary shows per-round world names and the
  replay link reproduces the game. The Gothic font renders in headings and buttons (checked visually), panels use the game frames.

## 10. Stage 3: backend, multiplayer, leaderboards, languages, admin

This section extends sections 1–9; where they conflict, section 10 wins. Decisions agreed with the owner on 2026-10-07.
Everything runs locally until hosting is chosen; the design must stay deployable to a single free VM (Node) and portable to
Cloudflare Workers/Durable Objects later, so pure game logic never imports `node:*`.

### 10.1 Product decisions

- **Identity**: no registration. The first API call creates an anonymous player: a random device token kept in
  `localStorage` (`gothic2guessr.token`) plus a nickname. Default nickname `Wanderer####`; the player edits it in the main
  menu. Nicknames are not unique. A dictionary filter (EN/DE/PL/RU, §10.9) rejects offensive names.
- **The server owns the answers.** Clients never receive node coordinates, waypoint names, world of a panorama before the
  guess, seeds, or the graph beyond what they walk. Every mode, including solo, goes through the API. Round score and
  distance are computed on the server. (Reverse engineering by walking the graph and comparing pictures stays possible,
  as on lostgamer; we only make it slow: per-game reach checks and rate limits.)
- **Timer**: points come only from accuracy (§5, §9.5). Rounds may have a time limit; total guessing time breaks ties
  (lower is better). When the time runs out, a marker the player has placed counts as the guess (the client sends it
  just before the deadline, GeoGuessr behaviour); a round that times out without a marker scores 0.
- **Modes**:
  - *Solo*: the stage-2 start screen settings (worlds, mode, No move, No look) plus a round time limit
    (off / 30 s / 60 s / 2 min / 5 min, default off). The seed field disappears from the UI (seeds are server secrets);
    every solo game is also a **challenge** with a share link (§10.4).
  - *Daily*: one game per UTC day, the same 5 rounds for everyone, one attempt per player. Default settings: all worlds,
    Mixed, movement on, 2 min per round. The admin may override a day's settings. One daily leaderboard per day, previous
    days browsable. Result sharing in Wordle style (§10.5).
  - *Challenge link*: "play my game": the same rounds and settings, one attempt per player, a leaderboard of everyone who
    played that link. Created for every solo game and every finished room game (so a room's leaderboard can be extended
    to friends who were not in the room).
  - *Party room* (real time, up to 16 players, join by code/link, no joining after the start, no spectators):
    host chooses settings and 3/5/10 rounds, time limit (default 2 min); everyone plays the same rounds simultaneously;
    a round ends when every connected player guessed or the time is up (the host may end it early: everyone still
    guessing gets 5 s, placed markers count); then everyone's guesses on the map and a round table; final standings; "Let friends play these rounds" = the room's challenge link.
  - *Duel* (room with exactly 2 players): GeoGuessr-style health. Both start with 6000 HP. Each round the lower round score
    loses `(higher − lower) × multiplier` HP; multiplier ×1 for rounds 1–3, then +0.5 per round (r4 ×1.5, r5 ×2, …).
    Once the first player guesses, the other has 15 s (or the remaining round time if shorter). Base round limit
    default off with a hard cap of 5 min. Rounds continue until someone reaches 0 HP; after round 30 the higher HP wins
    (equal HP = draw). A player disconnected for more than 60 s during a duel forfeits.
- **Languages**: English, German, Polish, Russian; selector in the main menu; default = first of `navigator.languages`
  whose primary subtag is supported, else English; stored in `localStorage` (`gothic2guessr.lang`). The admin UI is
  English only.
- **Admin**: site statistics (page views, unique visitors, players, games by kind, rooms, daily participation, live
  online/rooms), daily management (override settings, hide/delete leaderboard entries), player moderation (ban, reset
  nickname), active rooms (close), nickname blocklist, audit log.
- **No** monetization, currency, ranks, matchmaking with strangers, spectators. Deferred ideas: `docs/BACKLOG.md`.

### 10.2 Architecture and repository layout

```
server/                    # Node backend (TypeScript; dev: tsx; prod: esbuild bundle dist-server/main.js, `npm start`)
  main.ts                  # entry: loads env (.env.local), opens DB, loads worlds, starts HTTP + WS on PORT (8787)
  app.ts                   # Hono app: mounts route modules; also serves dist/ and DATA_DIR in production
  config.ts                # env: PORT, DATA_DIR, SERVER_DATA_DIR, ADMIN_PASSWORD, ADMIN_PATH, SERVER_SECRET, DEV
  core/                    # PURE logic, no node:* imports, no I/O: game service rules, daily settings, challenge
                           #   codes, scoring glue, party + duel state machines, profanity filter, rate-limit math
  db/                      # storage: schema/migrations + repository implementation (better-sqlite3), behind an
                           #   async Repository interface declared in core/ so a D1 implementation can replace it
  routes/                  # one module per area: players.ts, games.ts, challenges.ts, daily.ts, rooms.ts, hits.ts, admin.ts
  rooms/                   # WebSocket hub: connections, room registry, timers → core state machines
shared/api.ts              # THE contract: every REST payload and WS message type (client + server import it)
src/                       # client (existing) — now API-driven; src/i18n/ dictionaries; src/net/ api + ws client
admin.html, src/admin/     # admin SPA (second Vite entry), plain DOM like the game
server-data/               # git-ignored: <slug>/manifest.json (PRIVATE full manifests with node keys), db.sqlite
public/data/               # git-ignored, public: worlds.json, <slug>/world.json, <slug>/map/…, panos/<key>/…
tests/                     # vitest: existing client tests + tests/server/** (unit + HTTP/WS integration)
e2e/                       # Playwright: full flows against the real dataset (solo, daily, challenge, party, duel, admin)
```

- HTTP: Hono (`@hono/node-server`), WebSocket: `ws` on the same HTTP server at path `/ws`. JSON everywhere.
- The server reuses the pure client modules `src/game/state.ts` (rng, `pickRounds`), `src/game/scoring.ts`,
  `src/game/graph.ts` (tsx resolves the extensionless imports). Round picking stays exactly as in §6/§9.3, but runs only
  on the server.
- Dev: `npm run dev` starts Vite (5173) and the API (8787, `tsx watch`) together; Vite proxies `/api` and `/ws` (ws: true)
  to 8787. `npm run dev:server` / `npm run dev:client` run one side. `npm run setup` creates `.env.local` (git-ignored)
  with a random `ADMIN_PASSWORD`, `ADMIN_PATH` and `SERVER_SECRET` if missing, never printing them.
- Prod (single machine): `npm run build && npm start` → one Node process on `PORT` serving the SPA (`dist/`, with
  history fallback to `index.html` / `admin.html` for `/<ADMIN_PATH>*`), `/data/*` from `DATA_DIR` (default `public/data`,
  immutable cache headers for `panos/` and `map/`), `/api/*` and `/ws`.
  `npm run build` also runs `build:server` (esbuild: server/main.ts and the shared/client modules it imports → one
  ESM file, npm packages external), so production needs only `npm ci --omit=dev` and plain `node`. The deploy kit in
  `deploy/` (see deploy/README.md) puts nginx in front: `/data`, `/assets`, `/ui` from disk, the rest to Node on
  127.0.0.1 with `TRUST_PROXY=1`.
- Client routes (History API): `/` main menu, `/play` solo setup, `/daily`, `/c/<code>` challenge, `/r/<CODE>` room,
  `/<ADMIN_PATH>` admin (§10.10). `?seed=` links of stage 2 are ignored.

### 10.3 Data split (public vs private)

`tools/publish_dataset.py` (idempotent) turns the pipeline output into:

- `server-data/<slug>/manifest.json`: the full manifest of §2 plus `nodes[i].key`, a random 12-char lowercase base32
  key. Keys are stable per waypoint name: on re-publish, nodes keep the key of the same `wp` from the previous private
  manifest (new waypoints get new keys).
- `public/data/<slug>/world.json`: `{ world, name, map, scoring, pano }` — no `nodes`, no `starts`; `pano.path` is
  `panos/{key}` relative to the **data base** (not the world dir).
- `public/data/panos/<key>/…`: pano folders moved (rename, same filesystem) from `public/data/<slug>/panos/<id>/`.
  One flat directory for all worlds so the URL does not reveal the world.
- `public/data/worlds.json`: as §9.1 but `manifest` → `world` (`khorinis/world.json`).
- No full manifest may remain anywhere under `public/` (a test asserts it).

### 10.4 REST API (all under `/api`, JSON; types in `shared/api.ts`)

Auth: `Authorization: Bearer <token>` on every player call. Unknown/missing token on a call that needs a player → 401
`{error:'auth'}`; the client then calls `POST /api/players` and retries once. Errors are `{error: <code>, message?}` with
codes the client localizes (`auth`, `not_found`, `forbidden`, `banned`, `rate_limited`, `nickname_rejected`,
`already_played`, `room_full`, `room_started`, `bad_request`, `round_over`, `conflict`).

Players: `POST /players` → `{token, player}`; `GET /me`; `PATCH /me {nickname}`.

Games (one engine for solo, daily, challenge and room games; a game belongs to exactly one challenge):
- `POST /games {kind:'solo', settings}` → new challenge (kind `solo`, random secret seed) + the caller's game.
  `POST /games {kind:'challenge', code}` / `{kind:'daily'}` → the caller's game for that challenge; one per player:
  if it exists, unfinished → returned (resume), finished → 409 `already_played`.
- `GET /games/:id` → `GameView` (resume after reload: current round, current node, results so far).
- `POST /games/:id/rounds` → starts the next round, stamps the server start time, returns `RoundView` with the start
  `PanoNode` and `deadline` (epoch ms or null). Calling it while a round is open returns that round (idempotent).
- `GET /games/:id/nodes/:key` → `PanoNode {key, links:[{key, yaw, pitch}]}` (no `dist`, no coordinates) only if the key
  is the round start, or was returned before in this round, or is a link of such a node; else 404. 10 req/s per game.
- `POST /games/:id/guess {guess: {world,x,z} | null}` → `RoundResultView` (answer coordinates and world, distance,
  score, time). `null` = gave up / timer expired on the client. After the deadline (+2 s grace) the server ignores the
  guess and records a timeout (score 0). Room games: also notifies the room (§10.6).
- `GET /games/:id/summary` → `GameSummaryView` once finished.

Challenges & leaderboards:
- `GET /challenges/:code` → `ChallengeView {code, kind, settings (no seed), rounds, createdBy nickname, createdAt,
  players count, myGame: {id, finished, total} | null, date (daily)}`.
- `GET /challenges/:code/leaderboard?limit=50` → `{entries: [{rank, playerId, nickname, total, timeMs, rounds:[score…],
  me}], me: entry | null}` — finished games only, banned players and hidden entries excluded, order total desc, timeMs
  asc, finishedAt asc.
- `GET /daily` → today's `ChallengeView` (creates the day's challenge lazily); `GET /daily/:date` (YYYY-MM-DD, past days
  only and today).

Analytics: `POST /hits {path, referrer, visitor}` → 204. `visitor` is a random id in `localStorage`
(`gothic2guessr.visitor`), not the token. Sent on every client route change and on `/<ADMIN_PATH>` loads (flagged
admin).

### 10.5 Daily details

- Day = UTC date. The day's seed is `HMAC(SERVER_SECRET, 'daily:' + date)` truncated to 32 bits; settings = admin override
  for that date or the defaults of §10.1.
- Share text (copy button on the summary and on the daily page after playing):
  `Gothic II Guessr — Daily 2026-10-07\n18 450 / 25 000\n🟩🟩🟨🟥⬛\n<origin>/daily`; per round 🟩 ≥ 4000, 🟨 ≥ 2000,
  🟧 ≥ 500, 🟥 < 500, ⬛ wrong world or timeout. No coordinates or place names in it.
- The daily page shows today's leaderboard (top 50 + your row), your result if played, a Play button if not, and a
  date picker for past days. Answers of a day are never revealed by the leaderboard.

### 10.6 Rooms (party and duel) — WebSocket protocol

- `POST /api/rooms {type:'party'|'duel', settings}` → `{code}` (5 letters, unambiguous alphabet); creator = host.
  `GET /api/rooms/:code` → `RoomView` (404 when unknown/expired). Rooms live in memory (the registry), are persisted only
  as a challenge + games when they start, and expire 30 min after the last activity.
- One socket per tab: `ws://…/ws?token=<token>`. Client → server: `join {code}`, `leave`, `settings {settings, rounds,
  type}` (host, lobby only), `kick {playerId}` (host), `start` (host), `next` (host, party result phase), `endRound`
  (host, party round: deadline → now + 5 s, never later, sent as `countdown`), `ping`.
  Server → client: `room {room: RoomView}` (full state after any lobby change), `kicked`, `started {gameId,
  challengeCode}`, `round {n, node: PanoNode, deadline, duel?: {hp, multiplier}}`, `guessed {playerId}`,
  `countdown {deadline}` (duel), `roundResult {n, answer, results:[{playerId, guess, distanceM, score, timeMs}],
  duel?: {hp, damage, multiplier}}`, `gameOver {standings, winner?, challengeCode, reason?}` (`reason`: `rounds` party,
  `ko` / `cap` / `forfeit` duel), `error {error}`, `pong`.
- Movement and guesses go through REST with the player's own `gameId` (each player has a game row in the room's
  challenge); the room module listens to guesses in-process. Round start for all players is driven by the room: the
  server opens round n of every player's game at the same instant and pushes `round`.
- Party: max 16, host may start with ≥ 1 player. After a round result, auto-advance after 15 s or host `next`. A player
  who disconnects stays in the standings and scores 0 for the rounds they miss; they can reconnect (same token) to an
  ongoing game they belonged to. Host leaves → host passes to the earliest remaining player.
- Duel: exactly 2 players to start; the rules of §10.1; disconnect > 60 s = forfeit.
- After `gameOver` the room returns to the lobby (same code, same players) so the host can start again.
- Leaving: `leave` during a party game keeps the player in the standings (0 for the rounds left; the room link
  resumes the game); during a duel it forfeits at once (the client asks first).
- Rooms live in memory: on start the server finishes room challenges a previous process left `running` (open rounds
  → timeouts, link opens with the rounds that were opened). One that never opened a round stays closed; its
  `ChallengeView.unavailable` is `abandoned` (`running` while a live room still plays it).

### 10.7 Client

- Main menu (replaces the start screen as the first screen, Gothic look of §9.6): logo, nickname (edit inline), language
  selector, buttons **Play** (→ solo setup: stage-2 controls + time limit), **Daily challenge** (today's status: your
  score or "not played"), **Play with friends** (create party / create duel / join by code), how-to-play.
- Round screen as in stage 2, plus a countdown when the round has a deadline, the HP bars and multiplier in a duel
  (`BAR_HEALTH`), "X guessed" ticks in rooms. The panorama gets its nodes from `GET /games/:id/nodes/:key` (virtual tour
  server mode, async `getNode`), tiles from `/data/panos/<key>/…`. The guess map uses `world.json` (no nodes).
- Result screen in rooms shows every player's marker (colour per player, nickname tooltip) and the round table.
- Summary: total, per-round results, share/copy buttons (challenge link; daily share text), the challenge leaderboard
  with the player's row highlighted, "Play again" (new solo game with the same settings).
- Reload safety: a running solo/daily/challenge game resumes from `GET /games/:id` (id kept in `sessionStorage`); a room
  page reconnects to its room.

### 10.8 Internationalisation

- `src/i18n/{en,de,pl,ru}.ts`: flat key → string dictionaries, `en` is the source of the key type (missing keys are a type
  error), `{name}` placeholders, plurals via `Intl.PluralRules`, numbers/dates via `Intl` with the active locale.
  `t(key, params?)`, `setLanguage(lang)` re-renders the current screen.
- Localized world names: Khorinis — Khorinis / Khorinis / Khorinis / Хоринис; Valley of Mines — Minental / Górnicza
  Dolina / Долина Рудников; Jharkendar — Jharkendar / Jarkendar / Яркендар (check the official localizations on the
  wikis; prefer the names used by the official German, Polish and Russian releases).
- Fonts: `pl` and `ru` use the original Polish and Russian Gothic II fonts (Gothic Old/Default PL and RU, built from
  the localized Steam depots, see docs/FONTS.md); characters those atlases lack (… · and a few symbols) fall back per
  character to the English game font, then Alegreya (`@fontsource`). `<html lang>` follows the language.
- Server error codes and room/duel events are localized on the client; the server never sends human text.

### 10.9 Moderation, security, privacy

- Nickname: 2–20 chars, letters (any script), digits, space, `_-.`; trimmed, inner spaces collapsed. Filter: lowercase,
  map leetspeak (`0→o 1→i 3→e 4→a 5→s 7→t @→a $→s`) and Latin/Cyrillic homoglyphs, drop separators, then substring-match
  word roots from built-in EN/DE/PL/RU lists plus the admin blocklist.
- Rate limits (in memory, per IP and per token): player creation 10/h per IP, node lookups 10/s per game, guesses 2/s,
  hits 60/min, admin login 5/15 min per IP. IPs are never stored in the DB.
- Admin auth: `POST /api/<ADMIN_PATH>/login {password}` compared in constant time with `ADMIN_PASSWORD`; success sets
  an `HttpOnly; SameSite=Strict` signed session cookie (12 h, `Path=/api/<ADMIN_PATH>`). All `/api/<ADMIN_PATH>/*`
  require it. Every admin write goes to the audit log.
- Banned players: excluded from leaderboards, cannot create or join rooms (`banned`); can still play solo.

### 10.10 Admin (`/<ADMIN_PATH>`)

- Location: `ADMIN_PATH` (server env, `[A-Za-z0-9_-]{4,64}`, not one of the app's own first path segments). Dev and
  tests default to `admin`; production refuses to start without it or with `admin`, so the admin is not found by
  guessing (`npm run setup` and `deploy/scripts/secrets.sh` write `admin-` + 16 random base32 chars). The UI is served
  at `/<ADMIN_PATH>` and below, the shell gets the path injected (`<meta name="g2-admin-path">`, only in admin.html), and
  the API is `/api/<ADMIN_PATH>/*`. `/admin`, `/admin.html` and `/api/admin/*` answer 404 whenever the path differs.

- Dashboard: date range (default 30 days), per day page views, unique visitors, new players, games started/finished by
  kind (solo, daily, challenge, party, duel), rooms created, daily participants; totals; top referrer hosts and paths;
  live now: open sockets, active rooms and games in progress. Simple inline SVG charts (no chart library needed).
- Daily: calendar list (date, settings, players, best score); edit settings for a date (future dates freely; a date
  with plays needs an explicit "force" since results become incomparable); leaderboard with hide/unhide/delete per entry.
- Players: search by nickname/id, view their games, ban/unban, reset nickname.
- Challenges: look up by code, leaderboard moderation as for daily.
- Rooms: active rooms with players and phase; close a room (players get `error {error:'room_closed'}`).
- Blocklist: add/remove words. Audit log: newest first.
- Admin API under `/api/<ADMIN_PATH>/*` (types in `shared/api.ts`).

### 10.11 Definition of done (stage 3)

- `npm test` (client + server unit/integration) and `npm run build` pass; `npm run e2e` (Playwright, real dataset,
  `npm run dev` stack) passes: solo game with movement and a timed round; daily played once (second attempt refused) with
  share text; challenge link played by a second player and both on its leaderboard; party with 3 browser contexts
  (one disconnects and returns); a duel to KO; admin login, stats show the games just played, a daily override, a ban
  removes the player from the leaderboard.
- No coordinates, waypoint names, seeds or private manifests reachable from the client (automated check: crawl every
  `/data` and `/api` response of an e2e run for `"wp"`, `"x":`-style node coordinates before a guess, `seed`).
- All four languages render on every screen without missing keys or overflow at 1280×720; RU/PL use the fallback font.
