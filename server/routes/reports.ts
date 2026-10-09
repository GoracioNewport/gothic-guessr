/**
 * Problem reports (server/core/reports.ts).
 *
 * Player API (mounted under `/api` by app.ts):
 *   POST /reports {type, text?, categories?, game?, context?} → 204
 *        Needs a player (401 `auth` otherwise; the client creates one). 10/h per player and 30/h per IP
 *        (`rate_limited` + Retry-After), body ≤ 8 KiB. Banned players may report; the report is flagged.
 *
 * Admin API (mounted under `/api/<ADMIN_PATH>/reports` inside routes/admin.ts, behind its session check and same-origin rule):
 *   GET  /?status&type&world&limit&before → AdminReportList (newest first; `next` → `before`)
 *   GET  /counts                          → AdminReportCounts
 *   GET  /:id                             → AdminReport
 *   POST /:id/status {status}             → AdminReport; audited as report.resolve | report.ignore | report.reopen
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type {
  AdminReport,
  AdminReportCounts,
  AdminReportList,
  ApiError,
  ReportStatus,
} from '../../shared/api';
import { ApiFailure } from '../core/errors';
import { RateLimiter } from '../core/ratelimit';
import {
  REPORT_BODY_MAX,
  REPORT_LIMITS,
  cleanUserAgent,
  isReportStatus,
  isReportType,
  parseReport,
  resolveReportLocation,
} from '../core/reports';
import type { ReportFilter, ReportLocation, ReportRecord, ReportStore } from '../core/reports';
import { SqliteReportStore } from '../db/reports';
import { clientIp, readJson, requirePlayer, services } from '../http';
import type { AppContext, AppEnv } from '../http';
import type { Services } from '../services';

interface ReportsState {
  store: ReportStore;
  perPlayer: RateLimiter;
  perIp: RateLimiter;
}

const states = new WeakMap<Services, ReportsState>();

/** The report store and limiters of one server (one per {@link Services}, so test apps stay isolated). */
export function reportsState(s: Services): ReportsState {
  let st = states.get(s);
  if (!st) {
    st = {
      store: new SqliteReportStore(s.repo.db),
      perPlayer: new RateLimiter(REPORT_LIMITS.player, 10_000),
      perIp: new RateLimiter(REPORT_LIMITS.ip, 10_000),
    };
    states.set(s, st);
  }
  return st;
}

const STATUS_ACTION: Record<ReportStatus, string> = { open: 'report.reopen', resolved: 'report.resolve', ignored: 'report.ignore' };

function retryAfter(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export function reportsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post(
    '/reports',
    bodyLimit({
      maxSize: REPORT_BODY_MAX,
      onError: (c) => c.json({ error: 'bad_request', message: 'body too large' } satisfies ApiError, 413),
    }),
    async (c) => {
      const s = services(c);
      const player = await requirePlayer(c);
      const st = reportsState(s);
      const now = s.clock();
      const ipKey = `ip:${clientIp(c)}`;
      const playerKey = `player:${player.id}`;
      // Peek both before taking either, so a refused report costs nothing.
      for (const [limiter, key] of [[st.perIp, ipKey], [st.perPlayer, playerKey]] as const) {
        const d = limiter.peek(key, now);
        if (!d.ok) throw new ApiFailure('rate_limited', 'reports', retryAfter(d.retryAfterMs));
      }
      const input = parseReport(await readJson(c));
      let location: ReportLocation | null = null;
      if (input.game) location = await resolveReportLocation(s.repo, s.worlds, player.id, input.game);
      st.perIp.take(ipKey, now);
      st.perPlayer.take(playerKey, now);
      st.store.insert({
        at: now,
        type: input.type,
        categories: input.categories,
        text: input.text,
        playerId: player.id,
        nickname: player.nickname,
        flagged: player.banned,
        location,
        lang: input.lang,
        path: input.path,
        userAgent: cleanUserAgent(c.req.header('user-agent')),
        viewport: input.viewport,
        appVersion: input.appVersion,
      });
      return c.body(null, 204);
    },
  );

  return r;
}

