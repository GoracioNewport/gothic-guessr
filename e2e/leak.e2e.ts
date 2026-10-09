/**
 * Leak check (SPEC §10.1 "the server owns the answers", §10.3, §10.11), run after every other project:
 *
 * 1. Probes: the private manifests (server-data/, the pipeline's out/), the database and `.env.local` are not
 *    reachable through the Vite dev server or the API, by plain paths, `/@fs/`, Vite query suffixes or path
 *    traversal on `/data`; no `manifest.json` under `/data`. The reach check refuses nodes the player has not walked
 *    to, and No move hides the links.
 * 2. Crawl: every `/api` and `/data` response body and every WebSocket frame recorded during the run (all players of
 *    all flows) contains no `wp` key and no waypoint name, nothing named like a seed, no `nodes`/`starts`, no node
 *    coordinates except a revealed answer or a guess, and an answer is never sent to a player before that player's
 *    own reveal (the guess response or the room's `roundResult`). `/api/<ADMIN_PATH>/*` is excluded: admin payloads
 *    may hold private data (shared/api.ts).
 * 3. The admin path (the run's random E2E_ADMIN_PATH) is secret: `/admin`, `/admin.html` and `/api/admin/*` do not
 *    lead to the admin, the game shell and every recorded player body never mention the path.
 */
import { request as httpRequest } from 'node:http';
import type { GameView, PanoNode, RoundView } from '../shared/api';
import type { RecordEntry } from './fixtures';
import { ROOT, WORLDS, expect, privateNodes, readAllRecords, test } from './fixtures';

const VITE_PORT = Number(process.env.E2E_PORT ?? 6173);
const ADMIN_PATH = process.env.E2E_ADMIN_PATH ?? '';
const API_PORT = Number(process.env.E2E_API_PORT ?? 9787);

/** GET a raw (not normalised) path. */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: 'localhost', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('latin1') }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout ${path}`)));
    req.end();
  });
}

/** What a private file looks like: a full manifest, the publish log, the SQLite file or the secrets. */
function privateSignature(body: string): string | null {
  if (/"wp"\s*:/.test(body)) return 'waypoint names';
  if (/"starts"\s*:/.test(body)) return 'start list';
  if (/"key"\s*:\s*"[a-z2-7]{12}"\s*,\s*"wp"/.test(body)) return 'node keys';
  if (/"batches"\s*:/.test(body) && /"moves"\s*:/.test(body)) return 'pano_moves.json';
  if (body.startsWith('SQLite format')) return 'SQLite database';
  if (/ADMIN_PASSWORD|SERVER_SECRET/.test(body)) return '.env.local';
  return null;
}

test('private data is not reachable over HTTP', async () => {
  const paths: string[] = ['/.env.local', '/server-data/db.sqlite', '/.env.local?raw', `/@fs${ROOT}/.env.local`];
  for (const slug of WORLDS) {
    const files = [`server-data/${slug}/manifest.json`, `server-data/${slug}/pano_moves.json`, `out/${slug}_meta/manifest.json`, `out/${slug}/manifest.json`];
    paths.push(`/data/${slug}/manifest.json`, `/data/${slug}/MANIFEST.JSON`, `/data/${slug}/manifest.json?raw`);
    for (const f of files) {
      paths.push(
        `/${f}`,
        `/${f}?raw`,
        `/${f}?import`,
        `/${f}?url`,
        `/${f}?inline`,
        `/@fs${ROOT}/${f}`,
        `/@fs${ROOT}/${f}?raw`,
        `/data/../${f}`,
        `/data/%2e%2e/${f}`,
        `/data/%2E%2E/${f}`,
        `/data/..%2f${f}`,
        `/data/%2e%2e%2f${f}`,
        `/data/..%5c${f}`,
        `/data/panos/../../${f}`,
        `/data/panos/%2e%2e/%2e%2e/${f}`,
        `/data/%252e%252e/${f}`,
        `/data//../${f}`,
        `/api/../${f}`,
        `/api/%2e%2e/${f}`,
      );
    }
  }
  const leaks: string[] = [];
  for (const port of [VITE_PORT, API_PORT]) {
    for (const path of paths) {
      const res = await rawGet(port, path);
      const sig = privateSignature(res.body);
      if (sig) leaks.push(`:${port}${path} → ${res.status} (${sig})`);
    }
  }
  expect(leaks).toEqual([]);

  // The public files are there and hold nothing private.
  for (const slug of WORLDS) {
    const res = await rawGet(VITE_PORT, `/data/${slug}/world.json`);
    expect(res.status).toBe(200);
    expect(Object.keys(JSON.parse(res.body) as object).sort()).toEqual(['map', 'name', 'pano', 'scoring', 'world']);
  }
});

