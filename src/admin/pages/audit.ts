/** Audit log (SPEC §10.9, §10.10): every admin write, newest first, 100 per page with "Load more". */
import type { AdminAuditEntry } from '../../../shared/api';
import { api, errorText } from '../api';
import { badge, button, empty, fmtTime, h, link, mount, pageHeader, panel, toast } from '../dom';
import type { Page } from '../page';
import { adminUrl } from '../base';

const TONE: Record<string, 'red' | 'gold' | 'green' | 'muted' | 'blue'> = {
  'player.ban': 'red',
  'game.delete': 'red',
  'room.close': 'red',
  'login.failed': 'red',
  'daily.override': 'gold',
  'daily.clear': 'gold',
  'player.unban': 'green',
  'report.resolve': 'green',
  'report.ignore': 'muted',
  'report.reopen': 'gold',
  login: 'muted',
  logout: 'muted',
};

/** Link the target when it names something the admin can open. */
function target(e: AdminAuditEntry): Node | string {
  if (e.action.startsWith('player.')) return link(adminUrl(`/players/${encodeURIComponent(e.target)}`), e.target);
  if (e.action.startsWith('daily.')) return link(adminUrl(`/daily/${e.target}`), e.target);
  if (e.action.startsWith('report.')) return link(adminUrl(`/reports/${encodeURIComponent(e.target)}`), `#${e.target}`);
  if (e.action.startsWith('game.')) {
    const code = /challenge=(\S+)/.exec(e.details ?? '')?.[1];
    return code ? link(adminUrl(`/challenges/${encodeURIComponent(code)}`), e.target) : e.target;
  }
  return e.target;
}

function row(e: AdminAuditEntry): HTMLElement {
  return h(
    'tr',
    {},
    h('td', { class: 'nowrap' }, fmtTime(e.at)),
    h('td', {}, badge(e.action, TONE[e.action] ?? 'blue')),
    h('td', {}, target(e)),
    h('td', { class: 'details' }, e.details ?? ''),
  );
}

export const auditPage: Page = async (ctx) => {
  const tbody = h('tbody');
  const more = h('div', { class: 'form-actions' });
  const host = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  mount(ctx.root, pageHeader('Audit log', 'Every admin write (and login attempt), newest first. Times are UTC.'), panel(null, host, more));

  const load = async (before: number | null): Promise<void> => {
    const page = await api.audit(100, before);
    if (!ctx.isCurrent()) return;
    if (before === null) {
      if (page.entries.length === 0) {
        mount(host, empty('Nothing yet.'));
        return;
      }
      mount(host, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ...['When', 'Action', 'Target', 'Details'].map((t) => h('th', {}, t)))), tbody));
    }
    for (const e of page.entries) tbody.appendChild(row(e));
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
  await load(null);
};
