/**
 * Game state machine: idle → round(n) → result(n) → … → summary (SPEC.md sections 6 and 9).
 *
 * Stage 2: a game spans several worlds. The session settings ({@link GameSettings}: seed, mode,
 * enabled worlds, No move / No look) are carried in the URL (`settingsFromUrl` /
 * `settingsToSearch`), round picking draws a world per round and then a start inside it
 * (`pickRounds`), locations are `{world, nodeId}` and guesses `{world, x, z}`.
 */
import type {
  GameCoords,
  GameMode,
  GameSettings,
  GameSummary,
  Location,
  Manifest,
  RoundResult,
  WorldGuess,
} from '../contracts';

export type { GameMode, GameSettings, Location, WorldGuess } from '../contracts';
import { getManifest, getNode, hasNode, nodeCoords } from './graph';
import type { WorldManifests } from './graph';
import { scoreForGuess, totalScore } from './scoring';

export const ROUNDS_PER_GAME = 5;

export type GamePhase = 'idle' | 'round' | 'result' | 'summary';

export interface RoundState {
  /** 1-based round number. */
  round: number;
  /** Slug of the world this round is played in; `startNodeId`/`currentNodeId` are ids in it. */
  world: string;
  startNodeId: number;
  currentNodeId: number;
  /** Guess placed on the map (any world's tab), or null until the player clicks. */
  guess: WorldGuess | null;
  /** Position of the start node in `world`'s game coordinates. */
  answer: GameCoords;
  /** Number of nodes visited this round (start counts as 1). */
  visited: number;
}

/** Plain, serialisable view of the whole game for the UI. Fresh object on every call. */
export interface GameSnapshot {
  phase: GamePhase;
  seed: number;
  mode: GameMode;
  /** Session settings the game was created with (worlds reduced to the loaded ones). */
  settings: GameSettings;
  /** Number of rounds this game will have (normally {@link ROUNDS_PER_GAME}). */
  totalRounds: number;
  /** Current round, or null in `idle` / `summary`. */
  round: RoundState | null;
  /** Finished rounds, in order. */
  results: RoundResult[];
  /** Sum of finished round scores. */
  score: number;
}

// ---------------------------------------------------------------------------------------------
// PRNG and seeds
// ---------------------------------------------------------------------------------------------

/** Largest seed value; seeds are 32-bit unsigned integers. */
export const MAX_SEED = 0xffffffff;

/** mulberry32: small deterministic PRNG returning floats in [0, 1). The seed is taken mod 2^32. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh random seed in [1, MAX_SEED]. */
export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * MAX_SEED);
}

/**
 * Parse a seed typed by the player or taken from a URL: 1–10 digits, at most {@link MAX_SEED}.
 * Returns null for anything else (empty, letters, exponent notation, out of range).
 */
export function parseSeed(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const seed = Number(text);
  return seed <= MAX_SEED ? seed : null;
}

/**
 * Parse `?seed=` from a query string, `URLSearchParams` or full URL. Returns null when absent or
 * not a valid seed (see {@link parseSeed}).
 */
export function seedFromUrl(source: string | URLSearchParams | URL): number | null {
  const raw = paramsOf(source).get('seed');
  return raw === null ? null : parseSeed(raw);
}

// ---------------------------------------------------------------------------------------------
// Game modes
// ---------------------------------------------------------------------------------------------

export const DEFAULT_MODE: GameMode = 'mixed';

/** Share of rounds that start indoors in `mixed` mode (per-round draw, see {@link createStartPicker}). */
export const MIXED_INDOOR_SHARE = 0.35;

export interface GameModeInfo {
  id: GameMode;
  label: string;
  description: string;
}

/** The three modes in display order. */
export const GAME_MODES: GameModeInfo[] = [
  { id: 'classic', label: 'Classic', description: 'Open-air spots only: roads, fields, city streets.' },
  {
    id: 'mixed',
    label: 'Mixed',
    description: 'Mostly open air; roughly every third round starts under a roof, in a cave or deep in the woods.',
  },
  { id: 'hardcore', label: 'Hardcore', description: 'Any spot at all, including caves, cellars and houses.' },
];

/** Label of a mode for display ("Classic", "Mixed", "Hardcore"). */
export function modeLabel(mode: GameMode): string {
  return GAME_MODES.find((m) => m.id === mode)?.label ?? mode;
}

