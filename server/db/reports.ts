/**
 * better-sqlite3 implementation of {@link ReportStore} over the `reports` table (migration 2 of ./schema.ts).
 */
import { REPORT_STATUSES, REPORT_TYPES } from '../../shared/api';
import type { ReportCategory, ReportStatus, ReportType } from '../../shared/api';
import type { NewReport, ReportFilter, ReportRecord, ReportStore } from '../core/reports';
import type { Db } from './database';

interface ReportRow {
  id: number;
  at: number;
  type: ReportType;
  status: ReportStatus;
  status_at: number | null;
  categories: string;
  text: string;
  player_id: string | null;
  nickname: string | null;
  flagged: number;
  game_id: string | null;
  round_n: number | null;
  world: string | null;
  node_key: string | null;
  node_id: number | null;
  waypoint: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  start_key: string | null;
  lang: string | null;
  path: string | null;
  user_agent: string | null;
  viewport: string | null;
  app_version: string | null;
}

function parseCategories(json: string): ReportCategory[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v.filter((c) => typeof c === 'string') as ReportCategory[]) : [];
  } catch {
    return [];
  }
}

function toRecord(r: ReportRow): ReportRecord {
  const hasLocation = r.game_id !== null && r.node_key !== null && r.world !== null && r.round_n !== null;
  return {
    id: r.id,
    at: r.at,
    type: r.type,
    status: r.status,
    statusAt: r.status_at,
    categories: parseCategories(r.categories),
    text: r.text,
    playerId: r.player_id,
    nickname: r.nickname,
    flagged: r.flagged === 1,
    location: hasLocation
      ? {
          gameId: r.game_id!,
          round: r.round_n!,
          world: r.world!,
          key: r.node_key!,
          nodeId: r.node_id ?? -1,
          waypoint: r.waypoint ?? '',
          x: r.x ?? 0,
          y: r.y ?? 0,
          z: r.z ?? 0,
          startKey: r.start_key ?? r.node_key!,
        }
      : null,
    lang: r.lang,
    path: r.path,
    userAgent: r.user_agent,
    viewport: r.viewport,
    appVersion: r.app_version,
  };
}

function where(filter: ReportFilter): { sql: string; args: (string | number)[] } {
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (filter.status) {
    parts.push('status = ?');
    args.push(filter.status);
  }
  if (filter.type) {
    parts.push('type = ?');
    args.push(filter.type);
  }
  if (filter.world) {
    parts.push('world = ?');
    args.push(filter.world);
  }
  if (filter.before !== undefined) {
    parts.push('id < ?');
    args.push(filter.before);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

export class SqliteReportStore implements ReportStore {
  constructor(readonly db: Db) {}

  insert(r: NewReport): number {
    const loc = r.location;
    const info = this.db
      .prepare(
        `INSERT INTO reports (at, type, categories, text, player_id, nickname, flagged, game_id, round_n, world, node_key,
                              node_id, waypoint, x, y, z, start_key, lang, path, user_agent, viewport, app_version)
         VALUES (@at, @type, @categories, @text, @player_id, @nickname, @flagged, @game_id, @round_n, @world, @node_key,
                 @node_id, @waypoint, @x, @y, @z, @start_key, @lang, @path, @user_agent, @viewport, @app_version)`,
      )
      .run({
        at: r.at,
        type: r.type,
        categories: JSON.stringify(r.categories),
        text: r.text,
        player_id: r.playerId,
        nickname: r.nickname,
        flagged: r.flagged ? 1 : 0,
        game_id: loc?.gameId ?? null,
        round_n: loc?.round ?? null,
        world: loc?.world ?? null,
        node_key: loc?.key ?? null,
        node_id: loc?.nodeId ?? null,
        waypoint: loc?.waypoint ?? null,
        x: loc?.x ?? null,
        y: loc?.y ?? null,
        z: loc?.z ?? null,
        start_key: loc?.startKey ?? null,
        lang: r.lang,
        path: r.path,
        user_agent: r.userAgent,
        viewport: r.viewport,
        app_version: r.appVersion,
      });
    return Number(info.lastInsertRowid);
  }

  get(id: number): ReportRecord | null {
    const row = this.db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as ReportRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(filter: ReportFilter, limit: number): ReportRecord[] {
    const w = where(filter);
    const rows = this.db.prepare(`SELECT * FROM reports ${w.sql} ORDER BY id DESC LIMIT ?`).all(...w.args, limit) as ReportRow[];
    return rows.map(toRecord);
  }

  count(filter: Omit<ReportFilter, 'before'>): number {
    const w = where(filter);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM reports ${w.sql}`).get(...w.args) as { n: number }).n;
  }

  counts(): { byStatus: Record<ReportStatus, number>; openByType: Record<ReportType, number> } {
    const byStatus = Object.fromEntries(REPORT_STATUSES.map((s) => [s, 0])) as Record<ReportStatus, number>;
    const openByType = Object.fromEntries(REPORT_TYPES.map((t) => [t, 0])) as Record<ReportType, number>;
    const statusRows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM reports GROUP BY status`).all() as { status: ReportStatus; n: number }[];
    for (const r of statusRows) byStatus[r.status] = r.n;
    const typeRows = this.db.prepare(`SELECT type, COUNT(*) AS n FROM reports WHERE status = 'open' GROUP BY type`).all() as { type: ReportType; n: number }[];
    for (const r of typeRows) openByType[r.type] = r.n;
    return { byStatus, openByType };
  }

  setStatus(id: number, status: ReportStatus, at: number): boolean {
    return this.db.prepare(`UPDATE reports SET status = ?, status_at = ? WHERE id = ?`).run(status, at, id).changes > 0;
  }
}
