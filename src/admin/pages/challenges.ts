/**
 * Challenges (SPEC §10.10): look up a challenge by code (`/c/<code>` links, `daily-YYYY-MM-DD`), see its facts and
 * moderate its leaderboard.  /<ADMIN_PATH>/challenges[/<code>]
 */
import { api, AdminApiError } from '../api';
import { empty, h, link, mount, pageHeader, panel } from '../dom';
import type { Page, PageContext } from '../page';
import { challengeFacts, liveBoard, loadWorlds } from '../widgets';
import { adminUrl } from '../base';

function lookupForm(ctx: PageContext, value = ''): HTMLElement {
  const input = h('input', { type: 'search', value, placeholder: 'Challenge code or /c/… link', 'aria-label': 'Challenge code', autocomplete: 'off' });
  const form = h('form', { class: 'search' }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Look up'));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    // Accept a pasted link: take the part after /c/.
    const raw = input.value.trim();
    const code = (/\/c\/([^/?#]+)/.exec(raw)?.[1] ?? raw).trim();
    if (code) ctx.navigate(adminUrl(`/challenges/${encodeURIComponent(decodeURIComponent(code))}`));
  });
  queueMicrotask(() => input.focus());
  return form;
}

export const challengesPage: Page = async (ctx) => {
  const code = ctx.params[0];
  if (!code) {
    mount(
      ctx.root,
      pageHeader('Challenges', 'Every solo game and finished room game is a challenge with a share link.'),
      lookupForm(ctx),
      h('p', { class: 'hint' }, 'Daily challenges have codes like ', h('code', {}, 'daily-2026-10-07'), '; they are also reachable from ', link(adminUrl('/daily'), 'Daily'), '.'),
    );
    return;
  }
  mount(ctx.root, pageHeader(`Challenge ${code}`), lookupForm(ctx, code), h('p', { class: 'loading' }, 'Loading…'));
  let view;
  try {
    view = await api.challenge(code);
  } catch (err) {
    if (!(err instanceof AdminApiError) || err.code !== 'not_found') throw err;
    if (ctx.isCurrent()) mount(ctx.root, pageHeader(`Challenge ${code}`), lookupForm(ctx, code), empty(`No challenge with the code “${code}”.`));
    return;
  }
  const worlds = await loadWorlds();
  if (!ctx.isCurrent()) return;
  const factsHost = h('div', {}, challengeFacts(view, worlds));
  const boardHost = h('div');
  liveBoard(boardHost, view, (v) => mount(factsHost, challengeFacts(v, worlds)));
  mount(
    ctx.root,
    pageHeader(`Challenge ${view.code}`, view.date ? h('span', {}, 'Daily of ', link(adminUrl(`/daily/${view.date}`), view.date)) : view.kind, link(adminUrl('/challenges'), '← Look up another')),
    lookupForm(ctx, view.code),
    h('div', { class: 'two-col' }, panel('Challenge', factsHost), panel('Notes', h('p', { class: 'hint' }, 'Hidden entries and banned players are not on the public leaderboard; they keep rank “—” here. Deleting a game lets that player play the challenge again.'))),
    panel('Leaderboard', boardHost),
  );
};