// --- admin ------------------------------------------------------------------------------------------------------------

function intQuery(c: AppContext, name: string, def: number, min: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiFailure('bad_request', name);
  return n;
}

async function adminView(s: Services, rec: ReportRecord, players = new Map<string, AdminReport['player']>()): Promise<AdminReport> {
  let player: AdminReport['player'] = null;
  if (rec.playerId) {
    if (!players.has(rec.playerId)) {
      const p = await s.repo.getPlayer(rec.playerId);
      players.set(rec.playerId, p ? { id: p.id, nickname: p.nickname, banned: p.banned } : null);
    }
    player = players.get(rec.playerId) ?? null;
  }
  return {
    id: rec.id,
    at: rec.at,
    type: rec.type,
    status: rec.status,
    statusAt: rec.statusAt,
    categories: rec.categories,
    text: rec.text,
    player,
    nickname: rec.nickname,
    flagged: rec.flagged,
    location: rec.location ? { ...rec.location, panoPath: `panos/${rec.location.key}` } : null,
    lang: rec.lang,
    path: rec.path,
    userAgent: rec.userAgent,
    viewport: rec.viewport,
    appVersion: rec.appVersion,
  };
}

function reportId(c: AppContext): number {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) throw new ApiFailure('bad_request', 'id');
  return id;
}

/** Routes for `/api/<ADMIN_PATH>/reports`; routes/admin.ts mounts them after its auth middleware. */
export function adminReportsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const s = services(c);
    const filter: ReportFilter = {};
    const status = c.req.query('status');
    const type = c.req.query('type');
    const world = c.req.query('world');
    if (status) {
      if (!isReportStatus(status)) throw new ApiFailure('bad_request', 'status');
      filter.status = status;
    }
    if (type) {
      if (!isReportType(type)) throw new ApiFailure('bad_request', 'type');
      filter.type = type;
    }
    if (world) {
      if (!/^[a-z0-9_-]{1,64}$/.test(world)) throw new ApiFailure('bad_request', 'world');
      filter.world = world;
    }
    const limit = intQuery(c, 'limit', 50, 1, 200);
    const before = c.req.query('before') ? intQuery(c, 'before', 0, 1, Number.MAX_SAFE_INTEGER) : undefined;
    const store = reportsState(s).store;
    const rows = store.list(before === undefined ? filter : { ...filter, before }, limit + 1);
    const page = rows.slice(0, limit);
    const players = new Map<string, AdminReport['player']>();
    const reports: AdminReport[] = [];
    for (const rec of page) reports.push(await adminView(s, rec, players));
    const next = rows.length > limit ? page[page.length - 1]!.id : null;
    return c.json({ reports, next, total: store.count(filter) } satisfies AdminReportList);
  });

  r.get('/counts', (c) => {
    const { byStatus, openByType } = reportsState(services(c)).store.counts();
    return c.json({ open: byStatus.open, byStatus, openByType } satisfies AdminReportCounts);
  });

  r.get('/:id', async (c) => {
    const s = services(c);
    const rec = reportsState(s).store.get(reportId(c));
    if (!rec) throw new ApiFailure('not_found', 'report');
    return c.json((await adminView(s, rec)) satisfies AdminReport);
  });

  r.post('/:id/status', async (c) => {
    const s = services(c);
    const id = reportId(c);
    const b = await readJson(c);
    const status = typeof b === 'object' && b !== null ? (b as { status?: unknown }).status : undefined;
    if (!isReportStatus(status)) throw new ApiFailure('bad_request', 'status');
    const store = reportsState(s).store;
    const before = store.get(id);
    if (!before) throw new ApiFailure('not_found', 'report');
    if (before.status !== status) {
      store.setStatus(id, status, s.clock());
      await s.repo.addAudit({ at: s.clock(), action: STATUS_ACTION[status], target: String(id), details: `${before.type}: ${before.status} → ${status}` });
    }
    return c.json((await adminView(s, store.get(id)!)) satisfies AdminReport);
  });

  return r;
}
