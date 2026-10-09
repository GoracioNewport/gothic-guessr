/**
 * Admin API (SPEC §10.9, §10.10), mounted at `/api/<ADMIN_PATH>` by the admin plugin (server/admin/plugin.ts). Every
 * route except `POST /login` requires the session cookie (401 `auth` otherwise; the cookie's Path is the same
 * `/api/<ADMIN_PATH>`, so the browser never sends it anywhere else); every write is appended to the audit log.
 * Payload types: the Admin* interfaces of shared/api.ts. Admin payloads may contain private data (ids, game totals),
 * never secrets.
 *
 *   POST   /login {password}             → AdminSession + Set-Cookie (5 attempts / 15 min per IP)
 *   POST   /logout                       → 204, clears and revokes the cookie
 *   GET    /session                      → AdminSession
 *   GET    /stats?from&to                → AdminStats (default: the last 30 days)
 *   GET    /daily?from&to                → AdminDailyList (default: 30 days back … 14 days ahead)
 *   GET    /daily/:date                  → AdminDailyDetail
 *   PUT    /daily/:date {settings, force?} → AdminDailyDetail   (409 `conflict` when the day has games and !force)
 *   DELETE /daily/:date?force=1          → AdminDailyDetail   back to the default settings, same rule
 *   GET    /challenges/:code             → AdminChallengeView (moderation leaderboard incl. hidden/banned)
 *   POST   /games/:id/hide {hidden}      → AdminChallengeView of the game's challenge
 *   DELETE /games/:id                    → AdminChallengeView (the player may play the challenge again)
 *   GET    /players?q&limit              → AdminPlayerList
 *   GET    /players/:id                  → AdminPlayerDetail
 *   POST   /players/:id/ban {banned, reason?} → AdminPlayerDetail
 *   POST   /players/:id/reset-nickname   → AdminPlayerDetail
 *   GET    /rooms                        → AdminRoomsView
 *   POST   /rooms/:code/close            → AdminRoomsView
 *   GET    /blocklist                    → AdminBlocklist
 *   POST   /blocklist {word}             → AdminBlocklist
 *   DELETE /blocklist/:word              → AdminBlocklist
 *   GET    /blocklist/check?nickname=    → AdminNicknameCheck
 *   GET    /audit?limit&before           → AdminAuditPage
 *   GET    /reports?status&type&world&limit&before → AdminReportList; /reports/counts, /reports/:id,
 *   POST   /reports/:id/status {status}  → AdminReport (see routes/reports.ts)
 *
 * Writes also require a same-origin `Origin` header when one is sent (defence in depth on top of SameSite=Strict).
 */
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type {
  AdminAuditPage,
  AdminBlocklist,
  AdminChallengeView,
  AdminDailyDetail,
  AdminDailyList,
  AdminDailyRowEx,
  AdminNicknameCheck,
  AdminPlayerDetail,
  AdminPlayerList,
  AdminRoomsView,
  AdminSession,
  AdminStats,
} from '../../shared/api';
import { SESSION_COOKIE, safeEqual } from '../admin/session';
import { addDays } from '../admin/store';
import { adminState } from '../admin/state';
import type { AdminState } from '../admin/state';
import { ApiFailure } from '../core/errors';
import { checkNickname } from '../core/nickname';
import { findProfanity, prepareRoot } from '../core/profanity';
import { dailyCode, isIsoDate, utcDate } from '../core/settings';
import { clientIp, readJson, services } from '../http';
import { adminReportsRoutes } from './reports';
import type { AppContext, AppEnv } from '../http';

const MAX_STATS_DAYS = 366;
const MAX_DAILY_DAYS = 400;
const BLOCKED_WORD_MAX = 40;

/** Mount point of these routes and the session cookie's Path: `/api/<ADMIN_PATH>`. */
function apiBase(c: AppContext): string {
  return `/api/${services(c).config.adminPath}`;
}

function state(c: AppContext): AdminState {
  return adminState(services(c));
}

async function audit(c: AppContext, action: string, target: string, details?: string): Promise<void> {
  const s = services(c);
  const entry: { at: number; action: string; target: string; details?: string } = { at: s.clock(), action, target };
  if (details !== undefined) entry.details = details;
  await s.repo.addAudit(entry);
}

/** Body as an object or `bad_request`. */
async function body(c: AppContext): Promise<Record<string, unknown>> {
  const b = await readJson(c);
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new ApiFailure('bad_request', 'body');
  return b as Record<string, unknown>;
}

function isSecure(c: AppContext): boolean {
  if (new URL(c.req.url).protocol === 'https:') return true;
  return services(c).config.trustProxy && c.req.header('x-forwarded-proto') === 'https';
}

