/**
 * Problem reports (owner's request: players flag a bad panorama, a wrong translation, a bug; no replies, the admin
 * marks them resolved or ignored). Pure: validation of `POST /api/reports`, the location lookup through the core
 * {@link Repository} and the {@link WorldRegistry}, the rate-limit rules and the storage interface that
 * server/db/reports.ts implements. No `node:*` imports.
 *
 * Privacy: a location report names only the caller's own game; the server resolves the node (key, waypoint,
 * coordinates) and stores it for the admin. The player gets 204 and nothing else, so a report cannot be used to
 * probe where a round is. Banned players may report; their reports are flagged.
 */
import { LANGS, REPORT_CATEGORIES, REPORT_STATUSES, REPORT_TEXT_MAX, REPORT_TYPES } from '../../shared/api';
import type {
  AdminReportLocation,
  Lang,
  ReportCategory,
  ReportGameRef,
  ReportStatus,
  ReportType,
} from '../../shared/api';
import { ApiFailure } from './errors';
import type { RateLimitRule } from './ratelimit';
import type { Repository, RoundRecord } from './repository';
import { nodeByKey } from './worlds';
import type { WorldRegistry } from './worlds';

/** Reports per player and per client IP key (core/ip.ts). */
export const REPORT_LIMITS = {
  player: { limit: 10, windowMs: 60 * 60_000 },
  ip: { limit: 30, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/** Request bodies above this are refused before parsing (the API-wide cap is 32 KiB). */
export const REPORT_BODY_MAX = 8 * 1024;

const PATH_MAX = 200;
const UA_MAX = 300;
const APP_VERSION = /^[A-Za-z0-9._+-]{1,64}$/;
const GAME_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NODE_KEY = /^[a-z0-9]{6,32}$/;
const MAX_ROUND = 1000;
const MAX_VIEWPORT = 100_000;

/** A validated report, before the location is resolved. */
export interface ReportInput {
  type: ReportType;
  text: string;
  categories: ReportCategory[];
  game: ReportGameRef | null;
  lang: Lang | null;
  path: string | null;
  viewport: string | null;
  appVersion: string | null;
}

/** Location columns of a stored report (see {@link AdminReportLocation}). */
export type ReportLocation = Omit<AdminReportLocation, 'panoPath'>;

export interface ReportRecord {
  id: number;
  at: number;
  type: ReportType;
  status: ReportStatus;
  statusAt: number | null;
  categories: ReportCategory[];
  text: string;
  playerId: string | null;
  nickname: string | null;
  flagged: boolean;
  location: ReportLocation | null;
  lang: string | null;
  path: string | null;
  userAgent: string | null;
  viewport: string | null;
  appVersion: string | null;
}

export type NewReport = Omit<ReportRecord, 'id' | 'status' | 'statusAt'>;

export interface ReportFilter {
  status?: ReportStatus;
  type?: ReportType;
  world?: string;
  /** Only ids below this (paging, newest first). */
  before?: number;
}

/** Storage of reports (server/db/reports.ts). Synchronous like the admin store: only the Node server uses it. */
export interface ReportStore {
  insert(r: NewReport): number;
  get(id: number): ReportRecord | null;
  /** Newest first, at most `limit`. */
  list(filter: ReportFilter, limit: number): ReportRecord[];
  count(filter: Omit<ReportFilter, 'before'>): number;
  /** Count per status; open count per type. */
  counts(): { byStatus: Record<ReportStatus, number>; openByType: Record<ReportType, number> };
  /** False when the report does not exist. */
  setStatus(id: number, status: ReportStatus, at: number): boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const bad = (what: string): never => {
  throw new ApiFailure('bad_request', what);
};

/** Trim, normalise line breaks, drop control characters except newlines and tabs. */
export function cleanText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

export function isReportType(v: unknown): v is ReportType {
  return typeof v === 'string' && (REPORT_TYPES as readonly string[]).includes(v);
}

export function isReportStatus(v: unknown): v is ReportStatus {
  return typeof v === 'string' && (REPORT_STATUSES as readonly string[]).includes(v);
}

/** Validate a `POST /api/reports` body. Throws `bad_request`. */
export function parseReport(raw: unknown): ReportInput {
  if (!isObject(raw)) return bad('body');
  if (!isReportType(raw.type)) return bad('type');
  const type = raw.type;

  let text = '';
  if (raw.text !== undefined && raw.text !== null) {
    if (typeof raw.text !== 'string') return bad('text');
    text = cleanText(raw.text);
    if ([...text].length > REPORT_TEXT_MAX) return bad(`text longer than ${REPORT_TEXT_MAX}`);
  }

  let categories: ReportCategory[] = [];
  if (raw.categories !== undefined && raw.categories !== null) {
    if (!Array.isArray(raw.categories) || raw.categories.length > REPORT_CATEGORIES.length) return bad('categories');
    for (const c of raw.categories) {
      if (typeof c !== 'string' || !(REPORT_CATEGORIES as readonly string[]).includes(c)) return bad('categories');
    }
    categories = REPORT_CATEGORIES.filter((c) => (raw.categories as unknown[]).includes(c));
    if (categories.length > 0 && type !== 'location') return bad('categories are for location reports');
  }

  let game: ReportGameRef | null = null;
  if (raw.game !== undefined && raw.game !== null) {
    const g = raw.game;
    if (!isObject(g) || typeof g.gameId !== 'string' || !GAME_ID.test(g.gameId)) return bad('game');
    game = { gameId: g.gameId };
    if (g.round !== undefined && g.round !== null) {
      if (typeof g.round !== 'number' || !Number.isInteger(g.round) || g.round < 1 || g.round > MAX_ROUND) return bad('game.round');
      game.round = g.round;
    }
    if (g.key !== undefined && g.key !== null) {
      if (typeof g.key !== 'string' || !NODE_KEY.test(g.key)) return bad('game.key');
      game.key = g.key;
    }
    if (type !== 'location') game = null; // context of other types never needs the node
  }

  if (text === '' && !(type === 'location' && game !== null)) return bad('text required');

  let lang: Lang | null = null;
  let path: string | null = null;
  let viewport: string | null = null;
  let appVersion: string | null = null;
  if (raw.context !== undefined && raw.context !== null) {
    const ctx = raw.context;
    if (!isObject(ctx)) return bad('context');
    if (ctx.lang !== undefined && ctx.lang !== null) {
      if (!LANGS.includes(ctx.lang as Lang)) return bad('context.lang');
      lang = ctx.lang as Lang;
    }
    if (ctx.path !== undefined && ctx.path !== null) {
      if (typeof ctx.path !== 'string' || !ctx.path.startsWith('/')) return bad('context.path');
      path = (ctx.path.split(/[?#]/)[0] ?? '/').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, PATH_MAX) || '/';
    }
    if (ctx.viewport !== undefined && ctx.viewport !== null) {
      const v = ctx.viewport;
      const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_VIEWPORT;
      if (!isObject(v) || !ok(v.w) || !ok(v.h)) return bad('context.viewport');
      viewport = `${Math.round(v.w)}x${Math.round(v.h)}`;
    }
    if (ctx.appVersion !== undefined && ctx.appVersion !== null) {
      if (typeof ctx.appVersion !== 'string' || !APP_VERSION.test(ctx.appVersion)) return bad('context.appVersion');
      appVersion = ctx.appVersion;
    }
  }

  return { type, text, categories, game, lang, path, viewport, appVersion };
}

/** The User-Agent header, cleaned and truncated. */
export function cleanUserAgent(ua: string | undefined | null): string | null {
  if (!ua) return null;
  const clean = ua.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, UA_MAX);
  return clean || null;
}

/**
 * Resolve the panorama of a location report from the caller's own game (see {@link ReportGameRef}). Another player's
 * game, a round that was never opened and a key the player was not shown are all `not_found` (indistinguishable
 * from an unknown game id).
 */
export async function resolveReportLocation(
  repo: Pick<Repository, 'getGame' | 'listRounds'>,
  worlds: WorldRegistry,
  playerId: string,
  ref: ReportGameRef,
): Promise<ReportLocation> {
  const game = await repo.getGame(ref.gameId);
  if (!game || game.playerId !== playerId) throw new ApiFailure('not_found', 'game');
  const rounds = await repo.listRounds(game.id);
  let round: RoundRecord | undefined;
  if (ref.round !== undefined) round = rounds.find((r) => r.n === ref.round);
  else round = rounds.find((r) => r.finishedAt === null) ?? rounds[rounds.length - 1];
  if (!round) throw new ApiFailure('not_found', 'round');

  let key: string;
  if (ref.key !== undefined) {
    if (!round.seen.includes(ref.key)) throw new ApiFailure('not_found', 'node');
    key = ref.key;
  } else {
    key = ref.round !== undefined ? round.key : round.currentKey;
  }
  const world = worlds.get(round.world);
  const node = world ? nodeByKey(world, key) : undefined;
  if (!node) throw new ApiFailure('not_found', 'node');
  return {
    gameId: game.id,
    round: round.n,
    world: round.world,
    key,
    nodeId: node.id,
    waypoint: node.wp,
    x: node.x,
    y: node.y,
    z: node.z,
    startKey: round.key,
  };
}
