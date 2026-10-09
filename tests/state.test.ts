import { describe, expect, it } from 'vitest';
import type { Manifest } from '../src/contracts';
import { validateManifest } from '../src/data/manifest';
import { readDataset } from './dataset';
import {
  DEFAULT_MODE,
  GAME_MODES,
  GameState,
  MAX_SEED,
  ROUNDS_PER_GAME,
  createRng,
  modeFromUrl,
  modeLabel,
  parseMode,
  pickStarts,
  randomSeed,
  parseSeed,
  seedFromUrl,
  usableStartCount,
} from '../src/game/state';
import type { GameMode } from '../src/game/state';

const manifestJson: unknown = readDataset('server-data/khorinis/manifest.json');

// The real development dataset: the private khorinis manifest in server-data/ (SPEC §10.3).
const manifest = validateManifest(manifestJson as unknown, 'khorinis/manifest.json');

/**
 * Small synthetic manifest: 6 nodes on a line, 100 m apart, the first `startCount` of them
 * starts. `indoorIds` marks nodes as indoor (default: all outdoor).
 */
function tinyManifest(startCount = 6, indoorIds: number[] = []): Manifest {
  const nodes = Array.from({ length: 6 }, (_, i) => ({
    id: i,
    wp: `N${i}`,
    x: i * 10_000,
    y: 0,
    z: 0,
    outdoor: !indoorIds.includes(i),
    links: [] as Manifest['nodes'][number]['links'],
  }));
  return {
    ...manifest,
    nodes,
    starts: nodes.slice(0, startCount).map((n) => n.id),
  };
}

const isIndoor = (id: number): boolean => manifest.nodes[id]!.outdoor !== true;
const MODES: GameMode[] = ['classic', 'mixed', 'hardcore'];

describe('createRng', () => {
  it('is deterministic for a seed and uniform-ish in [0, 1)', () => {
    const a = createRng(123);
    const b = createRng(123);
    const seq = Array.from({ length: 20 }, () => a());
    expect(Array.from({ length: 20 }, () => b())).toEqual(seq);
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(seq).size).toBe(20);
    let sum = 0;
    const r = createRng(7);
    for (let i = 0; i < 10_000; i++) sum += r();
    expect(sum / 10_000).toBeGreaterThan(0.45);
    expect(sum / 10_000).toBeLessThan(0.55);
  });

  it('different seeds give different sequences', () => {
    expect(createRng(1)()).not.toBe(createRng(2)());
  });
});