test('the admin path is secret: not at /admin, not in the game shell, not in any player response', async () => {
  expect(ADMIN_PATH).toMatch(/^[A-Za-z0-9_-]{4,64}$/);
  expect(ADMIN_PATH).not.toBe('admin');
  // The admin shell answers only under its path, with the path filled in.
  const shell = await rawGet(VITE_PORT, `/${ADMIN_PATH}/players`);
  expect(shell.status).toBe(200);
  expect(shell.body).toContain(`<meta name="g2-admin-path" content="${ADMIN_PATH}"`);
  // The well-known locations lead nowhere: no admin shell, no admin API.
  for (const path of ['/admin', '/admin/', '/admin/players']) {
    const res = await rawGet(VITE_PORT, path);
    expect(res.body, path).not.toContain('g2-admin-path');
  }
  expect((await rawGet(VITE_PORT, '/admin.html')).status).toBe(404);
  for (const port of [VITE_PORT, API_PORT]) {
    for (const path of ['/api/admin/session', '/api/admin/stats', '/api/admin/login']) {
      expect((await rawGet(port, path)).status, `:${port}${path}`).toBe(404);
    }
    expect((await rawGet(port, `/api/${ADMIN_PATH}/session`)).status).toBe(401);
  }
  // The game shell and the public config never carry it.
  for (const path of ['/', '/play', '/daily', '/api/config']) {
    expect((await rawGet(VITE_PORT, path)).body, path).not.toContain(ADMIN_PATH);
  }
  const mentions = readAllRecords()
    .filter((r) => !r.url.startsWith(`/api/${ADMIN_PATH}`) && r.body?.includes(ADMIN_PATH))
    .map((r) => `${r.player} ${r.kind} ${r.url}`);
  expect(mentions).toEqual([]);
});