/** Parse a mode id typed by the player or taken from a URL (case-insensitive). Null for anything else. */
export function parseMode(raw: string | null): GameMode | null {
  if (raw === null) return null;
  const text = raw.trim().toLowerCase();
  return GAME_MODES.find((m) => m.id === text)?.id ?? null;
}

/** Parse `?mode=` from a query string, `URLSearchParams` or full URL; null when absent or unknown. */
export function modeFromUrl(source: string | URLSearchParams | URL): GameMode | null {
  return parseMode(paramsOf(source).get('mode'));
}

/** Accept "?a=1", "a=1", full URLs, `URL` and `URLSearchParams`; drops the fragment first. */
function paramsOf(source: string | URLSearchParams | URL): URLSearchParams {
  if (source instanceof URLSearchParams) return source;
  if (source instanceof URL) return source.searchParams;
  const noHash = source.split('#')[0] ?? '';
  const q = noHash.indexOf('?');
  return new URLSearchParams(q >= 0 ? noHash.slice(q) : noHash);
}

// ---------------------------------------------------------------------------------------------
// Session settings (SPEC.md section 9.2) and their URL form
// ---------------------------------------------------------------------------------------------

/** Query parameter names of the replay URL. */
export const SETTINGS_PARAMS = ['seed', 'mode', 'worlds', 'nomove', 'nolook'] as const;

/**
 * Settings as found in a URL: `null` where a parameter is absent or unusable, so the start
 * screen can tell "not given" from "given". `noLook` already implies `noMove` here.
 */
export interface UrlSettings {
  seed: number | null;
  mode: GameMode | null;
  /** Enabled slugs, or null when `worlds` is absent, empty or has no known slug (= all). */
  worlds: string[] | null;
  noMove: boolean;
  noLook: boolean;
}

/** Fields that may be left out or null when resolving settings; see {@link resolveSettings}. */
export type PartialSettings = {
  seed?: number | null;
  mode?: GameMode | null;
  worlds?: readonly string[] | null;
  noMove?: boolean;
  noLook?: boolean;
};

/**
 * Read `?seed=…&mode=…&worlds=a,b&nomove=1&nolook=1` (SPEC.md section 9.2). Rules:
 * - `seed` / `mode` as {@link seedFromUrl} / {@link modeFromUrl} (null when absent or invalid);
 * - `worlds` is a comma-separated list, case-insensitive, deduplicated; when `availableSlugs`
 *   is given, unknown slugs are dropped and the rest is ordered like `availableSlugs`; an empty
 *   result means "all" and is returned as null;
 * - `nomove` / `nolook` are flags (`1`, `true`, `yes`, `on`); `nolook` implies `nomove`.
 */
export function settingsFromUrl(source: string | URLSearchParams | URL, availableSlugs?: readonly string[]): UrlSettings {
  const params = paramsOf(source);
  const noLook = parseFlag(params.get('nolook'));
  const noMove = noLook || parseFlag(params.get('nomove'));
  const rawWorlds = params.get('worlds');
  const worlds = rawWorlds === null ? null : normaliseWorlds(rawWorlds.split(','), availableSlugs);
  return {
    seed: seedFromUrl(params),
    mode: modeFromUrl(params),
    worlds: worlds && worlds.length > 0 ? worlds : null,
    noMove,
    noLook,
  };
}

/**
 * Turn partial settings (from the URL or the start screen) into complete, normalised
 * {@link GameSettings}: a missing seed gets {@link randomSeed}, a missing mode
 * {@link DEFAULT_MODE}, missing/empty worlds become all `availableSlugs`; unknown slugs are
 * dropped, the rest ordered like `availableSlugs`; `noLook` forces `noMove`. Throws when
 * `availableSlugs` is empty (nothing to play).
 */
export function resolveSettings(partial: PartialSettings, availableSlugs: readonly string[]): GameSettings {
  if (availableSlugs.length === 0) throw new Error('settings: no worlds available');
  const noLook = partial.noLook === true;
  let worlds = normaliseWorlds(partial.worlds ?? [], availableSlugs);
  if (worlds.length === 0) worlds = [...availableSlugs];
  return {
    seed: (partial.seed ?? randomSeed()) >>> 0,
    mode: partial.mode ?? DEFAULT_MODE,
    worlds,
    noMove: noLook || partial.noMove === true,
    noLook,
  };
}

