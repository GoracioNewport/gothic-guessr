/**
 * Dashboard (SPEC §10.10): date range (default 30 days), totals, live counts, per-day charts (page views/visitors,
 * games started by kind, games finished by kind, new players, daily participants, rooms created), top referrers and
 * paths, and the per-day numbers as a table. Live counts refresh every 15 s.
 */
import type { AdminReportCounts, AdminStats, GameKind, ReportType } from '../../../shared/api';
import { api } from '../api';
import { barChart, lineChart, topList } from '../charts';
import { fmtNum, h, mount, pageHeader, panel } from '../dom';
import type { Page } from '../page';
import { adminUrl } from '../base';

const KINDS: { kind: GameKind; label: string; color: string }[] = [
  { kind: 'solo', label: 'Solo', color: 'var(--s1)' },
  { kind: 'daily', label: 'Daily', color: 'var(--s2)' },
  { kind: 'challenge', label: 'Challenge', color: 'var(--s3)' },
  { kind: 'party', label: 'Party', color: 'var(--s4)' },
  { kind: 'duel', label: 'Duel', color: 'var(--s5)' },
];

const PRESETS = [7, 30, 90];

const REPORT_TYPE_LABELS: [ReportType, string][] = [
  ['location', 'Place'],
  ['translation', 'Translation'],
  ['bug', 'Bug'],
  ['other', 'Other'],
];

const DAY_MS = 86_400_000;
const today = (): string => new Date().toISOString().slice(0, 10);
const daysBefore = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
const sumKinds = (r: Record<GameKind, number>): number => KINDS.reduce((a, k) => a + r[k.kind], 0);

function tile(label: string, value: number | string, note?: string, live = false): HTMLElement {
  return h(
    'div',
    { class: `tile${live ? ' tile-live' : ''}` },
    h('span', { class: 'tile-label' }, live ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : null, label),
    h('span', { class: 'tile-value' }, typeof value === 'number' ? fmtNum(value) : value),
    note ? h('span', { class: 'tile-note' }, note) : null,
  );
}

function liveTiles(live: AdminStats['live']): HTMLElement[] {
  return [
    tile('Open sockets', live.sockets, undefined, true),
    tile('Active rooms', live.rooms, undefined, true),
    tile('Games in progress', live.gamesInProgress, 'round opened < 30 min ago', true),
  ];
}

/** Open player reports (pages/reports.ts), linking to the list. */
function reportsTiles(c: AdminReportCounts): HTMLElement {
  const byType = REPORT_TYPE_LABELS.filter(([t]) => c.openByType[t] > 0).map(([t, label]) => `${label} ${c.openByType[t]}`);
  return h(
    'div',
    { class: 'tiles tiles-reports' },
    h('a', { class: 'tile-link', href: adminUrl('/reports'), 'data-link': true }, tile('Open reports', c.open, byType.length ? byType.join(' · ') : 'nothing to review')),
  );
}

function dayTable(stats: AdminStats): HTMLElement {
  const head = ['Date', 'Views', 'Visitors', 'New players', ...KINDS.map((k) => `${k.label} ▸/✓`), 'Rooms', 'Daily players'];
  const rows = [...stats.days].reverse().map((d) =>
    h(
      'tr',
      {},
      h('td', {}, d.date),
      h('td', { class: 'num' }, fmtNum(d.pageViews)),
      h('td', { class: 'num' }, fmtNum(d.visitors)),
      h('td', { class: 'num' }, fmtNum(d.newPlayers)),
      ...KINDS.map((k) => h('td', { class: 'num' }, `${d.gamesStarted[k.kind]} / ${d.gamesFinished[k.kind]}`)),
      h('td', { class: 'num' }, fmtNum(d.roomsCreated)),
      h('td', { class: 'num' }, fmtNum(d.dailyPlayers)),
    ),
  );
  return h(
    'details',
    { class: 'table-details' },
    h('summary', {}, 'Per-day numbers (table)'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...head.map((t) => h('th', {}, t)))), h('tbody', {}, ...rows))),
    h('p', { class: 'hint' }, '▸ started / ✓ finished. Days are UTC.'),
  );
}

