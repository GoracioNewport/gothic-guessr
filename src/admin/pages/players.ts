/**
 * Players (SPEC §10.10).
 *   /<ADMIN_PATH>/players?q=…   search by nickname (substring) or id (prefix); newest first
 *   /<ADMIN_PATH>/players/<id>  one player: ban/unban (with a reason), reset nickname, games, ban history
 */
import type { AdminPlayer, AdminPlayerDetail, AdminPlayerGame } from '../../../shared/api';
import { api, errorText } from '../api';
import { badge, button, confirmAction, empty, fmtAgo, fmtDuration, fmtNum, fmtTime, h, link, mount, pageHeader, panel, table, toast } from '../dom';
import type { Page, PageContext } from '../page';
import { adminUrl } from '../base';

async function searchPage(ctx: PageContext): Promise<void> {
  const q = new URLSearchParams(location.search).get('q') ?? '';
  const input = h('input', { type: 'search', name: 'q', value: q, placeholder: 'Nickname or id…', 'aria-label': 'Search players', autocomplete: 'off' });
  const form = h('form', { class: 'search' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search'));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = input.value.trim();
    ctx.navigate(v ? adminUrl(`/players?q=${encodeURIComponent(v)}`) : adminUrl('/players'));
  });
  const results = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  mount(ctx.root, pageHeader('Players', q ? `Matches for “${q}”` : 'Newest players'), form, panel(null, results));
  input.focus();
  const list = await api.players(q, 100);
  if (!ctx.isCurrent()) return;
  if (list.players.length === 0) {
    mount(results, empty('No players match.'));
    return;
  }
  mount(
    results,
    h('p', { class: 'hint' }, list.total > list.players.length ? `Showing ${list.players.length} of ${fmtNum(list.total)}.` : `${fmtNum(list.total)} player(s).`),
    table<AdminPlayer>(
      list.players,
      [
        { head: 'Nickname', cell: (p) => h('span', { class: 'player-cell' }, link(adminUrl(`/players/${encodeURIComponent(p.id)}`), p.nickname), p.banned ? badge('banned', 'red') : null) },
        { head: 'Id', cell: (p) => h('code', {}, p.id) },
        { head: 'Created (UTC)', cell: (p) => fmtTime(p.createdAt) },
        { head: 'Last seen', cell: (p) => fmtAgo(p.lastSeenAt) },
        { head: 'Games', class: 'num', cell: (p) => fmtNum(p.games) },
      ],
      { onRow: (p) => ctx.navigate(adminUrl(`/players/${encodeURIComponent(p.id)}`)), rowClass: (p) => (p.banned ? 'dimmed' : '') },
    ),
  );
}

function render(ctx: PageContext, d: AdminPlayerDetail): void {
  const p = d.player;
  const reason = h('input', { type: 'text', maxlength: 200, placeholder: 'Reason (optional, internal)', 'aria-label': 'Ban reason' });
  const update = (next: AdminPlayerDetail, msg: string): void => {
    toast(msg);
    render(ctx, next);
  };
  const banControls = p.banned
    ? h(
        'div',
        { class: 'form-actions' },
        button('Unban', async () => {
          try {
            update(await api.ban(p.id, false), `${p.nickname} is unbanned`);
          } catch (err) {
            toast(errorText(err), 'error');
          }
        }),
      )
    : h(
        'div',
        { class: 'form-actions' },
        reason,
        button(
          'Ban',
          async () => {
            if (!confirmAction(`Ban ${p.nickname}? They disappear from every leaderboard and cannot use rooms; solo play stays possible.`)) return;
            try {
              update(await api.ban(p.id, true, reason.value.trim() || undefined), `${p.nickname} is banned`);
            } catch (err) {
              toast(errorText(err), 'error');
            }
          },
          { kind: 'danger' },
        ),
      );
  const resetBtn = button('Reset nickname', async () => {
    if (!confirmAction(`Reset the nickname “${p.nickname}” to a default Nameless Hero name?`)) return;
    try {
      const next = await api.resetNickname(p.id);
      update(next, `Nickname reset to ${next.player.nickname}`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  const item = (k: string, v: Node | string): HTMLElement[] => [h('dt', {}, k), h('dd', {}, v)];
  mount(
    ctx.root,
    pageHeader(p.nickname, h('span', {}, p.banned ? badge('banned', 'red') : badge('active', 'green'), ' ', h('code', {}, p.id)), link(adminUrl('/players'), '← Search')),
    h(
      'div',
      { class: 'two-col' },
      panel(
        'Player',
        h(
          'dl',
          { class: 'facts' },
          ...item('Nickname', p.nickname),
          ...item('Created', fmtTime(p.createdAt)),
          ...item('Last seen', `${fmtTime(p.lastSeenAt)} (${fmtAgo(p.lastSeenAt)})`),
          ...item('Games', fmtNum(p.games)),
        ),
      ),
      panel('Moderation', banControls, h('div', { class: 'form-actions' }, resetBtn), d.bans.length ? h('h3', {}, 'Ban history') : null, d.bans.length ? h('ul', { class: 'history' }, ...d.bans.map((b) => h('li', {}, `${fmtTime(b.at)} — ${b.action}`, b.reason ? ` (${b.reason})` : ''))) : null),
    ),
    panel(
      `Games (${d.games.length})`,
      d.games.length === 0
        ? empty('No games.')
        : table<AdminPlayerGame>(
            d.games,
            [
              { head: 'Started (UTC)', cell: (g) => fmtTime(g.createdAt) },
              { head: 'Kind', cell: (g) => g.kind },
              { head: 'Challenge', cell: (g) => link(adminUrl(`/challenges/${encodeURIComponent(g.challengeCode)}`), g.challengeCode) },
              { head: 'Rounds', class: 'num', cell: (g) => fmtNum(g.rounds) },
              { head: 'Total', class: 'num', cell: (g) => fmtNum(g.total) },
              { head: 'Time', class: 'num', cell: (g) => fmtDuration(g.timeMs) },
              { head: 'State', cell: (g) => h('span', {}, g.finishedAt ? badge('finished', 'green') : badge('in progress', 'blue'), g.hidden ? badge('hidden', 'muted') : null) },
            ],
            { onRow: (g) => ctx.navigate(adminUrl(`/challenges/${encodeURIComponent(g.challengeCode)}`)) },
          ),
    ),
  );
}

export const playersPage: Page = async (ctx) => {
  const id = ctx.params[0];
  if (!id) return searchPage(ctx);
  mount(ctx.root, pageHeader('Player'), h('p', { class: 'loading' }, 'Loading…'));
  const detail = await api.player(id);
  if (ctx.isCurrent()) render(ctx, detail);
};