/**
 * Query string that replays a game: `?seed=1&mode=mixed&worlds=khorinis,valley&nomove=1&nolook=1`.
 * `worlds` is left out when `allSlugs` is given and the settings enable every one of them;
 * `nomove`/`nolook` are left out when off. Always starts with `?`.
 */
export function settingsToSearch(settings: GameSettings, allSlugs?: readonly string[]): string {
  const params = new URLSearchParams();
  applySettingsToParams(params, settings, allSlugs);
  return `?${params.toString()}`;
}

/**
 * Write the settings into existing query parameters (keeps unrelated ones, removes stale
 * `worlds`/`nomove`/`nolook`). Same omission rules as {@link settingsToSearch}. Returns `params`.
 */
export function applySettingsToParams(params: URLSearchParams, settings: GameSettings, allSlugs?: readonly string[]): URLSearchParams {
  for (const key of SETTINGS_PARAMS) params.delete(key);
  params.set('seed', String(settings.seed >>> 0));
  params.set('mode', settings.mode);
  const worlds = allSlugs ? normaliseWorlds(settings.worlds, allSlugs) : [...new Set(settings.worlds)];
  const isAll = allSlugs !== undefined && worlds.length === allSlugs.length && allSlugs.every((s) => worlds.includes(s));
  if (!isAll && worlds.length > 0) params.set('worlds', worlds.join(','));
  const noLook = settings.noLook;
  if (settings.noMove || noLook) params.set('nomove', '1');
  if (noLook) params.set('nolook', '1');
  return params;
}

