import { describe, expect, it } from 'vitest';
import type { GameSettings, Location, Manifest } from '../src/contracts';
import { validateManifest } from '../src/data/manifest';
import { readDataset } from './dataset';
import { getManifest, getNodeAt, hasLocation, locationCoords, sameLocation } from '../src/game/graph';
import {
  GameState,
  ROUNDS_PER_GAME,
  createRng,
  createStartPicker,
  pickRounds,
  pickStarts,
  usableRoundCount,
  usableStartCount,
} from '../src/game/state';
import type { GameMode } from '../src/game/state';

const manifestJson: unknown = readDataset('server-data/khorinis/manifest.json');

const khorinis = validateManifest(manifestJson as unknown, 'khorinis/manifest.json');
const MODES: GameMode[] = ['classic', 'mixed', 'hardcore'];

/** The real dataset cloned under another slug (valley/jharkendar are not rendered yet). */
function cloneAs(slug: string, base: Manifest = khorinis): Manifest {
  return { ...base, world: slug, name: slug };
}

/**
 * Synthetic world `slug`: `n` nodes on a line 100 m apart, the first `startCount` are starts,
 * `indoorIds` are indoor.
 */
function tiny(slug: string, startCount: number, indoorIds: number[] = [], n = Math.max(6, startCount)): Manifest {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: i,
    wp: `${slug}-${i}`,
    x: i * 10_000,
    y: 0,
    z: 0,
    outdoor: !indoorIds.includes(i),
    links: [] as Manifest['nodes'][number]['links'],
  }));
  return { ...khorinis, world: slug, name: slug, nodes, starts: nodes.slice(0, startCount).map((x) => x.id) };
}

function worldsOf(...manifests: Manifest[]): Map<string, { manifest: Manifest }> {
  return new Map(manifests.map((m) => [m.world, { manifest: m }]));
}

const THREE = worldsOf(khorinis, cloneAs('valley'), cloneAs('jharkendar'));
const ALL = ['khorinis', 'valley', 'jharkendar'];

function settings(over: Partial<GameSettings> = {}): GameSettings {
  return { seed: 1, mode: 'mixed', worlds: ALL, noMove: false, noLook: false, ...over };
}

const key = (l: Location): string => `${l.world}:${l.nodeId}`;

describe('graph location helpers', () => {
  it('resolve {world, nodeId} against the loaded worlds', () => {
    const loc = { world: 'valley', nodeId: 2045 };
    expect(getManifest(THREE, 'valley').world).toBe('valley');
    expect(getNodeAt(THREE, loc).wp).toBe(khorinis.nodes[2045]!.wp);
    expect(locationCoords(THREE, loc)).toEqual({ x: khorinis.nodes[2045]!.x, z: khorinis.nodes[2045]!.z });
    expect(hasLocation(THREE, loc)).toBe(true);
    expect(hasLocation(THREE, { world: 'irdorath', nodeId: 0 })).toBe(false);
    expect(hasLocation(THREE, { world: 'valley', nodeId: 1e9 })).toBe(false);
    expect(() => getManifest(THREE, 'irdorath')).toThrow(/world "irdorath" is not loaded \(khorinis, valley, jharkendar\)/);
    expect(() => getNodeAt(THREE, { world: 'valley', nodeId: -1 })).toThrow(/does not exist/);
    expect(sameLocation(loc, { world: 'valley', nodeId: 2045 })).toBe(true);
    expect(sameLocation(loc, { world: 'khorinis', nodeId: 2045 })).toBe(false);
  });
});

describe('createStartPicker', () => {
  it('matches pickStarts and reports the remaining count', () => {
    for (const mode of MODES) {
      const picker = createStartPicker(khorinis, mode, createRng(77));
      const total = usableStartCount(khorinis, mode);
      expect(picker.remaining()).toBe(total);
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) ids.push(picker.next()!);
      expect(ids).toEqual(pickStarts(khorinis, 77, 5, mode));
      expect(picker.remaining()).toBe(total - 5);
    }
    const two = createStartPicker(tiny('t', 2), 'mixed', createRng(1));
    expect(new Set([two.next(), two.next()])).toEqual(new Set([0, 1]));
    expect(two.remaining()).toBe(0);
    expect(two.next()).toBeNull();
  });
});