describe('pickStarts', () => {
  it('returns distinct starts from the manifest, deterministically', () => {
    const a = pickStarts(manifest, 42, 5);
    const b = pickStarts(manifest, 42, 5);
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
    expect(new Set(a).size).toBe(5);
    for (const id of a) expect(manifest.starts).toContain(id);
  });

  it('defaults to ROUNDS_PER_GAME and changes with the seed', () => {
    expect(pickStarts(manifest, 1)).toHaveLength(ROUNDS_PER_GAME);
    const picks = new Set([1, 2, 3, 4, 5].map((s) => pickStarts(manifest, s).join(',')));
    expect(picks.size).toBeGreaterThan(1);
  });

  it('never repeats even when asked for every start', () => {
    const all = pickStarts(manifest, 9, manifest.starts.length);
    expect(new Set(all).size).toBe(manifest.starts.length);
    expect([...all].sort((x, y) => x - y)).toEqual([...new Set(manifest.starts)].sort((x, y) => x - y));
  });

  it('throws when there are not enough starts', () => {
    expect(() => pickStarts(tinyManifest(3), 1, 5)).toThrow(/need 5 starts/);
  });

  it('defaults to the mixed mode', () => {
    expect(DEFAULT_MODE).toBe('mixed');
    expect(pickStarts(manifest, 77)).toEqual(pickStarts(manifest, 77, ROUNDS_PER_GAME, 'mixed'));
  });

  it('is deterministic per (seed, mode) and the mode changes the picks', () => {
    for (const mode of MODES) {
      expect(pickStarts(manifest, 2024, 5, mode)).toEqual(pickStarts(manifest, 2024, 5, mode));
      expect(pickStarts(manifest, 2024, 5, mode)).not.toEqual(pickStarts(manifest, 2025, 5, mode));
    }
    expect(pickStarts(manifest, 2024, 5, 'classic')).not.toEqual(pickStarts(manifest, 2024, 5, 'hardcore'));
    expect(pickStarts(manifest, 2024, 5, 'mixed')).not.toEqual(pickStarts(manifest, 2024, 5, 'hardcore'));
  });

  it('classic never returns an indoor id', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const picks = pickStarts(manifest, seed, 5, 'classic');
      expect(picks).toHaveLength(5);
      expect(new Set(picks).size).toBe(5);
      for (const id of picks) {
        expect(manifest.starts).toContain(id);
        expect(isIndoor(id), `seed ${seed} id ${id}`).toBe(false);
      }
    }
    // Every outdoor start is reachable when asked for the whole pool.
    const outdoorCount = usableStartCount(manifest, 'classic');
    const all = pickStarts(manifest, 3, outdoorCount, 'classic');
    expect(new Set(all).size).toBe(outdoorCount);
    expect(() => pickStarts(manifest, 3, outdoorCount + 1, 'classic')).toThrow(/outdoor starts/);
  });

  it('hardcore draws from both pools', () => {
    // About half of the starts are indoor, so a 5-round game has both kinds for most seeds; pick
    // the first seed where that holds and pin it down.
    const seed = [1, 2, 3, 4, 5, 6, 7, 8].find((s) => {
      const picks = pickStarts(manifest, s, 5, 'hardcore');
      return picks.some(isIndoor) && picks.some((id) => !isIndoor(id));
    });
    expect(seed).toBeDefined();
    const picks = pickStarts(manifest, seed!, 5, 'hardcore');
    expect(new Set(picks).size).toBe(5);
    expect(picks.filter(isIndoor).length).toBeGreaterThan(0);
    expect(picks.filter((id) => !isIndoor(id)).length).toBeGreaterThan(0);
    // The full shuffle is a permutation of all starts.
    const all = pickStarts(manifest, seed!, manifest.starts.length, 'hardcore');
    expect([...all].sort((x, y) => x - y)).toEqual([...new Set(manifest.starts)].sort((x, y) => x - y));
  });

  it('mixed has roughly a third of indoor starts and never repeats ids', () => {
    let indoor = 0;
    let total = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const picks = pickStarts(manifest, seed, 5, 'mixed');
      expect(picks).toHaveLength(5);
      expect(new Set(picks).size).toBe(5);
      for (const id of picks) {
        expect(manifest.starts).toContain(id);
        if (isIndoor(id)) indoor++;
        total++;
      }
    }
    const share = indoor / total;
    expect(share).toBeGreaterThan(0.27);
    expect(share).toBeLessThan(0.43);
  });

  it('mixed falls back to the other pool when one is exhausted (synthetic manifest)', () => {
    // 6 starts: ids 0, 1 outdoor; 2..5 indoor.
    const m = tinyManifest(6, [2, 3, 4, 5]);
    for (let seed = 1; seed <= 20; seed++) {
      const six = pickStarts(m, seed, 6, 'mixed');
      expect([...six].sort()).toEqual([0, 1, 2, 3, 4, 5]);
      const five = pickStarts(m, seed, 5, 'mixed');
      expect(new Set(five).size).toBe(5);
    }
    expect(() => pickStarts(m, 1, 7, 'mixed')).toThrow(/need 7 starts/);
    expect(() => pickStarts(m, 1, 7, 'hardcore')).toThrow(/need 7 starts/);
    // Only two outdoor starts: classic can hand out two, not three.
    expect([...pickStarts(m, 1, 2, 'classic')].sort()).toEqual([0, 1]);
    expect(() => pickStarts(m, 1, 3, 'classic')).toThrow(/need 3 outdoor starts but the manifest has 2/);
    // All-indoor manifest: classic has nothing, the other modes work.
    const caves = tinyManifest(4, [0, 1, 2, 3, 4, 5]);
    expect(() => pickStarts(caves, 1, 1, 'classic')).toThrow(/outdoor starts/);
    expect(pickStarts(caves, 1, 4, 'mixed')).toHaveLength(4);
    expect(pickStarts(caves, 1, 4, 'hardcore')).toHaveLength(4);
    expect(usableStartCount(caves, 'classic')).toBe(0);
    expect(usableStartCount(caves, 'mixed')).toBe(4);
    expect(usableStartCount(m, 'classic')).toBe(2);
  });
});