export const dashboardPage: Page = async (ctx) => {
  const params = new URLSearchParams(location.search);
  const to = params.get('to') || today();
  const from = params.get('from') || daysBefore(to, 29);

  const fromInput = h('input', { type: 'date', value: from, max: today(), 'aria-label': 'From date' });
  const toInput = h('input', { type: 'date', value: to, max: today(), 'aria-label': 'To date' });
  const apply = (f: string, t: string): void => ctx.navigate(adminUrl(`?from=${f}&to=${t}`));
  const rangeForm = h(
    'form',
    { class: 'range' },
    ...PRESETS.map((n) => {
      const b = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, `${n} d`);
      b.addEventListener('click', () => apply(daysBefore(today(), n - 1), today()));
      return b;
    }),
    fromInput,
    h('span', { class: 'muted' }, '–'),
    toInput,
    h('button', { type: 'submit', class: 'btn btn-sm' }, 'Apply'),
  );
  rangeForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (fromInput.value && toInput.value) apply(fromInput.value, toInput.value);
  });

  mount(ctx.root, pageHeader('Dashboard', `${from} – ${to} (UTC)`, rangeForm), h('p', { class: 'loading' }, 'Loading statistics…'));
  const [stats, reportCounts] = await Promise.all([api.stats(from, to), api.reportCounts().catch(() => null)]);
  if (!ctx.isCurrent()) return;

  const t = stats.totals;
  const days = stats.days.map((d) => d.date);
  const liveRow = h('div', { class: 'tiles tiles-live' }, ...liveTiles(stats.live));

  mount(
    ctx.root,
    pageHeader('Dashboard', `${stats.from} – ${stats.to} (UTC), ${stats.days.length} days`, rangeForm),
    h('h2', { class: 'section-title' }, 'Live now'),
    liveRow,
    reportCounts ? reportsTiles(reportCounts) : null,
    h('h2', { class: 'section-title' }, 'Totals in range'),
    h(
      'div',
      { class: 'tiles' },
      tile('Page views', t.pageViews),
      tile('Unique visitors', t.visitors),
      tile('New players', t.newPlayers),
      tile('Games started', sumKinds(t.gamesStarted), KINDS.map((k) => `${k.label} ${t.gamesStarted[k.kind]}`).join(' · ')),
      tile('Games finished', sumKinds(t.gamesFinished), KINDS.map((k) => `${k.label} ${t.gamesFinished[k.kind]}`).join(' · ')),
      tile('Rooms created', t.roomsCreated),
      tile('Daily participants', t.dailyPlayers),
    ),
    h(
      'div',
      { class: 'charts' },
      panel(
        'Page views and unique visitors',
        lineChart({
          label: 'Page views and unique visitors per day',
          days,
          series: [
            { name: 'Page views', color: 'var(--s1)', values: stats.days.map((d) => d.pageViews) },
            { name: 'Visitors', color: 'var(--s2)', values: stats.days.map((d) => d.visitors) },
          ],
        }),
      ),
      panel(
        'Games started by kind',
        barChart({
          label: 'Games started per day, stacked by kind',
          days,
          total: true,
          series: KINDS.map((k) => ({ name: k.label, color: k.color, values: stats.days.map((d) => d.gamesStarted[k.kind]) })),
        }),
      ),
      panel(
        'Games finished by kind',
        barChart({
          label: 'Games finished per day, stacked by kind',
          days,
          total: true,
          series: KINDS.map((k) => ({ name: k.label, color: k.color, values: stats.days.map((d) => d.gamesFinished[k.kind]) })),
        }),
      ),
      panel('New players', barChart({ label: 'New players per day', days, height: 160, series: [{ name: 'New players', color: 'var(--s1)', values: stats.days.map((d) => d.newPlayers) }] })),
      panel('Daily participants', barChart({ label: 'Daily challenge participants per day', days, height: 160, series: [{ name: 'Daily participants', color: 'var(--s2)', values: stats.days.map((d) => d.dailyPlayers) }] })),
      panel('Rooms created', barChart({ label: 'Rooms created per day', days, height: 160, series: [{ name: 'Rooms created', color: 'var(--s4)', values: stats.days.map((d) => d.roomsCreated) }] })),
    ),
    h(
      'div',
      { class: 'two-col' },
      panel('Top referrer hosts', topList(stats.topReferrers.map((r) => ({ label: r.host, count: r.count })), 'No external referrers in this range.')),
      panel('Top paths', topList(stats.topPaths.map((p) => ({ label: p.path, count: p.count })), 'No page views in this range.')),
    ),
    dayTable(stats),
  );

  // Refresh the live tiles while the dashboard is open.
  const timer = window.setInterval(async () => {
    try {
      const fresh = await api.stats(today(), today());
      if (ctx.isCurrent()) mount(liveRow, ...liveTiles(fresh.live));
    } catch {
      /* keep the last values */
    }
  }, 15_000);
  return () => window.clearInterval(timer);
};