describe('pickRounds', () => {
  it('is deterministic for (seed, settings) and changes with the seed, the mode and the worlds', () => {
    const a = pickRounds(THREE, settings({ seed: 42 }));
    expect(a).toHaveLength(ROUNDS_PER_GAME);
    expect(pickRounds(THREE, settings({ seed: 42 }))).toEqual(a);
    expect(pickRounds(THREE, settings({ seed: 43 }))).not.toEqual(a);
    expect(pickRounds(THREE, settings({ seed: 42, mode: 'hardcore' }))).not.toEqual(a);
    expect(pickRounds(THREE, settings({ seed: 42, worlds: ['khorinis', 'valley'] }))).not.toEqual(a);
    for (const l of a) {
      expect(ALL).toContain(l.world);
      expect(getManifest(THREE, l.world).starts).toContain(l.nodeId);
    }
  });

  it('never repeats a node within a game and respects the mode inside each world', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rounds = pickRounds(THREE, settings({ seed, mode: 'classic' }));
      expect(new Set(rounds.map(key)).size).toBe(ROUNDS_PER_GAME);
      for (const l of rounds) expect(getNodeAt(THREE, l).outdoor, `seed ${seed} ${key(l)}`).toBe(true);
    }
    // Same node id in two worlds is fine (ids are per world); the same (world, id) never is.
    const many = pickRounds(THREE, settings({ seed: 5, mode: 'hardcore' }), 3 * khorinis.starts.length);
    expect(many).toHaveLength(3 * khorinis.starts.length);
    expect(new Set(many.map(key)).size).toBe(many.length);
  });

  it('draws the world uniformly: ~1/3 of the rounds per world over many seeds', () => {
    const counts: Record<string, number> = { khorinis: 0, valley: 0, jharkendar: 0 };
    const seeds = 1500;
    for (let seed = 1; seed <= seeds; seed++) for (const l of pickRounds(THREE, settings({ seed }))) counts[l.world]!++;
    const total = seeds * ROUNDS_PER_GAME;
    for (const slug of ALL) {
      const share = counts[slug]! / total;
      expect(share, slug).toBeGreaterThan(0.3);
      expect(share, slug).toBeLessThan(0.37);
    }
    // Every world appears in most games; a game with a single world is rare but legal.
    let allThree = 0;
    for (let seed = 1; seed <= 300; seed++) {
      if (new Set(pickRounds(THREE, settings({ seed })).map((l) => l.world)).size === 3) allThree++;
    }
    expect(allThree).toBeGreaterThan(150);
  });

  it('two enabled worlds: ~1/2 each, the third never', () => {
    const counts: Record<string, number> = { khorinis: 0, valley: 0, jharkendar: 0 };
    for (let seed = 1; seed <= 1000; seed++) {
      for (const l of pickRounds(THREE, settings({ seed, worlds: ['valley', 'khorinis'] }))) counts[l.world]!++;
    }
    expect(counts.jharkendar).toBe(0);
    expect(counts.khorinis! / 5000).toBeGreaterThan(0.45);
    expect(counts.valley! / 5000).toBeGreaterThan(0.45);
  });

  it('a single enabled world reproduces the stage-1 picks of pickStarts', () => {
    for (const mode of MODES) {
      for (const seed of [1, 2, 3, 2024]) {
        const rounds = pickRounds(THREE, settings({ seed, mode, worlds: ['valley'] }));
        expect(rounds.map((l) => l.world)).toEqual(['valley', 'valley', 'valley', 'valley', 'valley']);
        expect(rounds.map((l) => l.nodeId)).toEqual(pickStarts(khorinis, seed, 5, mode));
      }
    }
  });

  it('falls back to the other worlds when one runs out of starts (synthetic manifests)', () => {
    // "small" has 1 start, "mid" 2, "big" 10: a 5-round game needs the fallback for most seeds.
    const w = worldsOf(tiny('small', 1), tiny('mid', 2), tiny('big', 10, [], 10));
    const s = settings({ worlds: ['small', 'mid', 'big'] });
    expect(usableRoundCount(w, s)).toBe(13);
    for (let seed = 1; seed <= 100; seed++) {
      const rounds = pickRounds(w, { ...s, seed });
      expect(rounds).toHaveLength(5);
      expect(new Set(rounds.map(key)).size).toBe(5);
      expect(rounds.filter((l) => l.world === 'small').length).toBeLessThanOrEqual(1);
      expect(rounds.filter((l) => l.world === 'mid').length).toBeLessThanOrEqual(2);
    }
    // The small worlds are still drawn: over many seeds "small" shows up in most games.
    let smallSeen = 0;
    for (let seed = 1; seed <= 100; seed++) if (pickRounds(w, { ...s, seed }).some((l) => l.world === 'small')) smallSeen++;
    expect(smallSeen).toBeGreaterThan(50);

    // Everything exhausted: shorter game, every start used exactly once.
    const all = pickRounds(w, { ...s, seed: 3 }, 50);
    expect(all).toHaveLength(13);
    expect(new Set(all.map(key)).size).toBe(13);

    // Classic on a world without outdoor starts: that world contributes nothing, the game goes on.
    const caves = worldsOf(tiny('caves', 4, [0, 1, 2, 3]), tiny('open', 6));
    const classic = settings({ worlds: ['caves', 'open'], mode: 'classic' });
    expect(usableRoundCount(caves, classic)).toBe(6);
    expect(pickRounds(caves, classic).every((l) => l.world === 'open')).toBe(true);
    expect(pickRounds(caves, { ...classic, mode: 'hardcore' }, 10)).toHaveLength(10);
  });

  it('ignores enabled slugs that are not loaded and throws when none is', () => {
    const rounds = pickRounds(THREE, settings({ worlds: ['irdorath', 'valley'] }));
    expect(rounds.every((l) => l.world === 'valley')).toBe(true);
    expect(() => pickRounds(THREE, settings({ worlds: ['irdorath'] }))).toThrow(/none of the enabled worlds \(irdorath\) is loaded/);
    expect(() => pickRounds(THREE, settings({ worlds: [] }))).toThrow(/none of the enabled worlds/);
  });
});