describe('game modes', () => {
  it('lists the three modes with labels and descriptions', () => {
    expect(GAME_MODES.map((m) => m.id)).toEqual(['classic', 'mixed', 'hardcore']);
    expect(GAME_MODES.map((m) => m.label)).toEqual(['Classic', 'Mixed', 'Hardcore']);
    for (const m of GAME_MODES) expect(m.description.length).toBeGreaterThan(10);
    expect(modeLabel('hardcore')).toBe('Hardcore');
  });

  it('parseMode accepts the three ids case-insensitively and rejects the rest', () => {
    expect(parseMode('classic')).toBe('classic');
    expect(parseMode('MIXED')).toBe('mixed');
    expect(parseMode(' Hardcore ')).toBe('hardcore');
    for (const raw of [null, '', 'easy', 'classic ', 'hard', 'mixed2', '1']) {
      if (raw === 'classic ') continue; // trimmed → valid, covered above
      expect(parseMode(raw), String(raw)).toBeNull();
    }
    expect(parseMode('classic ')).toBe('classic');
  });

  it('modeFromUrl reads ?mode= like seedFromUrl reads ?seed=', () => {
    expect(modeFromUrl('?mode=hardcore')).toBe('hardcore');
    expect(modeFromUrl('?seed=1&mode=Classic')).toBe('classic');
    expect(modeFromUrl('http://localhost:5173/?seed=7&mode=mixed#x')).toBe('mixed');
    expect(modeFromUrl(new URL('http://localhost:5173/?mode=hardcore'))).toBe('hardcore');
    expect(modeFromUrl(new URLSearchParams({ mode: 'mixed' }))).toBe('mixed');
    expect(modeFromUrl('')).toBeNull();
    expect(modeFromUrl('?mode=')).toBeNull();
    expect(modeFromUrl('?mode=nope')).toBeNull();
    expect(modeFromUrl('?seed=5')).toBeNull();
  });
});

describe('parseSeed', () => {
  it('accepts 1–10 digits up to MAX_SEED, with surrounding whitespace', () => {
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed(' 7777 ')).toBe(7777);
    expect(parseSeed(String(MAX_SEED))).toBe(MAX_SEED);
  });

  it('rejects everything else', () => {
    for (const raw of ['', 'abc', '1e3', '-1', '1.5', '4294967296', '12345678901']) {
      expect(parseSeed(raw), raw).toBeNull();
    }
  });
});

describe('seedFromUrl', () => {
  it('parses ?seed= from search strings, URLs and params', () => {
    expect(seedFromUrl('?seed=123')).toBe(123);
    expect(seedFromUrl('seed=123')).toBe(123);
    expect(seedFromUrl('?foo=1&seed=0')).toBe(0);
    expect(seedFromUrl('http://localhost:5173/?seed=777#x')).toBe(777);
    expect(seedFromUrl(new URL('http://localhost:5173/?seed=42'))).toBe(42);
    expect(seedFromUrl(new URLSearchParams({ seed: '9' }))).toBe(9);
    expect(seedFromUrl(`?seed=${MAX_SEED}`)).toBe(MAX_SEED);
  });

  it('rejects missing or malformed seeds', () => {
    expect(seedFromUrl('')).toBeNull();
    expect(seedFromUrl('?seed=')).toBeNull();
    expect(seedFromUrl('?seed=abc')).toBeNull();
    expect(seedFromUrl('?seed=-1')).toBeNull();
    expect(seedFromUrl('?seed=1.5')).toBeNull();
    expect(seedFromUrl(`?seed=${MAX_SEED + 1}`)).toBeNull();
    expect(seedFromUrl('?other=1')).toBeNull();
  });

  it('randomSeed is within range', () => {
    for (let i = 0; i < 100; i++) {
      const s = randomSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(MAX_SEED);
    }
  });
});

