/**
 * Player reports (owner's request; server: server/routes/reports.ts). No replies: the admin reads them and marks them
 * resolved or ignored (or reopens them); every change goes to the audit log.
 *
 *   /<ADMIN_PATH>/reports?status=open&type=&world=   table with filters, newest first, "Load more"
 *   /<ADMIN_PATH>/reports/<id>                       the same table with the details drawer of one report (deep link
 *                                                    from the audit log): text, player, client context and, for a
 *                                                    place, the world, waypoint, node, coordinates and a preview of
 *                                                    the panorama
 *
 * {@link refreshReportsNav} keeps the open count next to the "Reports" nav entry.
 */
import { REPORT_STATUSES, REPORT_TYPES } from '../../../shared/api';
import type { AdminReport, ReportCategory, ReportStatus, ReportType } from '../../../shared/api';
import { api, errorText } from '../api';
import { badge, button, empty, fmtAgo, fmtNum, fmtTime, h, link, mount, pageHeader, panel, toast } from '../dom';
import type { Page, PageContext } from '../page';
import { loadWorlds } from '../widgets';
import type { WorldInfo } from '../widgets';
import { adminUrl } from '../base';

const TYPE_LABEL: Record<ReportType, string> = { location: 'Place', translation: 'Translation', bug: 'Bug', other: 'Other' };
const TYPE_TONE: Record<ReportType, 'gold' | 'blue' | 'red' | 'muted'> = { location: 'gold', translation: 'blue', bug: 'red', other: 'muted' };
const STATUS_TONE: Record<ReportStatus, 'gold' | 'green' | 'muted'> = { open: 'gold', resolved: 'green', ignored: 'muted' };
const CATEGORY_LABEL: Record<ReportCategory, string> = {
  underground: 'underground',
  geometry: 'inside geometry',
  floating: 'floating',
  visual: 'visual glitch',
  other: 'other',
};
/** Cube faces of the panorama preview: the four sides in a strip, then up and down. */
const SIDE_FACES = ['front', 'right', 'back', 'left'] as const;
const PAGE_SIZE = 50;

/** Update the open-report count shown next to the nav entry. */
export async function refreshReportsNav(): Promise<void> {
  const a = document.querySelector<HTMLAnchorElement>(`.nav a[href="${adminUrl('/reports')}"]`);
  if (!a) return;
  try {
    const { open } = await api.reportCounts();
    let count = a.querySelector<HTMLElement>('.nav-count');
    if (open === 0) {
      count?.remove();
      return;
    }
    if (!count) {
      count = h('span', { class: 'nav-count', 'aria-label': 'open reports' });
      a.appendChild(count);
    }
    count.textContent = fmtNum(open);
  } catch {
    /* keep the last value */
  }
}

interface Filter {
  status: ReportStatus | '';
  type: ReportType | '';
  world: string;
}

function readFilter(): Filter {
  const p = new URLSearchParams(location.search);
  const status = p.get('status');
  const type = p.get('type');
  return {
    // Open reports by default; `status=all` shows every status.
    status: status === null ? 'open' : (REPORT_STATUSES as readonly string[]).includes(status) ? (status as ReportStatus) : '',
    type: type && (REPORT_TYPES as readonly string[]).includes(type) ? (type as ReportType) : '',
    world: p.get('world') ?? '',
  };
}

function filterQuery(f: Filter): string {
  const p = new URLSearchParams();
  p.set('status', f.status || 'all');
  if (f.type) p.set('type', f.type);
  if (f.world) p.set('world', f.world);
  return `?${p.toString()}`;
}

function select(label: string, value: string, options: [string, string][], onChange: (v: string) => void): HTMLLabelElement {
  const s = h('select', { 'aria-label': label });
  for (const [v, text] of options) s.appendChild(h('option', { value: v, selected: v === value }, text));
  s.addEventListener('change', () => onChange(s.value));
  return h('label', { class: 'filter' }, h('span', {}, label), s);
}

