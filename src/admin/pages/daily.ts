/**
 * Daily management (SPEC §10.10).
 *   /<ADMIN_PATH>/daily          calendar list: 30 days back … 14 days ahead (wider via the range form)
 *   /<ADMIN_PATH>/daily/<date>   one day: settings override (future days freely; a day with games needs "force"),
 *                                back to defaults, and the day's leaderboard with hide/unhide/delete.
 */
import type { AdminDailyDetail, AdminDailyRowEx } from '../../../shared/api';
import { api, errorText } from '../api';
import { badge, button, confirmAction, empty, fmtNum, h, link, mount, pageHeader, panel, table, toast } from '../dom';
import type { Page, PageContext } from '../page';
import { challengeFacts, liveBoard, loadWorlds, settingsEditor, settingsText } from '../widgets';
import type { WorldInfo } from '../widgets';
import { adminUrl } from '../base';

function whenBadge(r: AdminDailyRowEx): HTMLElement {
  return r.when === 'today' ? badge('today', 'gold') : r.when === 'future' ? badge('upcoming', 'blue') : badge('past', 'muted');
}

async function listPage(ctx: PageContext): Promise<void> {
  const params = new URLSearchParams(location.search);
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  mount(ctx.root, pageHeader('Daily challenges'), h('p', { class: 'loading' }, 'Loading…'));
  const [list, worlds] = await Promise.all([api.dailyList(from, to), loadWorlds()]);
  if (!ctx.isCurrent()) return;

  const fromInput = h('input', { type: 'date', value: list.days.at(-1)?.date ?? '', 'aria-label': 'From date' });
  const toInput = h('input', { type: 'date', value: list.days[0]?.date ?? '', 'aria-label': 'To date' });
  const range = h('form', { class: 'range' }, fromInput, h('span', { class: 'muted' }, '–'), toInput, h('button', { type: 'submit', class: 'btn btn-sm' }, 'Show'));
  range.addEventListener('submit', (ev) => {
    ev.preventDefault();
    ctx.navigate(adminUrl(`/daily?from=${fromInput.value}&to=${toInput.value}`));
  });
  const jump = h('input', { type: 'date', 'aria-label': 'Open a date', value: list.today });
  const jumpForm = h('form', { class: 'range' }, jump, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Open date'));
  jumpForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (jump.value) ctx.navigate(adminUrl(`/daily/${jump.value}`));
  });

  mount(
    ctx.root,
    pageHeader('Daily challenges', `Today (UTC): ${list.today}`, jumpForm, range),
    panel(
      null,
      table<AdminDailyRowEx>(
        list.days,
        [
          { head: 'Date', cell: (r) => link(adminUrl(`/daily/${r.date}`), r.date) },
          { head: '', cell: (r) => whenBadge(r) },
          {
            head: 'Settings',
            cell: (r) => h('span', {}, settingsText(r.settings, worlds), ' ', r.overridden ? badge('override', 'gold') : null),
          },
          { head: 'Players', class: 'num', cell: (r) => (r.games > r.players ? `${fmtNum(r.players)} (+${r.games - r.players} unfinished/hidden)` : fmtNum(r.players)) },
          { head: 'Best', class: 'num', cell: (r) => (r.best === null ? '—' : fmtNum(r.best)) },
        ],
        { onRow: (r) => ctx.navigate(adminUrl(`/daily/${r.date}`)), rowClass: (r) => (r.when === 'today' ? 'highlight' : '') },
      ),
    ),
  );
}

async function detailPage(ctx: PageContext, date: string): Promise<void> {
  mount(ctx.root, pageHeader(`Daily ${date}`), h('p', { class: 'loading' }, 'Loading…'));
  const [detail, worlds] = await Promise.all([api.daily(date), loadWorlds()]);
  if (!ctx.isCurrent()) return;
  render(ctx, detail, worlds);
}

function render(ctx: PageContext, detail: AdminDailyDetail, worlds: WorldInfo[]): void {
  const { row, challenge } = detail;
  const editor = settingsEditor(row.settings, worlds);
  const needsForce = row.games > 0;
  const force = h('input', { type: 'checkbox', name: 'force' });
  const status = h('p', { class: 'form-status', role: 'status' });

  const save = button(
    'Save override',
    async () => {
      const settings = editor.value();
      if (!settings) {
        status.textContent = 'Pick at least one world.';
        return;
      }
      if (needsForce && !force.checked) {
        status.textContent = `This day already has ${row.games} game(s). Tick "force" to change it anyway.`;
        return;
      }
      if (needsForce && !confirmAction(`${row.games} game(s) were played with the old settings; results will not be comparable. Override anyway?`)) return;
      try {
        const next = await api.setDaily(row.date, settings, force.checked);
        toast(`Settings of ${row.date} saved`);
        render(ctx, next, worlds);
      } catch (err) {
        status.textContent = errorText(err);
      }
    },
    { kind: 'primary' },
  );
  const reset = row.overridden
    ? button('Back to defaults', async () => {
        if (needsForce && !force.checked) {
          status.textContent = `This day already has ${row.games} game(s). Tick "force" to reset it anyway.`;
          return;
        }
        if (!confirmAction(`Remove the override of ${row.date} and use the default daily settings?`)) return;
        try {
          const next = await api.clearDaily(row.date, force.checked);
          toast(`${row.date} uses the defaults again`);
          render(ctx, next, worlds);
        } catch (err) {
          status.textContent = errorText(err);
        }
      })
    : null;

  const boardHost = h('div');
  const factsHost = h('div');
  if (challenge) {
    mount(factsHost, challengeFacts(challenge, worlds));
    liveBoard(boardHost, challenge, (v) => mount(factsHost, challengeFacts(v, worlds)));
  } else {
    mount(boardHost, empty('Nobody has played this day yet (the challenge is created on the first play or by an override).'));
  }

  mount(
    ctx.root,
    pageHeader(
      `Daily ${row.date}`,
      h('span', {}, whenBadge(row), ' ', row.overridden ? badge('override', 'gold') : badge('default settings', 'muted'), ' ', `${fmtNum(row.players)} on the leaderboard, ${fmtNum(row.games)} game(s) in total`),
      link(adminUrl('/daily'), '← All days'),
    ),
    h(
      'div',
      { class: 'two-col' },
      panel(
        'Settings',
        h('p', { class: 'current' }, 'Current: ', h('b', {}, settingsText(row.settings, worlds))),
        editor.el,
        needsForce
          ? h('label', { class: 'check force' }, force, h('span', {}, h('b', {}, 'Force'), ` — this day has ${row.games} game(s); results become incomparable.`))
          : h('p', { class: 'hint' }, row.when === 'future' ? 'Upcoming day: change freely.' : 'No games yet: change freely.'),
        h('div', { class: 'form-actions' }, save, reset),
        status,
      ),
      panel('Challenge', challenge ? factsHost : empty('Not created yet.')),
    ),
    panel('Leaderboard', boardHost),
  );
}

export const dailyPage: Page = async (ctx) => {
  const date = ctx.params[0];
  if (date) return detailPage(ctx, date);
  return listPage(ctx);
};