test('reach check and No move', async ({ players }) => {
  const p = await players.create({ name: 'leak-reach' });
  await p.page.goto('/');
  const settings = { mode: 'mixed', worlds: [...WORLDS], noMove: false, noLook: false, timeLimit: 0, rounds: 5 };
  const game = (await p.api<GameView>('POST', '/games', { kind: 'solo', settings })).body;
  const round = (await p.api<RoundView>('POST', `/games/${game.id}/rounds`)).body;
  const start = round.start;
  expect(Object.keys(start).sort()).toEqual(['key', 'links']);
  // A link of the start is served; a random other node of any world is not.
  if (start.links[0]) expect((await p.api('GET', `/games/${game.id}/nodes/${start.links[0].key}`)).status).toBe(200);
  const reachable = new Set([start.key, ...start.links.map((l) => l.key)]);
  const others = [...privateNodes().keys()].filter((k) => !reachable.has(k)).slice(0, 5);
  for (const key of others) expect((await p.api('GET', `/games/${game.id}/nodes/${key}`)).status).toBe(404);
  // Someone else's game is not readable.
  const q = await players.create({ name: 'leak-other' });
  await q.page.goto('/');
  expect((await q.api('GET', `/games/${game.id}`)).status).toBe(404);
  expect((await q.api('GET', `/games/${game.id}/nodes/${start.key}`)).status).toBe(404);

  // No move: only the start node, without links.
  const still = (await p.api<GameView>('POST', '/games', { kind: 'solo', settings: { ...settings, noMove: true } })).body;
  const r = (await p.api<RoundView>('POST', `/games/${still.id}/rounds`)).body;
  expect(r.start.links).toEqual([]);
  const node = await p.api<PanoNode>('GET', `/games/${still.id}/nodes/${r.start.key}`);
  expect(node.body.links).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------------------------

interface Located {
  path: string;
  value: unknown;
}

/** Every object/value in a JSON tree with its dotted path. */
function* walk(value: unknown, path = '$'): Generator<Located> {
  yield { path, value };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walk(value[i], `${path}[${i}]`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* walk(v, `${path}.${k}`);
  }
}

const isCoords = (v: unknown): v is { x: number; z: number } =>
  !!v && typeof v === 'object' && typeof (v as { x?: unknown }).x === 'number' && typeof (v as { z?: unknown }).z === 'number';

const lastKey = (path: string): string => path.replace(/\[\d+\]$/, '').split('.').pop() ?? '';

/** Records that reveal answers to their player: the own guess response and the room's round result. */
function isReveal(r: RecordEntry, json: unknown): boolean {
  if (r.kind === 'http') return r.method === 'POST' && /^\/api\/games\/[^/]+\/guess$/.test(r.url);
  return r.kind === 'ws-in' && !!json && typeof json === 'object' && (json as { t?: string }).t === 'roundResult';
}

test('recorded /api, /data and WebSocket bodies leak nothing', async () => {
  const records = readAllRecords();
  expect(records.length, 'records of the run').toBeGreaterThan(200);
  expect(records.some((r) => /\/api\/games\/[^/]+\/nodes\//.test(r.url))).toBe(true);
  expect(records.some((r) => r.url.startsWith('/data/panos/'))).toBe(true);
  expect(records.some((r) => r.kind === 'ws-in')).toBe(true);
  expect(records.some((r) => /\/guess$/.test(r.url))).toBe(true);

  const wpNames = [...new Set([...privateNodes().values()].map((n) => n.wp).filter((w) => w.length >= 8 && w.includes('_')))];
  const problems: string[] = [];
  const byPlayer = new Map<string, RecordEntry[]>();
  for (const r of records) {
    if (r.kind === 'ws-out') continue;
    if (r.url === `/api/${ADMIN_PATH}` || r.url.startsWith(`/api/${ADMIN_PATH}/`)) continue;
    const list = byPlayer.get(r.player) ?? [];
    list.push(r);
    byPlayer.set(r.player, list);
  }

  let checked = 0;
  for (const [player, list] of byPlayer) {
    list.sort((a, b) => a.seq - b.seq);
    const revealed = new Set<string>();
    for (const r of list) {
      if (r.body === null || r.body === '') continue;
      const where = `${player} ${r.kind} ${r.method ?? ''} ${r.url}`;
      if (/"wp"\s*:/.test(r.body)) problems.push(`${where}: "wp" key`);
      if (/seed/i.test(r.body)) problems.push(`${where}: "seed"`);
      for (const name of wpNames) {
        if (r.body.includes(name)) {
          problems.push(`${where}: waypoint name ${name}`);
          break;
        }
      }
      let json: unknown;
      try {
        json = JSON.parse(r.body);
      } catch {
        continue; // tiles, HTML of a missing file, plain text
      }
      checked++;
      const reveal = isReveal(r, json);
      const answersHere: string[] = [];
      for (const { path, value } of walk(json)) {
        const key = lastKey(path);
        if (key === 'nodes' || key === 'starts') problems.push(`${where}: ${path}`);
        if (isCoords(value)) {
          if (key !== 'answer' && key !== 'guess') problems.push(`${where}: coordinates at ${path}`);
          if (key === 'answer') answersHere.push(`${value.x},${value.z}`);
        }
        // A node as the player sees it: key + links only.
        if (value && typeof value === 'object' && !Array.isArray(value) && 'links' in value) {
          const keys = Object.keys(value).sort().join(',');
          if (keys !== 'key,links') problems.push(`${where}: node object at ${path} has ${keys}`);
        }
      }
      for (const a of answersHere) {
        if (!reveal && !revealed.has(a)) problems.push(`${where}: answer ${a} before the player's reveal`);
      }
      if (reveal) for (const a of answersHere) revealed.add(a);
    }
  }
  console.log(`leak crawl: ${records.length} records of ${byPlayer.size} players, ${checked} JSON bodies checked, ${problems.length} problems`);
  expect(checked, 'JSON bodies checked').toBeGreaterThan(100);
  expect(problems).toEqual([]);
});