function worldName(worlds: WorldInfo[], slug: string): string {
  return worlds.find((w) => w.slug === slug)?.name ?? slug;
}

function excerpt(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function summaryCell(r: AdminReport, worlds: WorldInfo[]): HTMLElement {
  const cell = h('div', { class: 'report-summary' });
  if (r.location) {
    cell.appendChild(h('span', { class: 'report-place' }, `${worldName(worlds, r.location.world)} · `, h('code', {}, r.location.waypoint || `#${r.location.nodeId}`)));
  }
  if (r.categories.length) cell.appendChild(h('span', { class: 'report-cats' }, ...r.categories.map((c) => badge(CATEGORY_LABEL[c] ?? c))));
  if (r.text) cell.appendChild(h('span', { class: 'report-text' }, excerpt(r.text)));
  else if (!r.location) cell.appendChild(h('span', { class: 'muted' }, '(no text)'));
  return cell;
}

function playerCell(r: AdminReport): Node | string {
  if (!r.player) return h('span', { class: 'muted' }, r.nickname ?? '—');
  return h(
    'span',
    { class: 'player-cell' },
    link(adminUrl(`/players/${encodeURIComponent(r.player.id)}`), r.player.nickname),
    r.flagged ? badge('banned when sent', 'red') : r.player.banned ? badge('banned', 'red') : null,
  );
}

/** Status buttons for a report: Resolve / Ignore while open, Reopen otherwise. */
function statusButtons(r: AdminReport, onChange: (next: AdminReport) => void, small = true): HTMLElement {
  const set = (status: ReportStatus, msg: string) => async (): Promise<void> => {
    try {
      const next = await api.setReportStatus(r.id, status);
      toast(msg);
      onChange(next);
      void refreshReportsNav();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  const buttons =
    r.status === 'open'
      ? [
          button('Resolve', set('resolved', `Report #${r.id} resolved`), { kind: 'primary', small }),
          button('Ignore', set('ignored', `Report #${r.id} ignored`), { kind: 'ghost', small }),
        ]
      : [button('Reopen', set('open', `Report #${r.id} reopened`), { small })];
  return h('span', { class: 'row-actions' }, ...buttons);
}

function panoPreview(r: AdminReport): HTMLElement | null {
  const loc = r.location;
  if (!loc) return null;
  const base = `/data/${loc.panoPath}`;
  const face = (name: string, cls: string): HTMLElement =>
    h(
      'a',
      { href: `${base}/base_${name}.webp`, target: '_blank', rel: 'noopener', class: `pano-face ${cls}`, title: `${name} (opens the image)` },
      h('img', { src: `${base}/base_${name}.webp`, alt: `${name} face`, loading: 'lazy', width: 160, height: 160 }),
      h('span', {}, name),
    );
  return h(
    'div',
    { class: 'pano-preview' },
    h('div', { class: 'pano-strip' }, ...SIDE_FACES.map((f) => face(f, 'side'))),
    h('div', { class: 'pano-strip pano-strip-small' }, face('top', 'small'), face('bottom', 'small')),
  );
}

function drawerContent(r: AdminReport, worlds: WorldInfo[], onChange: (next: AdminReport) => void): HTMLElement[] {
  const item = (k: string, v: Node | string | null | undefined): HTMLElement[] => [h('dt', {}, k), h('dd', {}, v ?? h('span', { class: 'muted' }, '—'))];
  const loc = r.location;
  const out: HTMLElement[] = [
    h(
      'div',
      { class: 'drawer-badges' },
      badge(TYPE_LABEL[r.type], TYPE_TONE[r.type]),
      badge(r.status, STATUS_TONE[r.status]),
      r.flagged ? badge('reporter was banned', 'red') : null,
    ),
    h('div', { class: 'form-actions' }, statusButtons(r, onChange, false)),
  ];
  if (r.categories.length) out.push(h('div', { class: 'report-cats' }, ...r.categories.map((c) => badge(CATEGORY_LABEL[c] ?? c, 'gold'))));
  out.push(r.text ? h('blockquote', { class: 'report-body' }, r.text) : h('p', { class: 'muted' }, 'No text.'));
  if (loc) {
    out.push(
      h('h3', {}, 'Place'),
      panoPreview(r)!,
      h(
        'dl',
        { class: 'facts' },
        ...item('World', worldName(worlds, loc.world)),
        ...item('Waypoint', h('code', {}, loc.waypoint || '—')),
        ...item('Node', h('span', {}, `#${loc.nodeId} · key `, h('code', {}, loc.key))),
        ...item('Position', `x ${fmtNum(Math.round(loc.x))} · y ${fmtNum(Math.round(loc.y))} · z ${fmtNum(Math.round(loc.z))} (cm)`),
        ...item('Round', `${loc.round}${loc.startKey !== loc.key ? ` (player walked away from the start ${loc.startKey})` : ' (the start node)'}`),
        ...item('Game', h('code', {}, loc.gameId)),
      ),
    );
  }
  out.push(
    h('h3', {}, 'Context'),
    h(
      'dl',
      { class: 'facts' },
      ...item('Sent', `${fmtTime(r.at)} UTC (${fmtAgo(r.at)})`),
      ...item('Status changed', r.statusAt ? `${fmtTime(r.statusAt)} UTC` : null),
      ...item('Player', playerCell(r)),
      ...item('Nickname then', r.nickname),
      ...item('Language', r.lang),
      ...item('Page', r.path ? h('code', {}, r.path) : null),
      ...item('Viewport', r.viewport),
      ...item('App version', r.appVersion ? h('code', {}, r.appVersion) : null),
      ...item('Browser', r.userAgent ? h('span', { class: 'ua' }, r.userAgent) : null),
    ),
  );
  return out;
}

export const reportsPage: Page = async (ctx: PageContext) => {
  const filter = readFilter();
  const listUrl = adminUrl(`/reports${filterQuery(filter)}`);
  const go = (next: Partial<Filter>): void => ctx.navigate(adminUrl(`/reports${filterQuery({ ...filter, ...next })}`));

  const worlds = await loadWorlds();
  if (!ctx.isCurrent()) return;
  const statusOptions: [string, string][] = [['all', 'All'], ...REPORT_STATUSES.map((s): [string, string] => [s, s[0]!.toUpperCase() + s.slice(1)])];
  const filters = h(
    'div',
    { class: 'filters' },
    select('Status', filter.status || 'all', statusOptions, (v) => go({ status: v === 'all' ? '' : (v as ReportStatus) })),
    select('Type', filter.type, [['', 'All types'], ...REPORT_TYPES.map((t): [string, string] => [t, TYPE_LABEL[t]])], (v) => go({ type: v as ReportType | '' })),
    select('World', filter.world, [['', 'All worlds'], ...worlds.map((w): [string, string] => [w.slug, w.name])], (v) => go({ world: v })),
  );
  const countsLine = h('p', { class: 'hint' });
  const host = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  const more = h('div', { class: 'form-actions' });
  const drawer = h('aside', { class: 'drawer', 'aria-label': 'Report details', hidden: true });
  mount(
    ctx.root,
    pageHeader('Reports', 'Problems sent by players: bad places, translations, bugs. There are no replies; resolve or ignore them.'),
    filters,
    countsLine,
    panel(null, host, more),
    drawer,
  );

  const rows = new Map<number, HTMLTableRowElement>();
  let shown: AdminReport | null = null;
  const tbody = h('tbody');

  const renderRow = (r: AdminReport): HTMLTableRowElement => {
    const tr = h(
      'tr',
      { class: `clickable${r.status === 'open' ? '' : ' dimmed'}${shown?.id === r.id ? ' highlight' : ''}` },
      h('td', { class: 'nowrap' }, fmtTime(r.at), h('div', { class: 'muted small' }, fmtAgo(r.at))),
      h('td', {}, badge(TYPE_LABEL[r.type], TYPE_TONE[r.type])),
      h('td', {}, summaryCell(r, worlds)),
      h('td', {}, playerCell(r)),
      h('td', {}, badge(r.status, STATUS_TONE[r.status])),
      h('td', { class: 'actions' }, statusButtons(r, update)),
    );
    tr.addEventListener('click', (ev) => {
      if ((ev.target as Element).closest('a,button,select,input')) return;
      openDrawer(r, true);
    });
    return tr;
  };

  function update(next: AdminReport): void {
    const old = rows.get(next.id);
    if (old) {
      const tr = renderRow(next);
      old.replaceWith(tr);
      rows.set(next.id, tr);
    }
    if (shown?.id === next.id) openDrawer(next, false);
    void loadCounts();
  }

  function closeDrawer(push: boolean): void {
    shown = null;
    drawer.hidden = true;
    mount(drawer);
    for (const tr of rows.values()) tr.classList.remove('highlight');
    if (push && location.pathname !== adminUrl('/reports')) history.pushState(null, '', listUrl);
  }

  function openDrawer(r: AdminReport, push: boolean): void {
    shown = r;
    for (const [id, tr] of rows) tr.classList.toggle('highlight', id === r.id);
    const closeBtn = button('Close', () => closeDrawer(true), { kind: 'ghost', small: true });
    mount(drawer, h('header', { class: 'drawer-head' }, h('h2', {}, `Report #${r.id}`), closeBtn), ...drawerContent(r, worlds, update));
    drawer.hidden = false;
    if (push) history.pushState(null, '', adminUrl(`/reports/${r.id}${filterQuery(filter)}`));
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && shown) closeDrawer(true);
  };
  document.addEventListener('keydown', onKey);

  async function loadCounts(): Promise<void> {
    try {
      const c = await api.reportCounts();
      if (!ctx.isCurrent()) return;
      const byType = REPORT_TYPES.filter((t) => c.openByType[t] > 0).map((t) => `${TYPE_LABEL[t]} ${c.openByType[t]}`);
      countsLine.textContent = `Open ${fmtNum(c.byStatus.open)}${byType.length ? ` (${byType.join(' · ')})` : ''} · resolved ${fmtNum(c.byStatus.resolved)} · ignored ${fmtNum(c.byStatus.ignored)}`;
    } catch {
      /* the list still works */
    }
  }

  const load = async (before: number | null): Promise<void> => {
    const page = await api.reports({ status: filter.status, type: filter.type, world: filter.world, limit: PAGE_SIZE, before });
    if (!ctx.isCurrent()) return;
    if (before === null) {
      if (page.reports.length === 0) {
        mount(host, empty(filter.status === 'open' && !filter.type && !filter.world ? 'No open reports. Nothing to do.' : 'No reports match.'));
      } else {
        mount(
          host,
          h('p', { class: 'hint' }, `${fmtNum(page.total)} report(s).`),
          h('div', { class: 'table-scroll' }, h('table', { class: 'grid reports-grid' }, h('thead', {}, h('tr', {}, ...['Sent (UTC)', 'Type', 'Report', 'Player', 'Status', ''].map((t) => h('th', {}, t)))), tbody)),
        );
      }
    }
    for (const r of page.reports) {
      const tr = renderRow(r);
      rows.set(r.id, tr);
      tbody.appendChild(tr);
    }
    mount(
      more,
      page.next === null
        ? null
        : button('Load more', async () => {
            try {
              await load(page.next);
            } catch (err) {
              toast(errorText(err), 'error');
            }
          }),
    );
  };

  await Promise.all([load(null), loadCounts()]);
  if (!ctx.isCurrent()) return;
  void refreshReportsNav();

  // Deep link /<ADMIN_PATH>/reports/<id>: open its drawer (it may be outside the filtered list).
  const id = Number(ctx.params[0]);
  if (ctx.params[0] && Number.isInteger(id) && id > 0) {
    try {
      const r = await api.report(id);
      if (ctx.isCurrent()) openDrawer(r, false);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  return () => document.removeEventListener('keydown', onKey);
};
