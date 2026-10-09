/**
 * Admin API client (`/api/<ADMIN_PATH>/*`, base.ts; shared/api.ts types). The session lives in an HttpOnly cookie, so requests only
 * need `credentials: 'same-origin'`. A 401 `auth` from any call fires {@link onUnauthorized} (the shell shows login).
 */
import type {
  AdminAuditPage,
  AdminBlocklist,
  AdminChallengeView,
  AdminDailyDetail,
  AdminDailyList,
  AdminNicknameCheck,
  AdminPlayerDetail,
  AdminPlayerList,
  AdminReport,
  AdminReportCounts,
  AdminReportList,
  AdminRoomsView,
  AdminSession,
  AdminStats,
  ApiError,
  ApiErrorCode,
  PublicSettings,
  ReportStatus,
  ReportType,
} from '../../shared/api';
import { ADMIN_API } from './base';

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network',
    message?: string,
    readonly retryAfterS?: number,
  ) {
    super(message ? `${code}: ${message}` : code);
  }
}

let unauthorized: () => void = () => undefined;

export function onUnauthorized(fn: () => void): void {
  unauthorized = fn;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ADMIN_API}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new AdminApiError(0, 'network', String(err));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = (json ?? {}) as Partial<ApiError>;
    const code = err.error ?? 'internal';
    const retry = Number(res.headers.get('retry-after')) || undefined;
    if (res.status === 401 && path !== '/login') unauthorized();
    throw new AdminApiError(res.status, code, err.message, retry);
  }
  return json as T;
}

const q = (params: Record<string, string | number | null | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};
const enc = encodeURIComponent;

export const api = {
  login: (password: string) => call<AdminSession>('POST', '/login', { password }),
  logout: () => call<void>('POST', '/logout'),
  session: () => call<AdminSession>('GET', '/session'),

  stats: (from?: string, to?: string) => call<AdminStats>('GET', `/stats${q({ from, to })}`),

  dailyList: (from?: string, to?: string) => call<AdminDailyList>('GET', `/daily${q({ from, to })}`),
  daily: (date: string) => call<AdminDailyDetail>('GET', `/daily/${enc(date)}`),
  setDaily: (date: string, settings: PublicSettings, force: boolean) =>
    call<AdminDailyDetail>('PUT', `/daily/${enc(date)}`, { settings, force }),
  clearDaily: (date: string, force: boolean) => call<AdminDailyDetail>('DELETE', `/daily/${enc(date)}${q({ force: force ? 1 : null })}`),

  challenge: (code: string) => call<AdminChallengeView>('GET', `/challenges/${enc(code)}`),
  hideGame: (id: string, hidden: boolean) => call<AdminChallengeView>('POST', `/games/${enc(id)}/hide`, { hidden }),
  deleteGame: (id: string) => call<AdminChallengeView>('DELETE', `/games/${enc(id)}`),

  players: (query: string, limit = 50) => call<AdminPlayerList>('GET', `/players${q({ q: query, limit })}`),
  player: (id: string) => call<AdminPlayerDetail>('GET', `/players/${enc(id)}`),
  ban: (id: string, banned: boolean, reason?: string) =>
    call<AdminPlayerDetail>('POST', `/players/${enc(id)}/ban`, reason ? { banned, reason } : { banned }),
  resetNickname: (id: string) => call<AdminPlayerDetail>('POST', `/players/${enc(id)}/reset-nickname`),

  rooms: () => call<AdminRoomsView>('GET', '/rooms'),
  closeRoom: (code: string) => call<AdminRoomsView>('POST', `/rooms/${enc(code)}/close`),

  blocklist: () => call<AdminBlocklist>('GET', '/blocklist'),
  block: (word: string) => call<AdminBlocklist>('POST', '/blocklist', { word }),
  unblock: (word: string) => call<AdminBlocklist>('DELETE', `/blocklist/${enc(word)}`),
  checkNickname: (nickname: string) => call<AdminNicknameCheck>('GET', `/blocklist/check${q({ nickname })}`),

  audit: (limit = 100, before?: number | null) => call<AdminAuditPage>('GET', `/audit${q({ limit, before })}`),

  reports: (filter: { status?: ReportStatus | ''; type?: ReportType | ''; world?: string; limit?: number; before?: number | null } = {}) =>
    call<AdminReportList>('GET', `/reports${q({ status: filter.status, type: filter.type, world: filter.world, limit: filter.limit, before: filter.before })}`),
  reportCounts: () => call<AdminReportCounts>('GET', '/reports/counts'),
  report: (id: number) => call<AdminReport>('GET', `/reports/${id}`),
  setReportStatus: (id: number, status: ReportStatus) => call<AdminReport>('POST', `/reports/${id}/status`, { status }),
};

/** Human text for an error (the admin UI is English only). */
export function errorText(err: unknown): string {
  if (err instanceof AdminApiError) {
    switch (err.code) {
      case 'network':
        return 'Network error: is the API server running?';
      case 'rate_limited':
        return `Too many attempts. Try again in ${err.retryAfterS ?? 60} s.`;
      case 'conflict':
        return 'Conflict: this date already has games. Tick "force" to override anyway.';
      case 'not_found':
        return 'Not found.';
      case 'auth':
        return 'Not logged in or wrong password.';
      default:
        return err.message;
    }
  }
  return String(err);
}