/** Validated `from`/`to` query (inclusive dates); defaults from `fallback`. */
function range(c: AppContext, fallback: { from: string; to: string }, maxDays: number): { from: string; to: string } {
  const from = c.req.query('from') || fallback.from;
  const to = c.req.query('to') || fallback.to;
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new ApiFailure('bad_request', 'range');
  if (addDays(from, maxDays - 1) < to) throw new ApiFailure('bad_request', `range longer than ${maxDays} days`);
  return { from, to };
}

function intQuery(c: AppContext, name: string, def: number, min: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiFailure('bad_request', name);
  return n;
}

async function challengeView(c: AppContext, code: string): Promise<AdminChallengeView> {
  const s = services(c);
  const ch = await s.repo.getChallenge(code);
  if (!ch) throw new ApiFailure('not_found', 'challenge');
  const st = state(c).store;
  let createdBy: AdminChallengeView['createdBy'] = null;
  if (ch.createdBy) {
    const p = await s.repo.getPlayer(ch.createdBy);
    createdBy = { id: ch.createdBy, nickname: p?.nickname ?? '?' };
  }
  return {
    code: ch.code,
    kind: ch.kind,
    settings: ch.settings,
    createdBy,
    createdAt: ch.createdAt,
    date: ch.date,
    roomCode: ch.roomCode,
    status: ch.status,
    ...st.challengeCounts(code),
    entries: st.moderationBoard(code),
  };
}

async function dailyRows(c: AppContext, from: string, to: string): Promise<AdminDailyRowEx[]> {
  const s = services(c);
  const today = utcDate(s.clock());
  const counts = state(c).store.dailyCounts(from, to);
  const rows: AdminDailyRowEx[] = [];
  for (let date = to; date >= from; date = addDays(date, -1)) {
    const challenge = counts.has(date) ? await s.repo.getDailyChallenge(date) : null;
    const { settings, overridden } = await s.games.dailySettings(date);
    const n = counts.get(date);
    rows.push({
      date,
      code: dailyCode(date),
      exists: challenge !== null,
      settings: challenge ? challenge.settings : settings,
      overridden,
      players: n?.players ?? 0,
      games: n?.games ?? 0,
      best: n?.best ?? null,
      when: date < today ? 'past' : date === today ? 'today' : 'future',
    });
  }
  return rows;
}

async function dailyDetail(c: AppContext, date: string): Promise<AdminDailyDetail> {
  if (!isIsoDate(date)) throw new ApiFailure('bad_request', 'date');
  const [row] = await dailyRows(c, date, date);
  return { row: row!, challenge: row!.exists ? await challengeView(c, dailyCode(date)) : null };
}

async function playerDetail(c: AppContext, id: string): Promise<AdminPlayerDetail> {
  const st = state(c).store;
  const player = st.getAdminPlayer(id);
  if (!player) throw new ApiFailure('not_found', 'player');
  return { player, games: st.playerGames(id), bans: st.banHistory(id) };
}

