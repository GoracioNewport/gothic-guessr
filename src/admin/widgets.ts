/**
 * Widgets shared by several admin pages: the moderation leaderboard (daily and challenges), a challenge summary, the
 * settings editor (daily overrides) and the world list (from the public `/data/worlds.json`).
 */
import { TIME_LIMITS } from '../../shared/api';
import type { AdminChallengeView, AdminLeaderboardEntry, GameMode, PublicSettings } from '../../shared/api';
import { api, errorText } from './api';
import { badge, button, confirmAction, empty, fmtDuration, fmtNum, fmtTime, h, link, mount, table, toast } from './dom';
import { adminUrl } from './base';

export interface WorldInfo {
  slug: string;
  name: string;
}

let worldsPromise: Promise<WorldInfo[]> | null = null;

/** Worlds of the public dataset (slug + English name); [] when it cannot be loaded. */
export function loadWorlds(): Promise<WorldInfo[]> {
  worldsPromise ??= fetch('/data/worlds.json')
    .then((r) => (r.ok ? r.json() : { worlds: [] }))
    .then((j: { worlds?: { slug: string; name: string }[] }) => (j.worlds ?? []).map((w) => ({ slug: w.slug, name: w.name })))
    .catch(() => []);
  return worldsPromise;
}

const MODE_LABEL: Record<GameMode, string> = { classic: 'Classic', mixed: 'Mixed', hardcore: 'Hardcore' };

export function timeLimitText(s: number): string {
  if (s === 0) return 'no limit';
  return s < 60 ? `${s} s` : `${s / 60} min`;
}

/** `Mixed · khorinis, valley · moving · 2 min · 5 rounds` */
export function settingsText(s: PublicSettings, worlds: WorldInfo[] = []): string {
  const name = (slug: string): string => worlds.find((w) => w.slug === slug)?.name ?? slug;
  const move = s.noLook ? 'no look' : s.noMove ? 'no move' : 'moving';
  return [MODE_LABEL[s.mode] ?? s.mode, s.worlds.map(name).join(', '), move, timeLimitText(s.timeLimit), `${s.rounds} rounds`].join(' · ');
}

