/**
 * Security review (stage 3): answer leaks. Every test here documents a CONFIRMED issue and fails until it is fixed.
 *
 *   1. Pano tiles are served with `Last-Modified` = file mtime. The publish step leaves per-world, render-ordered
 *      mtimes, so a HEAD on the round's start tile tells the world and (with a table built from revealed answers)
 *      the location within ~10 m (SPEC §10.1 "world of a panorama before the guess", §10.3 flat dir "so the URL does
 *      not reveal the world").
 *   2. A room (party) guess over REST returns the answer while the round is still open for the other players.
 *   3. The leaderboard of a RUNNING party challenge lists players who finished the last round, with per-round scores,
 *      before the round is over for everyone.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LeaderboardView, PublicSettings, RoundResultView } from '../../shared/api';
import { Client, harness } from './helpers';
import type { Harness } from './helpers';

const ROOT = resolve(__dirname, '../..');

let h: Harness | null = null;
let tmp: string | null = null;
afterEach(() => {
  h?.close();
  h = null;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('review: pano file metadata', () => {
  it('serves /data/panos/* without a Last-Modified header (mtime reveals world and render order)', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'g2g-review-'));
    const dataDir = join(tmp, 'data');
    const distDir = join(tmp, 'dist');
    mkdirSync(distDir, { recursive: true });
    // Two panos of different worlds, rendered on different days (as in the real dataset).
    const files: Record<string, number> = { aaaaaaaaaaaa: Date.UTC(2026, 8, 30, 10), bbbbbbbbbbbb: Date.UTC(2026, 9, 1, 10) };
    for (const [key, mtime] of Object.entries(files)) {
      mkdirSync(join(dataDir, 'panos', key), { recursive: true });
      const f = join(dataDir, 'panos', key, 'base_front.webp');
      writeFileSync(f, 'RIFF....WEBP');
      utimesSync(f, mtime / 1000, mtime / 1000);
    }
    h = harness({ config: { dataDir, distDir, dev: false }, app: { serveStatic: true } });
    const seen: (string | null)[] = [];
    for (const key of Object.keys(files)) {
      const res = await h.app.request(`/data/panos/${key}/base_front.webp`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      seen.push(res.headers.get('last-modified'));
      expect(res.headers.get('etag')).toBeNull();
    }
    // Today: "Wed, 30 Sep 2026 10:00:00 GMT" vs "Thu, 01 Oct 2026 10:00:00 GMT" → the world of a key is one HEAD away.
    expect(seen).toEqual([null, null]);
  });

  it.skipIf(!existsSync(join(ROOT, 'server-data')) || !existsSync(join(ROOT, 'public/data/panos')))(
    'published pano files do not carry per-world mtime ranges (real dataset)',
    () => {
      const ranges: { slug: string; min: number; max: number }[] = [];
      for (const slug of ['khorinis', 'valley', 'jharkendar']) {
        const path = join(ROOT, 'server-data', slug, 'manifest.json');
        if (!existsSync(path)) continue;
        const nodes = (JSON.parse(readFileSync(path, 'utf8')) as { nodes: { key: string }[] }).nodes;
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < nodes.length; i += Math.max(1, Math.floor(nodes.length / 60))) {
          const f = join(ROOT, 'public/data/panos', nodes[i]!.key, 'base_front.webp');
          if (!existsSync(f)) continue;
          const t = Math.floor(statSync(f).mtimeMs / 1000);
          min = Math.min(min, t);
          max = Math.max(max, t);
        }
        if (Number.isFinite(min)) ranges.push({ slug, min, max });
      }
      // Pairwise: a world's mtime range must not be disjoint from another's (today they are: khorinis ≈ 1790961086–
      // 1790962123, valley ≈ 1791044252–1791044631, jharkendar ≈ 1791044740–1791045288).
      const disjoint: string[] = [];
      for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
          const a = ranges[i]!;
          const b = ranges[j]!;
          if (a.max < b.min || b.max < a.min) disjoint.push(`${a.slug}/${b.slug}`);
        }
      }
      expect(disjoint).toEqual([]);
    },
  );
});

const PARTY: PublicSettings = { mode: 'classic', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 3 };

async function partyOfTwo(): Promise<{ a: Client; b: Client; aId: string; bId: string; code: string; games: Record<string, string> }> {
  h = harness();
  const a = new Client(h.app, '10.1.0.1');
  const b = new Client(h.app, '10.1.0.2');
  const aId = await a.register();
  const bId = await b.register();
  const r = await h.services.games.createRoomGames({ type: 'party', settings: PARTY, roomCode: 'ABCDE', hostId: aId, playerIds: [aId, bId] });
  return { a, b, aId, bId, code: r.challengeCode, games: r.games };
}

describe('review: room rounds', () => {
  it('does not reveal the answer to a room player while the room round is still open for others', async () => {
    const { a, aId, code, games } = await partyOfTwo();
    await h!.services.games.openRoomRound(code, 1, { startedAt: h!.clock.now, deadline: null });
    // A (e.g. an alt account in the same party) gives up at once…
    const res = await a.call<RoundResultView>('POST', `/api/games/${games[aId]}/guess`, { guess: null });
    expect(res.status).toBe(200);
    // …and today gets the exact answer while B is still guessing (roundResult has not been sent yet).
    expect(res.body.answer).toBeUndefined();
  });

  it('keeps a running party challenge off the public leaderboard until the room game is finished', async () => {
    const { a, b, aId, code, games } = await partyOfTwo();
    for (const n of [1, 2]) {
      await h!.services.games.openRoomRound(code, n, { startedAt: h!.clock.now, deadline: null });
      await h!.services.games.closeRoomRound(code, n);
    }
    await h!.services.games.openRoomRound(code, 3, { startedAt: h!.clock.now, deadline: null });
    expect((await a.call('POST', `/api/games/${games[aId]}/guess`, { guess: { world: 'alpha', x: 0, z: 0 } })).status).toBe(200);
    // B has not guessed round 3 yet; the room challenge is still `running`.
    const board = await b.call<LeaderboardView>('GET', `/api/challenges/${code}/leaderboard`);
    expect(board.status).toBe(200);
    // Today A is listed with rounds [0, 0, <round-3 score>] before the round is over for B.
    expect(board.body.entries).toEqual([]);
  });
});