describe('GameState', () => {
  it('starts idle and exposes seed and totalRounds', () => {
    const g = new GameState(manifest, 5);
    expect(g.phase).toBe('idle');
    expect(g.seed).toBe(5);
    expect(g.totalRounds).toBe(ROUNDS_PER_GAME);
    expect(g.score).toBe(0);
    expect(() => g.round).toThrow(/no active round/);
    expect(g.mode).toBe('mixed');
    const settings = { seed: 5, mode: 'mixed', worlds: ['khorinis'], noMove: false, noLook: false };
    expect(g.settings).toEqual(settings);
    expect(g.enabledWorlds).toEqual(['khorinis']);
    expect(g.getSnapshot()).toEqual({ phase: 'idle', seed: 5, mode: 'mixed', settings, totalRounds: 5, round: null, results: [], score: 0 });
  });

  it('takes a mode, uses the matching starts and reports it in the summary', () => {
    for (const mode of MODES) {
      const expected = pickStarts(manifest, 99, ROUNDS_PER_GAME, mode);
      const g = new GameState(manifest, 99, mode);
      expect(g.mode).toBe(mode);
      expect(g.getSnapshot().mode).toBe(mode);
      const seen: number[] = [];
      for (let i = 0; i < ROUNDS_PER_GAME; i++) {
        const r = g.startNextRound();
        seen.push(r.startNodeId);
        g.setGuess(r.answer);
        g.submitGuess();
      }
      expect(seen).toEqual(expected);
      expect(g.finish().mode).toBe(mode);
    }
    // Classic on an all-indoor manifest has no starts at all.
    expect(() => new GameState(tinyManifest(4, [0, 1, 2, 3, 4, 5]), 1, 'classic')).toThrow(/no starts for mode "classic"/);
    // Classic with two outdoor starts plays two rounds.
    expect(new GameState(tinyManifest(6, [2, 3, 4, 5]), 1, 'classic').totalRounds).toBe(2);
  });

  it('is deterministic: same seed → same start nodes, same as pickStarts', () => {
    const expected = pickStarts(manifest, 2024, ROUNDS_PER_GAME);
    const g = new GameState(manifest, 2024);
    const seen: number[] = [];
    for (let i = 0; i < ROUNDS_PER_GAME; i++) {
      const r = g.startNextRound();
      seen.push(r.startNodeId);
      g.setGuess(r.answer);
      g.submitGuess();
    }
    expect(seen).toEqual(expected);
  });

  it('walks idle → round → result → … → summary with correct scores', () => {
    const g = new GameState(tinyManifest(), 1);
    const results = [];
    for (let i = 1; i <= 5; i++) {
      const r = g.startNextRound();
      expect(g.phase).toBe('round');
      expect(r.round).toBe(i);
      expect(r.currentNodeId).toBe(r.startNodeId);
      expect(r.visited).toBe(1);
      expect(r.guess).toBeNull();
      expect(r.answer).toEqual({ x: r.startNodeId * 10_000, z: 0 });
      expect(r.world).toBe('khorinis');
      expect(g.startLocation).toEqual({ world: 'khorinis', nodeId: r.startNodeId });
      expect(g.manifest.world).toBe('khorinis');

      // Guess 155 m east of the answer on odd rounds (1835 with diagonal 1546), perfect on even ones.
      const off = i % 2 === 1 ? 15_500 : 0;
      g.setGuess({ x: r.answer.x + off, z: r.answer.z });
      const res = g.submitGuess();
      expect(g.phase).toBe('result');
      expect(res.round).toBe(i);
      expect(res.distanceM).toBeCloseTo(off / 100, 6);
      expect(res.score).toBe(off ? 1835 : 5000);
      expect(res.guessWorld).toBe('khorinis');
      expect(res.answerWorld).toBe('khorinis');
      expect(res.answerNodeId).toBe(r.startNodeId);
      expect(res.guess).toEqual({ world: 'khorinis', x: r.answer.x + off, z: 0 });
      expect(g.isLastRound()).toBe(i === 5);
      results.push(res);
    }
    expect(g.score).toBe(1835 * 3 + 5000 * 2);
    const summary = g.finish();
    expect(g.phase).toBe('summary');
    expect(summary).toEqual({
      seed: 1,
      mode: 'mixed',
      settings: { seed: 1, mode: 'mixed', worlds: ['khorinis'], noMove: false, noLook: false },
      rounds: results,
      total: 1835 * 3 + 5000 * 2,
    });
    expect(() => g.startNextRound()).toThrow(/cannot start/);
    expect(() => g.round).toThrow();
  });

  it('rejects out-of-order transitions', () => {
    const g = new GameState(manifest, 3);
    expect(() => g.submitGuess()).toThrow(/expected phase "round"/);
    expect(() => g.setGuess({ x: 0, z: 0 })).toThrow();
    expect(() => g.setCurrentNode(0)).toThrow();
    expect(() => g.finish()).toThrow(/cannot finish/);

    g.startNextRound();
    expect(() => g.startNextRound()).toThrow(/cannot start/);
    expect(() => g.submitGuess()).toThrow(/no guess/);
    expect(() => g.finish()).toThrow(/cannot finish/);

    g.setGuess({ x: 0, z: 0 });
    g.submitGuess();
    expect(() => g.submitGuess()).toThrow();
    expect(() => g.setGuess(null)).toThrow();
    expect(() => g.finish()).toThrow(/cannot finish/); // not the last round
    expect(g.isLastRound()).toBe(false);
    g.startNextRound();
    expect(g.round.round).toBe(2);
  });

  it('tracks movement and return to start', () => {
    const g = new GameState(manifest, 11);
    const r = g.startNextRound();
    const start = r.startNodeId;
    const next = manifest.nodes[start]!.links[0]!.to;
    g.setCurrentNode(next);
    expect(g.round.currentNodeId).toBe(next);
    expect(g.round.visited).toBe(2);
    g.setCurrentNode(next); // no-op when already there
    expect(g.round.visited).toBe(2);
    g.returnToStart();
    expect(g.round.currentNodeId).toBe(start);
    expect(g.round.visited).toBe(3);
    expect(() => g.setCurrentNode(99_999)).toThrow(/unknown node/);
    // The answer is the start node, not the current one.
    g.setGuess({ x: 0, z: 0 });
    const res = g.submitGuess();
    expect(res.answer).toEqual({ x: manifest.nodes[start]!.x, z: manifest.nodes[start]!.z });
  });

  it('setGuess can clear and replace the guess and copies the object', () => {
    const g = new GameState(manifest, 8);
    g.startNextRound();
    const p = { x: 1, z: 2 };
    g.setGuess(p); // no world → the round's own world
    p.x = 99;
    expect(g.round.guess).toEqual({ world: 'khorinis', x: 1, z: 2 });
    g.setGuess(null);
    expect(g.round.guess).toBeNull();
    g.setGuess({ world: 'khorinis', x: 3, z: 4 });
    expect(g.round.guess).toEqual({ world: 'khorinis', x: 3, z: 4 });
    expect(() => g.setGuess({ world: 'valley', x: 3, z: 4 })).toThrow(/unknown world "valley"/);
  });

  it('snapshot is a detached plain copy', () => {
    const g = new GameState(manifest, 8);
    g.startNextRound();
    g.setGuess({ x: 5, z: 6 });
    const snap = g.getSnapshot();
    expect(snap.phase).toBe('round');
    expect(snap.round?.guess).toEqual({ world: 'khorinis', x: 5, z: 6 });
    snap.settings.worlds.push('nope');
    expect(g.settings.worlds).toEqual(['khorinis']);
    snap.round!.guess!.x = 1000;
    snap.round!.visited = 50;
    expect(g.round.guess).toEqual({ world: 'khorinis', x: 5, z: 6 });
    expect(g.round.visited).toBe(1);
    g.submitGuess();
    const snap2 = g.getSnapshot();
    expect(snap2.results).toHaveLength(1);
    expect(snap2.score).toBe(snap2.results[0]!.score);
    expect(JSON.parse(JSON.stringify(snap2))).toEqual(snap2);
  });

  it('plays fewer rounds when the manifest has fewer starts', () => {
    const g = new GameState(tinyManifest(2), 1);
    expect(g.totalRounds).toBe(2);
    g.startNextRound();
    g.setGuess({ x: 0, z: 0 });
    g.submitGuess();
    expect(g.isLastRound()).toBe(false);
    g.startNextRound();
    g.setGuess({ x: 0, z: 0 });
    g.submitGuess();
    expect(g.isLastRound()).toBe(true);
    expect(g.finish().rounds).toHaveLength(2);
  });

  it('normalises the seed to 32 bits', () => {
    expect(new GameState(manifest, 2 ** 32 + 5).seed).toBe(5);
    expect(new GameState(manifest, 2 ** 32 + 5).getSnapshot().seed).toBe(5);
  });
});