function roomsView(c: AppContext): AdminRoomsView {
  const source = state(c).rooms();
  if (!source) return { available: false, rooms: [] };
  const rooms = [...source.listRooms()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return { available: true, rooms };
}

function blocklist(c: AppContext): AdminBlocklist {
  return { words: state(c).store.blockedWords() };
}

export function adminRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // Login: rate limited per IP, constant-time compare, the limiter is reset on success.
  r.post('/login', async (c) => {
    const s = services(c);
    const ip = clientIp(c);
    const decision = s.limits.check('adminLogin', `ip:${ip}`, s.clock());
    if (!decision.ok) {
      throw new ApiFailure('rate_limited', 'adminLogin', Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    }
    const b = await body(c);
    const password = b.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > 512) {
      throw new ApiFailure('bad_request', 'password');
    }
    if (!(await safeEqual(password, s.config.adminPassword))) {
      await audit(c, 'login.failed', 'admin');
      throw new ApiFailure('auth', 'wrong password');
    }
    s.limits.limiter('adminLogin').reset(`ip:${ip}`);
    const session = await state(c).sessions.issue();
    setCookie(c, SESSION_COOKIE, session.value, {
      path: apiBase(c),
      httpOnly: true,
      sameSite: 'Strict',
      secure: isSecure(c),
      maxAge: Math.floor(state(c).sessions.ttlMs / 1000),
    });
    await audit(c, 'login', 'admin');
    return c.json({ expiresAt: session.expiresAt } satisfies AdminSession);
  });

  // Everything below: a valid session, and same-origin writes.
  r.use('*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path.replace(/\/+$/, '') === `${apiBase(c)}/login`) return next();
    const session = await state(c).sessions.verify(getCookie(c, SESSION_COOKIE));
    if (!session) throw new ApiFailure('auth', 'admin session required');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin) {
        const host = (services(c).config.trustProxy && c.req.header('x-forwarded-host')) || c.req.header('host');
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          // fall through: mismatch
        }
        if (!host || originHost !== host) throw new ApiFailure('forbidden', 'cross-origin admin write');
      }
    }
    await next();
  });

  r.post('/logout', async (c) => {
    const session = await state(c).sessions.verify(getCookie(c, SESSION_COOKIE));
    if (session) state(c).sessions.revoke(session.nonce, session.expiresAt);
    deleteCookie(c, SESSION_COOKIE, { path: apiBase(c), httpOnly: true, sameSite: 'Strict', secure: isSecure(c) });
    await audit(c, 'logout', 'admin');
    return c.body(null, 204);
  });

  r.get('/session', async (c) => {
    const session = await state(c).sessions.verify(getCookie(c, SESSION_COOKIE));
    return c.json({ expiresAt: session!.expiresAt } satisfies AdminSession);
  });

  // Statistics ------------------------------------------------------------------------------------------------------

  r.get('/stats', (c) => {
    const s = services(c);
    const now = s.clock();
    const today = utcDate(now);
    const { from, to } = range(c, { from: addDays(today, -29), to: today }, MAX_STATS_DAYS);
    const { gamesInProgress, ...stats } = state(c).store.stats(from, to, now);
    const live = state(c).rooms()?.liveCounts() ?? { sockets: 0, rooms: 0 };
    return c.json({ ...stats, live: { sockets: live.sockets, rooms: live.rooms, gamesInProgress } } satisfies AdminStats);
  });

  // Daily -----------------------------------------------------------------------------------------------------------

  r.get('/daily', async (c) => {
    const today = utcDate(services(c).clock());
    const { from, to } = range(c, { from: addDays(today, -30), to: addDays(today, 14) }, MAX_DAILY_DAYS);
    return c.json({ today, days: await dailyRows(c, from, to) } satisfies AdminDailyList);
  });

  r.get('/daily/:date', async (c) => c.json((await dailyDetail(c, c.req.param('date'))) satisfies AdminDailyDetail));

  r.put('/daily/:date', async (c) => {
    const date = c.req.param('date');
    if (!isIsoDate(date)) throw new ApiFailure('bad_request', 'date');
    const b = await body(c);
    const force = b.force === true;
    const before = await dailyDetail(c, date);
    await services(c).games.setDailyOverride(date, b.settings, { force });
    const after = await dailyDetail(c, date);
    await audit(
      c,
      'daily.override',
      date,
      JSON.stringify({ settings: after.row.settings, force, games: before.row.games }),
    );
    return c.json(after satisfies AdminDailyDetail);
  });

  r.delete('/daily/:date', async (c) => {
    const date = c.req.param('date');
    if (!isIsoDate(date)) throw new ApiFailure('bad_request', 'date');
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true';
    const before = await dailyDetail(c, date);
    await services(c).games.clearDailyOverride(date, { force });
    await audit(c, 'daily.clear', date, JSON.stringify({ force, games: before.row.games }));
    return c.json((await dailyDetail(c, date)) satisfies AdminDailyDetail);
  });

  // Challenges and leaderboard moderation ---------------------------------------------------------------------------

  r.get('/challenges/:code', async (c) => c.json((await challengeView(c, c.req.param('code'))) satisfies AdminChallengeView));

  r.post('/games/:id/hide', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    if (typeof b.hidden !== 'boolean') throw new ApiFailure('bad_request', 'hidden');
    const st = state(c).store;
    const game = st.getGameRow(id);
    if (!game) throw new ApiFailure('not_found', 'game');
    st.setGameHidden(id, b.hidden);
    await audit(c, b.hidden ? 'game.hide' : 'game.unhide', id, `challenge=${game.challengeCode} player=${game.playerId}`);
    return c.json((await challengeView(c, game.challengeCode)) satisfies AdminChallengeView);
  });

  r.delete('/games/:id', async (c) => {
    const id = c.req.param('id');
    const st = state(c).store;
    const game = st.getGameRow(id);
    if (!game) throw new ApiFailure('not_found', 'game');
    st.deleteGame(id);
    await audit(c, 'game.delete', id, `challenge=${game.challengeCode} player=${game.playerId}`);
    return c.json((await challengeView(c, game.challengeCode)) satisfies AdminChallengeView);
  });

  // Players ---------------------------------------------------------------------------------------------------------

  r.get('/players', (c) => {
    const q = (c.req.query('q') ?? '').slice(0, 64);
    const limit = intQuery(c, 'limit', 50, 1, 200);
    return c.json(state(c).store.searchPlayers(q, limit) satisfies AdminPlayerList);
  });

  r.get('/players/:id', async (c) => c.json((await playerDetail(c, c.req.param('id'))) satisfies AdminPlayerDetail));

  r.post('/players/:id/ban', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    if (typeof b.banned !== 'boolean') throw new ApiFailure('bad_request', 'banned');
    if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200)) {
      throw new ApiFailure('bad_request', 'reason');
    }
    const s = services(c);
    const player = await s.repo.getPlayer(id);
    if (!player) throw new ApiFailure('not_found', 'player');
    const reason = typeof b.reason === 'string' && b.reason.trim() !== '' ? b.reason.trim() : undefined;
    if (player.banned !== b.banned) await s.repo.setBanned(id, b.banned, s.clock(), reason);
    await audit(c, b.banned ? 'player.ban' : 'player.unban', id, reason ? `${player.nickname}: ${reason}` : player.nickname);
    return c.json((await playerDetail(c, id)) satisfies AdminPlayerDetail);
  });

  r.post('/players/:id/reset-nickname', async (c) => {
    const id = c.req.param('id');
    const s = services(c);
    const player = await s.repo.getPlayer(id);
    if (!player) throw new ApiFailure('not_found', 'player');
    const nickname = await s.players.resetNickname(id);
    await audit(c, 'player.reset_nickname', id, `${player.nickname} → ${nickname}`);
    return c.json((await playerDetail(c, id)) satisfies AdminPlayerDetail);
  });

  // Rooms -----------------------------------------------------------------------------------------------------------

  r.get('/rooms', (c) => c.json(roomsView(c) satisfies AdminRoomsView));

  r.post('/rooms/:code/close', async (c) => {
    const code = c.req.param('code');
    const source = state(c).rooms();
    if (!source) throw new ApiFailure('not_found', 'rooms module not running');
    if (!(await source.closeRoom(code))) throw new ApiFailure('not_found', 'room');
    await audit(c, 'room.close', code);
    return c.json(roomsView(c) satisfies AdminRoomsView);
  });

  // Blocklist -------------------------------------------------------------------------------------------------------

  r.get('/blocklist', (c) => c.json(blocklist(c) satisfies AdminBlocklist));

  r.post('/blocklist', async (c) => {
    const b = await body(c);
    if (typeof b.word !== 'string') throw new ApiFailure('bad_request', 'word');
    const word = b.word.normalize('NFC').trim().toLowerCase();
    if ([...word].length > BLOCKED_WORD_MAX || /\s/.test(word)) throw new ApiFailure('bad_request', 'word: one word, ≤ 40 chars');
    if (prepareRoot(word) === null) {
      throw new ApiFailure('bad_request', 'word: needs ≥ 3 letters of one script after normalisation');
    }
    const s = services(c);
    await s.repo.addBlockedWord(word, s.clock());
    await audit(c, 'blocklist.add', word);
    return c.json(blocklist(c) satisfies AdminBlocklist);
  });

  r.delete('/blocklist/:word', async (c) => {
    const word = decodeURIComponent(c.req.param('word'));
    const s = services(c);
    if (!state(c).store.blockedWords().some((w) => w.word === word)) throw new ApiFailure('not_found', 'word');
    await s.repo.removeBlockedWord(word);
    await audit(c, 'blocklist.remove', word);
    return c.json(blocklist(c) satisfies AdminBlocklist);
  });

  r.get('/blocklist/check', async (c) => {
    const nickname = (c.req.query('nickname') ?? '').slice(0, 64);
    const words = await services(c).repo.listBlockedWords();
    const check = checkNickname(nickname, words);
    const view: AdminNicknameCheck = check.ok
      ? { nickname: check.nickname, result: 'ok', match: null }
      : { nickname, result: check.reason, match: check.reason === 'blocked' ? findProfanity(nickname, words) : null };
    return c.json(view);
  });

  // Audit -----------------------------------------------------------------------------------------------------------

  r.get('/audit', (c) => {
    const limit = intQuery(c, 'limit', 100, 1, 500);
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? intQuery(c, 'before', 0, 1, Number.MAX_SAFE_INTEGER) : null;
    return c.json(state(c).store.auditPage(limit, before) satisfies AdminAuditPage);
  });

  // Problem reports (routes/reports.ts): list/filter, counts, status changes (audited) ------------------------------

  r.route('/reports', adminReportsRoutes());

  return r;
}