describe('GameState across worlds', () => {
  it('plays rounds in the picked worlds and scores a wrong-world guess with 0', () => {
    const s = settings({ seed: 42, noMove: true, noLook: true });
    const expected = pickRounds(THREE, s);
    const g = new GameState(THREE, s);
    expect(g.settings).toEqual(s);
    expect(g.settings).not.toBe(s);
    expect(g.enabledWorlds).toEqual(ALL);
    expect(g.totalRounds).toBe(5);
    expect(() => g.manifest).toThrow(/no active round/);
    const wrongWorldOf = (world: string): string => ALL.find((w) => w !== world)!;

    for (let i = 0; i < 5; i++) {
      const r = g.startNextRound();
      expect({ world: r.world, nodeId: r.startNodeId }).toEqual(expected[i]);
      expect(g.startLocation).toEqual(expected[i]);
      expect(g.currentLocation).toEqual(expected[i]);
      expect(g.manifest.world).toBe(r.world);
      expect(r.answer).toEqual(locationCoords(THREE, expected[i]!));

      if (i % 2 === 0) {
        // Right world, 155 m off.
        g.setGuess({ world: r.world, x: r.answer.x + 15_500, z: r.answer.z });
        const res = g.submitGuess();
        expect(res).toMatchObject({ round: i + 1, guessWorld: r.world, answerWorld: r.world, answerNodeId: r.startNodeId, score: 1835 });
        expect(res.distanceM).toBeCloseTo(155, 6);
      } else {
        // Wrong world, exactly on the answer's coordinates: still 0.
        const other = wrongWorldOf(r.world);
        g.setGuess({ world: other, x: r.answer.x, z: r.answer.z });
        expect(g.round.guess).toEqual({ world: other, x: r.answer.x, z: r.answer.z });
        const res = g.submitGuess();
        expect(res).toEqual({
          round: i + 1,
          guess: { world: other, x: r.answer.x, z: r.answer.z },
          answer: r.answer,
          guessWorld: other,
          answerWorld: r.world,
          answerNodeId: r.startNodeId,
          distanceM: null,
          score: 0,
        });
      }
    }
    expect(g.score).toBe(1835 * 3);
    const summary = g.finish();
    expect(summary.settings).toEqual(s);
    expect(summary.seed).toBe(42);
    expect(summary.mode).toBe('mixed');
    expect(summary.rounds.map((r) => r.answerWorld)).toEqual(expected.map((l) => l.world));
    expect(summary.total).toBe(1835 * 3);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('validates movement against the round world and snapshots the settings', () => {
    const g = new GameState(THREE, settings({ seed: 7 }));
    const r = g.startNextRound();
    const next = getNodeAt(THREE, g.startLocation).links[0]!.to;
    g.setCurrentNode(next);
    expect(g.currentLocation).toEqual({ world: r.world, nodeId: next });
    expect(() => g.setCurrentNode(1e9)).toThrow(new RegExp(`unknown node 1000000000 in world "${r.world}"`));
    g.returnToStart();
    expect(g.round.visited).toBe(3);
    const snap = g.getSnapshot();
    expect(snap.settings).toEqual(settings({ seed: 7 }));
    expect(snap.round?.world).toBe(r.world);
    expect(snap.mode).toBe('mixed');
  });

  it('reduces the settings to the loaded worlds and fails when none is loaded', () => {
    const two = worldsOf(khorinis, cloneAs('jharkendar'));
    const g = new GameState(two, settings({ seed: 3, worlds: ['valley', 'jharkendar', 'khorinis', 'khorinis'] }));
    expect(g.enabledWorlds).toEqual(['jharkendar', 'khorinis']);
    expect(g.settings.worlds).toEqual(['jharkendar', 'khorinis']);
    for (let i = 0; i < 5; i++) {
      const r = g.startNextRound();
      expect(['jharkendar', 'khorinis']).toContain(r.world);
      g.setGuess({ world: 'khorinis', x: 0, z: 0 });
      g.submitGuess();
    }
    expect(() => new GameState(two, settings({ worlds: ['valley'] }))).toThrow(/none of the enabled worlds \(valley\) is loaded/);
    expect(() => new GameState(two, settings({ worlds: [] }))).toThrow(/none of the enabled worlds/);
    // nolook → nomove is applied on the way in.
    expect(new GameState(two, settings({ noLook: true })).settings).toMatchObject({ noMove: true, noLook: true });
  });

  it('plays fewer rounds when the enabled worlds have too few starts, and the round count can be set', () => {
    const w = worldsOf(tiny('a', 2), tiny('b', 1));
    const g = new GameState(w, settings({ worlds: ['a', 'b'] }));
    expect(g.totalRounds).toBe(3);
    expect(new GameState(w, settings({ worlds: ['a', 'b'] }), 2).totalRounds).toBe(2);
    expect(() => new GameState(worldsOf(tiny('c', 3, [0, 1, 2])), settings({ worlds: ['c'], mode: 'classic' }))).toThrow(
      /no starts for mode "classic" in c/,
    );
  });

  it('stage-1 constructor form equals the multi-world form with one world', () => {
    const legacy = new GameState(khorinis, 99, 'hardcore');
    const modern = new GameState(worldsOf(khorinis), settings({ seed: 99, mode: 'hardcore', worlds: ['khorinis'] }));
    expect(legacy.settings).toEqual(modern.settings);
    const a = legacy.startNextRound();
    const b = modern.startNextRound();
    expect(a).toEqual(b);
    expect(a.startNodeId).toBe(pickStarts(khorinis, 99, 5, 'hardcore')[0]);
  });
});