/** True for `1`, `true`, `yes`, `on` (case-insensitive, trimmed); false for anything else or null. */
export function parseFlag(raw: string | null): boolean {
  if (raw === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Trim, lowercase and deduplicate slugs; with `availableSlugs`, drop the unknown ones and order
 * the result like `availableSlugs` (= worlds.json order, which is also the map tab order).
 */
function normaliseWorlds(raw: readonly string[], availableSlugs?: readonly string[]): string[] {
  const wanted = [...new Set(raw.map((s) => s.trim().toLowerCase()).filter((s) => s !== ''))];
  if (!availableSlugs) return wanted;
  return availableSlugs.filter((s) => wanted.includes(s));
}

// ---------------------------------------------------------------------------------------------
// Start picking inside one world
// ---------------------------------------------------------------------------------------------

/** Fisher–Yates shuffle in place with the given RNG; returns the same array. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Hands out start node ids of one world one at a time, never repeating; see {@link createStartPicker}. */
export interface StartPicker {
  /** Next unused start id, or null when the usable pool is exhausted. */
  next(): number | null;
  /** How many more ids `next()` can return. */
  remaining(): number;
}

/**
 * Prepare the start pools of `manifest` for a game `mode` (SPEC.md section 6) with the given RNG:
 * the starts split into an outdoor pool (`node.outdoor === true`) and an indoor pool (the rest:
 * caves, cellars, houses, dense canopy), each shuffled with `rng` up front, then:
 * - `classic`: outdoor pool only, in shuffled order;
 * - `hardcore`: all starts shuffled together;
 * - `mixed`: per `next()` a draw `r = rng()`; `r < MIXED_INDOOR_SHARE` takes the next unused
 *   indoor id, otherwise the next unused outdoor id; an exhausted pool falls back to the other one.
 *
 * The RNG is consumed in a fixed order, so the sequence is deterministic for (rng state, mode,
 * manifest).
 */
export function createStartPicker(manifest: Manifest, mode: GameMode, rng: () => number): StartPicker {
  const all = [...new Set(manifest.starts)];
  if (mode === 'hardcore') {
    const pool = shuffle(all, rng);
    let k = 0;
    return { next: () => (k < pool.length ? pool[k++]! : null), remaining: () => pool.length - k };
  }
  const outdoor = shuffle(
    all.filter((id) => manifest.nodes[id]?.outdoor === true),
    rng,
  );
  const indoor = shuffle(
    all.filter((id) => manifest.nodes[id]?.outdoor !== true),
    rng,
  );
  let o = 0;
  let i = 0;
  if (mode === 'classic') {
    return { next: () => (o < outdoor.length ? outdoor[o++]! : null), remaining: () => outdoor.length - o };
  }
  // mixed
  return {
    remaining: () => outdoor.length - o + (indoor.length - i),
    next: () => {
      const indoorLeft = i < indoor.length;
      const outdoorLeft = o < outdoor.length;
      if (!indoorLeft && !outdoorLeft) return null;
      const wantIndoor = rng() < MIXED_INDOOR_SHARE;
      if ((wantIndoor && indoorLeft) || !outdoorLeft) return indoor[i++]!;
      return outdoor[o++]!;
    },
  };
}

/**
 * Pick `count` distinct start node ids from `manifest.starts` for a game `mode`, using a fresh
 * RNG seeded with `seed` (single-world form; rules in {@link createStartPicker}). Deterministic
 * for (seed, mode, manifest); never repeats an id.
 *
 * Throws when fewer than `count` usable ids exist in total (for `classic`: in the outdoor pool).
 */
export function pickStarts(manifest: Manifest, seed: number, count = ROUNDS_PER_GAME, mode: GameMode = DEFAULT_MODE): number[] {
  const available = usableStartCount(manifest, mode);
  if (count > available) {
    const what = mode === 'classic' ? 'outdoor starts' : 'starts';
    throw new Error(`state: need ${count} ${what} but the manifest has ${available}`);
  }
  const picker = createStartPicker(manifest, mode, createRng(seed));
  const picked: number[] = [];
  while (picked.length < count) {
    const id = picker.next();
    if (id === null) break;
    picked.push(id);
  }
  return picked;
}

/** Number of starts {@link createStartPicker} can hand out for a mode (its usable pool size). */
export function usableStartCount(manifest: Manifest, mode: GameMode): number {
  const all = new Set(manifest.starts);
  if (mode !== 'classic') return all.size;
  let n = 0;
  for (const id of all) if (manifest.nodes[id]?.outdoor === true) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Round picking across worlds (SPEC.md section 9.3)
// ---------------------------------------------------------------------------------------------

/** The settings {@link pickRounds} depends on (the toggles do not influence the draw). */
export type RoundPickSettings = Pick<GameSettings, 'seed' | 'mode' | 'worlds'>;

/**
 * Pick the rounds of a game: for each round a world is drawn uniformly among the enabled worlds
 * that still have an unused start for `mode`, then that world's {@link createStartPicker} hands
 * out the start. Deterministic for (`settings.seed`, `settings.mode`, `settings.worlds`,
 * manifests); never repeats a node within a game. A world with fewer usable starts than its
 * share simply stops being drawn once exhausted (the fallback of §9.3), and when every enabled
 * world is exhausted the game is shorter than `count`.
 *
 * With a single enabled world no world draw happens, so the picks equal
 * `pickStarts(manifest, seed, count, mode)` and stage-1 links replay unchanged.
 *
 * Slugs in `settings.worlds` that are not in `worlds` are ignored; throws when none is left.
 */
export function pickRounds(worlds: WorldManifests, settings: RoundPickSettings, count = ROUNDS_PER_GAME): Location[] {
  const enabled = [...new Set(settings.worlds)].filter((slug) => worlds.has(slug));
  if (enabled.length === 0) {
    throw new Error(`state: none of the enabled worlds (${settings.worlds.join(', ') || 'none'}) is loaded`);
  }
  const rng = createRng(settings.seed);
  const pickers = enabled.map((slug) => ({ slug, picker: createStartPicker(getManifest(worlds, slug), settings.mode, rng) }));
  const rounds: Location[] = [];
  while (rounds.length < count) {
    const open = pickers.filter((p) => p.picker.remaining() > 0);
    if (open.length === 0) break;
    const chosen = open.length === 1 ? open[0]! : open[Math.floor(rng() * open.length)]!;
    const nodeId = chosen.picker.next();
    if (nodeId === null) break; // cannot happen: remaining() > 0
    rounds.push({ world: chosen.slug, nodeId });
  }
  return rounds;
}

/** Total starts {@link pickRounds} can hand out for the enabled, loaded worlds. */
export function usableRoundCount(worlds: WorldManifests, settings: RoundPickSettings): number {
  let n = 0;
  for (const slug of new Set(settings.worlds)) {
    const entry = worlds.get(slug);
    if (entry) n += usableStartCount(entry.manifest, settings.mode);
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------------------------

export class GameState {
  private readonly worlds: WorldManifests;
  private readonly settings_: GameSettings;
  private readonly starts: Location[];
  private phase_: GamePhase = 'idle';
  private round_: RoundState | null = null;
  private readonly results: RoundResult[] = [];
  readonly seed: number;

  /**
   * Prepare a game of {@link ROUNDS_PER_GAME} rounds (fewer only when the enabled worlds have
   * fewer usable starts for the mode) over the loaded `worlds` (the map of `loadWorlds()`, or any
   * `Map<slug, {manifest}>`). `settings.worlds` is reduced to the loaded slugs; throws when none
   * is loaded or no start exists for the mode. Nothing happens until {@link startNextRound}.
   */
  constructor(worlds: WorldManifests, settings: GameSettings, rounds?: number);
  /**
   * Stage-1 form: one world, `seed` and `mode`. Equivalent to the multi-world form with
   * `worlds = [manifest.world]` and the toggles off. Kept so stage-1 callers compile.
   */
  constructor(manifest: Manifest, seed: number, mode?: GameMode, rounds?: number);
  constructor(first: WorldManifests | Manifest, second: GameSettings | number, third?: GameMode | number, fourth?: number) {
    let worlds: WorldManifests;
    let settings: GameSettings;
    let rounds: number;
    if (first instanceof Map) {
      worlds = first as WorldManifests;
      const given = second as GameSettings;
      const loaded = [...new Set(given.worlds)].filter((slug) => worlds.has(slug));
      if (loaded.length === 0) {
        throw new Error(`state: none of the enabled worlds (${given.worlds.join(', ') || 'none'}) is loaded`);
      }
      settings = resolveSettings({ ...given, worlds: loaded }, loaded);
      rounds = typeof third === 'number' ? third : ROUNDS_PER_GAME;
    } else {
      const manifest = first as Manifest;
      worlds = new Map<string, { manifest: Manifest }>([[manifest.world, { manifest }]]);
      settings = resolveSettings(
        { seed: second as number, mode: typeof third === 'string' ? third : DEFAULT_MODE, worlds: [manifest.world] },
        [manifest.world],
      );
      rounds = fourth ?? ROUNDS_PER_GAME;
    }
    this.worlds = worlds;
    this.settings_ = settings;
    this.seed = settings.seed;
    const count = Math.min(rounds, usableRoundCount(worlds, settings));
    if (count < 1) throw new Error(`state: no starts for mode "${settings.mode}" in ${settings.worlds.join(', ')}`);
    this.starts = pickRounds(worlds, settings, count);
  }

  get phase(): GamePhase {
    return this.phase_;
  }

  /** Game mode this game was created with. */
  get mode(): GameMode {
    return this.settings_.mode;
  }

  /** Session settings (copy); `worlds` holds only loaded slugs. */
  get settings(): GameSettings {
    return { ...this.settings_, worlds: [...this.settings_.worlds] };
  }

  /** Slugs of the worlds this game draws from, in settings order. */
  get enabledWorlds(): string[] {
    return [...this.settings_.worlds];
  }

  /** Number of rounds in this game. */
  get totalRounds(): number {
    return this.starts.length;
  }

  /** Current round state; throws unless phase is 'round' or 'result'. */
  get round(): RoundState {
    if (!this.round_) throw new Error(`state: no active round in phase "${this.phase_}"`);
    return this.round_;
  }

  /** Manifest of the current round's world; throws unless a round is active. */
  get manifest(): Manifest {
    return this.manifestOf(this.round.world);
  }

  /** Manifest of a loaded world by slug; throws for an unknown slug. */
  manifestOf(world: string): Manifest {
    return getManifest(this.worlds, world);
  }

  /** Start node of the current round as a location. */
  get startLocation(): Location {
    const r = this.round;
    return { world: r.world, nodeId: r.startNodeId };
  }

  /** Where the player currently stands. */
  get currentLocation(): Location {
    const r = this.round;
    return { world: r.world, nodeId: r.currentNodeId };
  }

  /** Sum of finished round scores. */
  get score(): number {
    return totalScore(this.results);
  }

  /** Finished rounds so far (copy). */
  get rounds(): RoundResult[] {
    return [...this.results];
  }

  /** Plain copy of everything the UI needs. */
  getSnapshot(): GameSnapshot {
    return {
      phase: this.phase_,
      seed: this.seed,
      mode: this.settings_.mode,
      settings: this.settings,
      totalRounds: this.totalRounds,
      round: this.round_ ? { ...this.round_, guess: this.round_.guess && { ...this.round_.guess }, answer: { ...this.round_.answer } } : null,
      results: this.results.map((r) => ({ ...r, guess: { ...r.guess }, answer: { ...r.answer } })),
      score: this.score,
    };
  }

  /** idle/result → round. Returns the new round state. Throws after the last round. */
  startNextRound(): RoundState {
    if (this.phase_ !== 'idle' && this.phase_ !== 'result') {
      throw new Error(`state: cannot start a round in phase "${this.phase_}"`);
    }
    const index = this.results.length;
    if (index >= this.starts.length) throw new Error('state: all rounds have been played');
    const start = this.starts[index]!;
    this.round_ = {
      round: index + 1,
      world: start.world,
      startNodeId: start.nodeId,
      currentNodeId: start.nodeId,
      guess: null,
      answer: nodeCoords(getNode(this.manifestOf(start.world), start.nodeId)),
      visited: 1,
    };
    this.phase_ = 'round';
    return this.round_;
  }

  /** Record the player's movement inside the round's world (keeps `currentNodeId`/`visited` up to date). */
  setCurrentNode(nodeId: number): void {
    const r = this.requireRound('round');
    if (!hasNode(this.manifestOf(r.world), nodeId)) throw new Error(`state: unknown node ${nodeId} in world "${r.world}"`);
    if (nodeId === r.currentNodeId) return;
    r.currentNodeId = nodeId;
    r.visited += 1;
  }

  /** "Return to start": same as {@link setCurrentNode} with the round's start node. */
  returnToStart(): void {
    this.setCurrentNode(this.requireRound('round').startNodeId);
  }

  /**
   * Place, move or clear the guess. A guess without `world` is taken to be on the round's own
   * world (stage-1 callers). Throws when the guess names a world that is not loaded.
   */
  setGuess(guess: (GameCoords & { world?: string }) | null): void {
    const r = this.requireRound('round');
    if (!guess) {
      r.guess = null;
      return;
    }
    const world = guess.world ?? r.world;
    if (!this.worlds.has(world)) throw new Error(`state: guess on unknown world "${world}"`);
    r.guess = { world, x: guess.x, z: guess.z };
  }

  /** round → result. Computes distance and score (0 and `distanceM: null` for a wrong world). Throws without a guess. */
  submitGuess(): RoundResult {
    const r = this.requireRound('round');
    if (!r.guess) throw new Error('state: no guess placed');
    const answer: Location = { world: r.world, nodeId: r.startNodeId };
    const { distanceM, score } = scoreForGuess(r.guess, answer, this.manifestOf(r.world));
    const result: RoundResult = {
      round: r.round,
      guess: { ...r.guess },
      answer: { ...r.answer },
      guessWorld: r.guess.world,
      answerWorld: r.world,
      answerNodeId: r.startNodeId,
      distanceM,
      score,
    };
    this.results.push(result);
    this.phase_ = 'result';
    return result;
  }

  /** True when the finished round was the last one. */
  isLastRound(): boolean {
    return this.round_ !== null && this.round_.round >= this.starts.length;
  }

  /** result(last) → summary. */
  finish(): GameSummary {
    if (this.phase_ !== 'result' || !this.isLastRound()) {
      throw new Error(`state: cannot finish in phase "${this.phase_}" at round ${this.round_?.round ?? 0}`);
    }
    this.phase_ = 'summary';
    this.round_ = null;
    return { seed: this.seed, mode: this.settings_.mode, settings: this.settings, rounds: this.rounds, total: this.score };
  }

  private requireRound(phase: GamePhase): RoundState {
    if (this.phase_ !== phase) throw new Error(`state: expected phase "${phase}", got "${this.phase_}"`);
    return this.round;
  }
}