/** The moderation leaderboard; `onChange` receives the refreshed challenge after hide/unhide/delete. */
export function moderationBoard(view: AdminChallengeView, onChange: (v: AdminChallengeView) => void): HTMLElement {
  if (view.entries.length === 0) return empty('No finished games yet.');
  const act = async (fn: () => Promise<AdminChallengeView>, done: string): Promise<void> => {
    try {
      onChange(await fn());
      toast(done);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  return table<AdminLeaderboardEntry>(
    view.entries,
    [
      { head: '#', class: 'num', cell: (e) => (e.rank > 0 ? String(e.rank) : '—') },
      {
        head: 'Player',
        cell: (e) =>
          h(
            'span',
            { class: 'player-cell' },
            link(adminUrl(`/players/${encodeURIComponent(e.playerId)}`), e.nickname),
            e.banned ? badge('banned', 'red') : null,
            e.hidden ? badge('hidden', 'muted') : null,
          ),
      },
      { head: 'Total', class: 'num', cell: (e) => h('b', {}, fmtNum(e.total)) },
      { head: 'Rounds', cell: (e) => h('span', { class: 'rounds' }, e.rounds.map((r) => fmtNum(r)).join(' · ')) },
      { head: 'Time', class: 'num', cell: (e) => fmtDuration(e.timeMs) },
      { head: 'Finished (UTC)', cell: (e) => fmtTime(e.finishedAt) },
      {
        head: '',
        class: 'actions',
        cell: (e) =>
          h(
            'span',
            { class: 'row-actions' },
            button(
              e.hidden ? 'Unhide' : 'Hide',
              () => act(() => api.hideGame(e.gameId, !e.hidden), e.hidden ? `Entry of ${e.nickname} is visible again` : `Entry of ${e.nickname} hidden`),
              { small: true },
            ),
            button(
              'Delete',
              async () => {
                if (!confirmAction(`Delete the game of ${e.nickname} (${fmtNum(e.total)} points)? The player can then play this challenge again. This cannot be undone.`)) return;
                await act(() => api.deleteGame(e.gameId), `Game of ${e.nickname} deleted`);
              },
              { small: true, kind: 'danger' },
            ),
          ),
      },
    ],
    { rowClass: (e) => (e.hidden || e.banned ? 'dimmed' : '') },
  );
}

/** Key facts of a challenge as a definition list. */
export function challengeFacts(view: AdminChallengeView, worlds: WorldInfo[]): HTMLElement {
  const item = (k: string, v: Node | string): HTMLElement[] => [h('dt', {}, k), h('dd', {}, v)];
  return h(
    'dl',
    { class: 'facts' },
    ...item('Code', h('code', {}, view.code)),
    ...item('Kind', view.kind),
    ...item('Settings', settingsText(view.settings, worlds)),
    ...item('Created', fmtTime(view.createdAt)),
    ...item(
      'Created by',
      view.createdBy ? link(adminUrl(`/players/${encodeURIComponent(view.createdBy.id)}`), view.createdBy.nickname) : '—',
    ),
    ...(view.date ? item('Date', view.date) : []),
    ...(view.roomCode ? item('Room', view.roomCode) : []),
    ...item('Status', view.status === 'running' ? badge('room game running', 'gold') : 'open'),
    ...item('Games', `${fmtNum(view.games)} (${fmtNum(view.inProgress)} in progress)`),
    ...item('Public link', h('a', { href: `/c/${encodeURIComponent(view.code)}`, target: '_blank', rel: 'noopener' }, `/c/${view.code}`)),
  );
}

/**
 * Settings editor for a daily override. Returns the form and a getter of the current value (null when invalid).
 */
export function settingsEditor(initial: PublicSettings, worlds: WorldInfo[]): { el: HTMLElement; value: () => PublicSettings | null } {
  const all = worlds.length > 0 ? worlds : initial.worlds.map((slug) => ({ slug, name: slug }));
  const mode = h('select', { name: 'mode', 'aria-label': 'Mode' }, ...(['classic', 'mixed', 'hardcore'] as GameMode[]).map((m) => h('option', { value: m, selected: m === initial.mode }, MODE_LABEL[m])));
  const worldBoxes = all.map((w) => {
    const box = h('input', { type: 'checkbox', value: w.slug, checked: initial.worlds.includes(w.slug) });
    return { slug: w.slug, box, el: h('label', { class: 'check' }, box, w.name) };
  });
  const noMove = h('input', { type: 'checkbox', checked: initial.noMove });
  const noLook = h('input', { type: 'checkbox', checked: initial.noLook });
  noLook.addEventListener('change', () => {
    if (noLook.checked) noMove.checked = true;
    noMove.disabled = noLook.checked;
  });
  noMove.disabled = initial.noLook;
  const limit = h('select', { name: 'timeLimit', 'aria-label': 'Time limit' }, ...TIME_LIMITS.map((s) => h('option', { value: String(s), selected: s === initial.timeLimit }, timeLimitText(s))));
  const el = h(
    'div',
    { class: 'settings-editor' },
    h('label', { class: 'field' }, h('span', {}, 'Mode'), mode),
    h('div', { class: 'field' }, h('span', {}, 'Worlds'), h('div', { class: 'checks' }, ...worldBoxes.map((w) => w.el))),
    h('div', { class: 'field' }, h('span', {}, 'Restrictions'), h('div', { class: 'checks' }, h('label', { class: 'check' }, noMove, 'No move'), h('label', { class: 'check' }, noLook, 'No look (implies no move)'))),
    h('label', { class: 'field' }, h('span', {}, 'Time per round'), limit),
    h('p', { class: 'hint' }, `Rounds: ${initial.rounds} (fixed for the daily).`),
  );
  return {
    el,
    value: () => {
      const picked = worldBoxes.filter((w) => w.box.checked).map((w) => w.slug);
      if (picked.length === 0) return null;
      return {
        mode: mode.value as GameMode,
        worlds: picked,
        noMove: noMove.checked || noLook.checked,
        noLook: noLook.checked,
        timeLimit: Number(limit.value),
        rounds: initial.rounds,
      };
    },
  };
}

/** Render `view` into `host` and keep it live across moderation actions. */
export function liveBoard(host: HTMLElement, view: AdminChallengeView, onUpdate?: (v: AdminChallengeView) => void): void {
  const draw = (v: AdminChallengeView): void => {
    mount(host, moderationBoard(v, (nv) => {
      onUpdate?.(nv);
      draw(nv);
    }));
  };
  draw(view);
}
