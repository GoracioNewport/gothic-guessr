/**
 * Real HTTP server on port 0 (production mode: static dist/ + /data), the disk world loader, config, setup, migrations.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameView, RoundView } from '../../shared/api';
import { createApp } from '../../server/app';
import { loadConfig, parseAdminPath, parseEnvFile } from '../../server/config';
import { migrate, openDatabase } from '../../server/db/database';
import { SCHEMA_VERSION } from '../../server/db/schema';
import { SqliteRepository } from '../../server/db/repository';
import { createServices } from '../../server/services';
import { ensureEnvLocal } from '../../server/setup';
import { loadWorldRegistry } from '../../server/worlds';
import { fixtureManifest, writeFixtureDataset } from './fixtures/world';
import { testConfig } from './helpers';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'g2-server-test-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('world loader', () => {
  it('loads private manifests in worlds.json order and skips broken worlds', () => {
    const data = join(tmp, 'loader/data');
    const priv = join(tmp, 'loader/server-data');
    const beta = fixtureManifest('beta', 3, 3);
    const alpha = fixtureManifest('alpha', 2, 2);
    writeFixtureDataset(data, priv, [beta, alpha]);
    // A third world in the index without a private manifest, a fourth without keys.
    const index = JSON.parse(readFileSync(join(data, 'worlds.json'), 'utf8')) as { worlds: unknown[] };
    index.worlds.push({ slug: 'gamma', name: 'Gamma' }, { slug: 'delta', name: 'Delta' });
    writeFileSync(join(data, 'worlds.json'), JSON.stringify(index));
    const delta = fixtureManifest('delta', 2, 2) as unknown as { nodes: { key?: string }[] };
    for (const n of delta.nodes) delete n.key;
    mkdirSync(join(priv, 'delta'), { recursive: true });
    writeFileSync(join(priv, 'delta/manifest.json'), JSON.stringify(delta));

    const { worlds, skipped } = loadWorldRegistry(data, priv);
    expect([...worlds.keys()]).toEqual(['beta', 'alpha']);
    expect(worlds.get('alpha')!.idByKey.get('alpha0003')).toBe(3);
    expect(skipped.map((s) => s.slug)).toEqual(['gamma', 'delta']);
    expect(skipped[1]!.error).toMatch(/key/);
  });

  it('discovers worlds from SERVER_DATA_DIR when worlds.json is missing', () => {
    const priv = join(tmp, 'discover/server-data');
    writeFixtureDataset(join(tmp, 'discover/unused'), priv, [fixtureManifest('zeta', 2, 2), fixtureManifest('eta', 2, 2)]);
    const { worlds } = loadWorldRegistry(join(tmp, 'discover/no-data-here'), priv);
    expect([...worlds.keys()]).toEqual(['eta', 'zeta']);
  });
});

describe('config and setup', () => {
  it('parses env files', () => {
    expect(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x#y\'\nD=v # comment\nbad line\n')).toEqual({
      A: '1',
      B: 'two words',
      C: 'x#y',
      D: 'v',
    });
  });

  it('requires the secrets and resolves paths/ports', () => {
    expect(() => loadConfig({}, '/r')).toThrow(/ADMIN_PASSWORD/);
    const env = { ADMIN_PASSWORD: 'a'.repeat(12), SERVER_SECRET: 'b'.repeat(32) };
    const dev = loadConfig({ ...env, API_PORT: '9999', PORT: '1111' }, '/r');
    expect(dev).toMatchObject({ dev: true, port: 9999, host: 'localhost', dataDir: '/r/public/data', dbPath: '/r/server-data/db.sqlite' });
    const prod = loadConfig({ ...env, NODE_ENV: 'production', ADMIN_PATH: 'ops-Panel_42', API_PORT: '9999', PORT: '1111', DATA_DIR: '/abs/data' }, '/r');
    expect(prod).toMatchObject({ dev: false, port: 1111, host: undefined, dataDir: '/abs/data', adminPath: 'ops-Panel_42' });
    expect(loadConfig(env, '/r').port).toBe(8787);
  });

  it('ADMIN_PATH: `admin` by default in dev only; production needs a valid, non-default one', () => {
    const env = { ADMIN_PASSWORD: 'a'.repeat(12), SERVER_SECRET: 'b'.repeat(32) };
    expect(loadConfig(env, '/r').adminPath).toBe('admin');
    expect(loadConfig({ ...env, ADMIN_PATH: 'my-panel' }, '/r').adminPath).toBe('my-panel');
    const prod = { ...env, NODE_ENV: 'production' };
    expect(() => loadConfig(prod, '/r')).toThrow(/ADMIN_PATH is missing/);
    expect(() => loadConfig({ ...prod, ADMIN_PATH: '  ' }, '/r')).toThrow(/ADMIN_PATH is missing/);
    expect(() => loadConfig({ ...prod, ADMIN_PATH: 'admin' }, '/r')).toThrow(/must not be "admin"/);
    expect(() => loadConfig({ ...prod, ADMIN_PATH: 'Admin' }, '/r')).toThrow(/must not be "admin"/);
    expect(() => loadConfig({ ...env, DEV: '0', ADMIN_PATH: 'admin' }, '/r')).toThrow(/must not be "admin"/);
    for (const bad of ['abc', 'a/b-c', 'x'.repeat(65), 'path.html', 'with space', '%2e%2e']) {
      expect(() => parseAdminPath(bad, true), bad).toThrow(/ADMIN_PATH must be/);
    }
    for (const taken of ['data', 'assets', 'daily', 'Play', 'rooms', 'health']) {
      expect(() => parseAdminPath(taken, false), taken).toThrow(/collides/);
    }
    // The error never echoes the value.
    expect(() => parseAdminPath('secret.value', false)).toThrow(expect.objectContaining({ message: expect.not.stringContaining('secret.value') }));
  });

  it('setup writes missing secrets once, mode 0600, keeping other lines', () => {
    const path = join(tmp, 'env.local');
    writeFileSync(path, 'API_PORT=8790');
    expect(ensureEnvLocal(path)).toEqual(['ADMIN_PASSWORD', 'SERVER_SECRET', 'ADMIN_PATH']);
    const first = readFileSync(path, 'utf8');
    const env = parseEnvFile(first);
    expect(env.API_PORT).toBe('8790');
    expect(env.ADMIN_PASSWORD!.length).toBeGreaterThanOrEqual(16);
    expect(env.SERVER_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ADMIN_PATH).toMatch(/^admin-[a-z2-7]{16}$/);
    expect(parseAdminPath(env.ADMIN_PATH, false)).toBe(env.ADMIN_PATH);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ensureEnvLocal(path)).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(first);
    // The dev server's on-the-fly fallback leaves ADMIN_PATH alone.
    const devPath = join(tmp, 'env.dev');
    expect(ensureEnvLocal(devPath, { adminPath: false })).toEqual(['ADMIN_PASSWORD', 'SERVER_SECRET']);
    expect(parseEnvFile(readFileSync(devPath, 'utf8')).ADMIN_PATH).toBeUndefined();
  });
});

describe('database', () => {
  it('migrates to the latest version, idempotently, with WAL on files', () => {
    const path = join(tmp, 'db/test.sqlite');
    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    for (const t of ['players', 'bans', 'challenges', 'games', 'rounds', 'daily_overrides', 'hits', 'blocklist', 'audit_log', 'rooms_log']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('repository extras: bans history, blocklist, audit log, rooms log', async () => {
    const repo = new SqliteRepository(openDatabase(':memory:'));
    await repo.insertPlayer({ id: 'p1', tokenHash: 'h1', nickname: 'Ann', banned: false, createdAt: 1, lastSeenAt: 1 });
    await repo.setBanned('p1', true, 5, 'spam');
    await repo.setBanned('p1', false, 6);
    expect((await repo.getPlayer('p1'))!.banned).toBe(false);
    expect(repo.db.prepare('SELECT action, reason FROM bans ORDER BY at').all()).toEqual([
      { action: 'ban', reason: 'spam' },
      { action: 'unban', reason: null },
    ]);
    await repo.addBlockedWord('gronk', 1);
    await repo.addBlockedWord('gronk', 2);
    expect(await repo.listBlockedWords()).toEqual(['gronk']);
    await repo.removeBlockedWord('gronk');
    expect(await repo.listBlockedWords()).toEqual([]);
    await repo.addAudit({ at: 1, action: 'ban', target: 'p1', details: 'spam' });
    await repo.addAudit({ at: 2, action: 'unban', target: 'p1' });
    expect(await repo.listAudit(10)).toEqual([
      { at: 2, action: 'unban', target: 'p1' },
      { at: 1, action: 'ban', target: 'p1', details: 'spam' },
    ]);
    expect(await repo.listAudit(10, 2)).toHaveLength(1);
    await repo.logRoomCreated('ABCDE', 'party', 'p1', 10);
    await repo.logRoomClosed('ABCDE', 20);
    expect(repo.db.prepare('SELECT code, closed_at FROM rooms_log').get()).toEqual({ code: 'ABCDE', closed_at: 20 });
  });
});

describe('production server on port 0', () => {
  const ADMIN_PATH = 'ops-Panel_7x';
  let server: ServerType;
  let base: string;
  let close: () => void;

  beforeAll(async () => {
    const root = join(tmp, 'prod');
    const dataDir = join(root, 'data');
    const serverDataDir = join(root, 'server-data');
    const distDir = join(root, 'dist');
    writeFixtureDataset(dataDir, serverDataDir);
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    // %ADMIN_PATH% in the game shell is a trap: only admin.html may ever get the admin path.
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>game</title><meta property="og:image" content="%ORIGIN%/ui/og.jpg"><i>%ADMIN_PATH%</i>');
    writeFileSync(join(distDir, 'admin.html'), '<!doctype html><title>admin</title><meta name="g2-admin-path" content="%ADMIN_PATH%">');
    writeFileSync(join(distDir, 'assets/app-abc123.js'), 'console.log(1)');
    mkdirSync(join(dataDir, 'panos/alpha0000'), { recursive: true });
    writeFileSync(join(dataDir, 'panos/alpha0000/base_front.webp'), 'WEBP');
    mkdirSync(join(dataDir, 'alpha/map/0/0'), { recursive: true });
    writeFileSync(join(dataDir, 'alpha/map/0/0/0.webp'), 'WEBP');
    writeFileSync(join(dataDir, 'alpha/world.json'), '{"world":"alpha"}');
    writeFileSync(join(dataDir, 'alpha/manifest.json'), '{"leak":true}'); // must never be served

    const { worlds } = loadWorldRegistry(dataDir, serverDataDir);
    const db = openDatabase(':memory:');
    const services = createServices({
      config: testConfig({ dev: false, dataDir, serverDataDir, distDir, trustProxy: false, adminPath: ADMIN_PATH }),
      repo: new SqliteRepository(db),
      worlds,
    });
    const app = createApp(services);
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => {
      server.close();
      db.close();
    };
  });
  afterAll(() => close());

  it('serves the API with real sockets (IP from the socket)', async () => {
    const res = await fetch(`${base}/api/players`, { method: 'POST' });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const game = (await (
      await fetch(`${base}/api/games`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ kind: 'solo', settings: { mode: 'mixed', worlds: ['alpha'], noMove: false, noLook: false, timeLimit: 30 } }),
      })
    ).json()) as GameView;
    const round = (await (await fetch(`${base}/api/games/${game.id}/rounds`, { method: 'POST', headers: auth })).json()) as RoundView;
    expect(round.deadline).toBe(round.startedAt + 30_000);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('fills %ORIGIN% in the shell for link previews, on / and on client routes', async () => {
    for (const path of ['/', '/index.html', '/daily']) {
      const html = await (await fetch(`${base}${path}`)).text();
      expect(html).toContain(`content="${base}/ui/og.jpg"`);
      expect(html).not.toContain('%ORIGIN%');
    }
  });

  it('serves the SPA with history fallback and admin.html only under /<ADMIN_PATH>', async () => {
    for (const path of ['/', '/play', '/daily', '/c/abcd2345', '/r/QWERT', `/${ADMIN_PATH}x`, `/${ADMIN_PATH.toLowerCase()}`]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<title>game</title>');
      expect(html).not.toContain(ADMIN_PATH);
    }
    expect((await fetch(`${base}/`)).headers.get('cache-control')).toBe('no-cache');
    for (const path of [`/${ADMIN_PATH}`, `/${ADMIN_PATH}/`, `/${ADMIN_PATH}/players/abc`]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const html = await res.text();
      expect(html).toContain('<title>admin</title>');
      expect(html).toContain(`<meta name="g2-admin-path" content="${ADMIN_PATH}">`);
    }
    // The well-known locations and the raw shell file give nothing away.
    for (const path of ['/admin', '/admin/', '/admin/players', '/admin.html']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      const body = await res.text();
      expect(body).not.toContain('<title>admin</title>');
      expect(body).not.toContain(ADMIN_PATH);
    }
    const asset = await fetch(`${base}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/api/unknown`)).status).toBe(404);
  });

  it('serves /data with immutable caching for panos and map tiles, never a manifest.json', async () => {
    const pano = await fetch(`${base}/data/panos/alpha0000/base_front.webp`);
    expect(pano.status).toBe(200);
    expect(pano.headers.get('content-type')).toBe('image/webp');
    expect(pano.headers.get('cache-control')).toContain('immutable');
    const tile = await fetch(`${base}/data/alpha/map/0/0/0.webp`);
    expect(tile.headers.get('cache-control')).toContain('immutable');
    const worldJson = await fetch(`${base}/data/alpha/world.json`);
    expect(worldJson.status).toBe(200);
    expect(worldJson.headers.get('cache-control')).not.toContain('immutable');
    expect((await fetch(`${base}/data/worlds.json`)).status).toBe(200);
    expect((await fetch(`${base}/data/alpha/manifest.json`)).status).toBe(404);
    expect((await fetch(`${base}/data/alpha/MANIFEST.JSON`)).status).toBe(404);
    expect((await fetch(`${base}/data/nope.webp`)).status).toBe(404);
    expect((await fetch(`${base}/data/..%2f..%2fserver-data/alpha/manifest.json`)).status).toBe(404);
  });
});
