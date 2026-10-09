/**
 * DOM pieces of the room screens (SPEC §10.7): the "X guessed" ticks and the duel HP bars of the round HUD, the
 * round table of the result card, the final standings and the duel banner. Plain DOM over the pure helpers of
 * src/ui/roomstate.ts; every text goes through t(). Styles: `.g2-room-*` / `.g2-hp-*` in src/style.css.
 */
import type { RoomPlayer } from '../../shared/api';
import { formatDistance, formatDuration, formatNumber, t } from '../i18n';
import { el, formatScore, nicknameEl } from './dom';
import { DUEL_START_HP, hpRatio, hpWidth } from './roomstate';
import type { DuelOutcome, RoundRow, StandingRow } from './roomstate';

/**
 * A nickname span (any script; `dir=auto`) with the player's colour dot in front. The viewer's own dot is the
 * blue of their own guess marker on the result map, so the table and the map agree.
 */
export function playerName(name: string, color?: string, me = false): HTMLElement {
  const box = el('span', 'g2-room-name');
  if (color) {
    const dot = el('span', 'g2-room-dot');
    dot.style.background = me ? 'var(--g2-guess)' : color;
    dot.setAttribute('aria-hidden', 'true');
    box.appendChild(dot);
  }
  const nick = nicknameEl(el('span', 'g2-room-nick', name));
  box.appendChild(nick);
  if (me) box.appendChild(el('span', 'g2-room-you', ` (${t('room.you')})`));
  return box;
}

// ---------------------------------------------------------------------------------------------
// Round HUD
// ---------------------------------------------------------------------------------------------

/** The players of the round with a tick for those who guessed ("2/3 guessed" heading). */
export function guessedPanel(players: readonly RoomPlayer[], guessed: readonly string[], me: string | null, colors: ReadonlyMap<string, string>): HTMLElement {
  const panel = el('div', 'g2-panel g2-room-ticks');
  const inGame = players.filter((p) => p.connected || guessed.includes(p.id));
  const done = inGame.filter((p) => guessed.includes(p.id)).length;
  panel.appendChild(el('div', 'g2-room-ticks-head', t('round.guessedCount', { count: done, total: inGame.length })));
  const list = el('ul', 'g2-room-ticks-list');
  for (const p of players) {
    const has = guessed.includes(p.id);
    const li = el('li', `g2-room-tick${has ? ' g2-room-tick-done' : ''}${p.connected ? '' : ' g2-room-tick-away'}`);
    li.dataset.player = p.id;
    const mark = el('span', 'g2-room-tick-mark', has ? '✔' : p.connected ? '…' : '×');
    mark.setAttribute('aria-hidden', 'true');
    li.appendChild(mark);
    li.appendChild(playerName(p.nickname, colors.get(p.id), p.id === me));
    li.title = has ? t('room.guessed') : p.connected ? t('room.stillGuessing') : t('room.disconnected');
    list.appendChild(li);
  }
  panel.appendChild(list);
  return panel;
}

/** A Gothic health bar: BAR_BACK frame, BAR_HEALTH fill. */
export function hpBar(hp: number, max = DUEL_START_HP): { root: HTMLElement; set(hp: number): void } {
  const root = el('div', 'g2-bar g2-hp-bar');
  root.setAttribute('role', 'meter');
  root.setAttribute('aria-label', t('duel.health'));
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', String(max));
  const fill = el('div', 'g2-bar-fill g2-hp-fill');
  root.appendChild(fill);
  const set = (value: number): void => {
    fill.style.width = hpWidth(value, max);
    root.setAttribute('aria-valuenow', String(Math.round(value)));
    root.classList.toggle('g2-hp-low', hpRatio(value, max) <= 0.25);
  };
  set(hp);
  return { root, set };
}

export interface DuelSide {
  id: string;
  name: string;
  hp: number;
  me: boolean;
}

/**
 * Both duel players' HP bars with numbers and the round's damage multiplier. `before` animates the bars from the
 * previous HP (result card) and shows the damage taken.
 */
export function duelPanel(
  sides: readonly DuelSide[],
  multiplier: number,
  opts: { colors?: ReadonlyMap<string, string>; before?: Record<string, number> | null; compact?: boolean } = {},
): HTMLElement {
  const panel = el('div', `g2-panel g2-duel${opts.compact ? ' g2-duel-compact' : ''}`);
  const head = el('div', 'g2-duel-head');
  const mult = el('span', 'g2-duel-mult', t('duel.multiplier', { value: formatNumber(multiplier) }));
  mult.title = t('duel.multiplierLabel');
  head.append(el('span', 'g2-duel-label', t('duel.multiplierLabel')), mult);
  panel.appendChild(head);
  for (const side of sides) {
    const row = el('div', `g2-duel-side${side.me ? ' g2-duel-me' : ''}`);
    row.dataset.player = side.id;
    const top = el('div', 'g2-duel-side-top');
    top.appendChild(playerName(side.name, opts.colors?.get(side.id), side.me));
    const value = el('span', 'g2-duel-hp', `${formatNumber(Math.round(side.hp))} ${t('duel.hp')}`);
    top.appendChild(value);
    row.appendChild(top);
    const from = opts.before?.[side.id];
    const bar = hpBar(from ?? side.hp);
    row.appendChild(bar.root);
    if (from !== undefined && from !== side.hp) {
      const lost = Math.max(0, Math.round(from - side.hp));
      if (lost > 0) row.appendChild(el('span', 'g2-duel-damage', t('duel.damage', { damage: formatNumber(lost) })));
      // Next frame: let the transition run from the old width.
      requestAnimationFrame(() => requestAnimationFrame(() => bar.set(side.hp)));
    }
    panel.appendChild(row);
  }
  return panel;
}

/** A one-line banner in the HUD slot (duel countdown, waiting for the others). */
export function hudBanner(text: string, kind: 'info' | 'alert' = 'info'): HTMLElement {
  const box = el('div', `g2-panel g2-room-banner g2-room-banner-${kind}`, text);
  box.setAttribute('role', kind === 'alert' ? 'alert' : 'status');
  return box;
}

// ---------------------------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------------------------

/** The round table: rank, player, distance (or what went wrong), points, time, running total (and duel HP). */
export function roundTable(rows: readonly RoundRow[], opts: { colors: ReadonlyMap<string, string>; totals: ReadonlyMap<string, number>; duel: boolean }): HTMLElement {
  const wrap = el('div', 'g2-room-table-wrap');
  const table = el('table', 'g2-table g2-room-table');
  const head = table.createTHead().insertRow();
  const cols = [t('lb.rank'), t('lb.player'), t('summary.col.distance'), t('summary.col.score'), t('summary.col.time')];
  cols.push(opts.duel ? t('duel.hp') : t('summary.total'));
  for (const h of cols) head.appendChild(el('th', undefined, h));
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    tr.dataset.player = r.playerId;
    if (r.me) tr.className = 'g2-lb-me';
    tr.insertCell().textContent = t('room.place', { rank: r.rank });
    const name = tr.insertCell();
    name.className = 'g2-table-world';
    name.appendChild(playerName(r.name, opts.colors.get(r.playerId), r.me));
    const d = tr.insertCell();
    if (r.guess === null) {
      d.className = 'g2-table-wrong';
      d.textContent = t('result.noGuess');
    } else if (r.wrongWorld || r.distanceM === null) {
      d.className = 'g2-table-wrong';
      d.textContent = t('summary.wrongWorld');
    } else {
      d.textContent = formatDistance(r.distanceM);
    }
    tr.insertCell().textContent = formatScore(r.score);
    tr.insertCell().textContent = formatDuration(r.timeMs);
    const last = tr.insertCell();
    if (opts.duel) {
      last.textContent = r.hp !== undefined ? formatNumber(Math.round(r.hp)) : '—';
      if (r.damage) {
        last.appendChild(el('span', 'g2-duel-damage', ` ${t('duel.damage', { damage: formatNumber(Math.round(r.damage)) })}`));
      }
    } else {
      const total = opts.totals.get(r.playerId);
      last.textContent = total === undefined ? '—' : formatScore(total);
    }
  }
  wrap.appendChild(table);
  return wrap;
}

/** Final standings: rank, player, points, time (duel: HP first). */
export function standingsTable(rows: readonly StandingRow[], opts: { colors: ReadonlyMap<string, string>; duel: boolean }): HTMLElement {
  const table = el('table', 'g2-table g2-room-table g2-room-standings');
  const head = table.createTHead().insertRow();
  const cols = [t('lb.rank'), t('lb.player')];
  if (opts.duel) cols.push(t('duel.hp'));
  cols.push(t('lb.total'), t('lb.time'));
  for (const h of cols) head.appendChild(el('th', undefined, h));
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    tr.dataset.player = r.playerId;
    const cls = [r.me ? 'g2-lb-me' : '', r.winner ? 'g2-room-winner' : ''].filter(Boolean).join(' ');
    if (cls) tr.className = cls;
    tr.insertCell().textContent = t('room.place', { rank: r.rank });
    const name = tr.insertCell();
    name.className = 'g2-table-world';
    name.appendChild(playerName(r.nickname, opts.colors.get(r.playerId), r.me));
    if (opts.duel) tr.insertCell().textContent = formatNumber(Math.round(r.hp ?? 0));
    tr.insertCell().textContent = formatScore(r.total);
    tr.insertCell().textContent = formatDuration(r.timeMs);
  }
  return table;
}

/** The duel's end: Victory / Defeat / Draw with the reason (KO, forfeit, round cap). */
export function duelBanner(outcome: DuelOutcome, names: ReadonlyMap<string, string>, rounds: number): HTMLElement {
  const box = el('div', `g2-duel-banner g2-duel-banner-${outcome.kind}`);
  if (outcome.kind === 'draw') {
    box.appendChild(el('div', 'g2-duel-banner-title', t('duel.draw')));
    box.appendChild(el('p', 'g2-muted', t('duel.roundCap', { rounds })));
    return box;
  }
  const winner = names.get(outcome.winner) ?? '?';
  const loser = outcome.loser ? (names.get(outcome.loser) ?? '?') : '?';
  const title = outcome.kind === 'win' ? t('duel.youWin') : outcome.kind === 'lose' ? t('duel.youLose') : t('duel.winner', { name: winner });
  box.appendChild(el('div', 'g2-duel-banner-title', title));
  let reason: string;
  if (outcome.reason === 'ko') reason = `${t('duel.ko')} ${t('duel.winner', { name: winner })}`;
  else if (outcome.reason === 'forfeit') reason = t('duel.forfeit', { name: loser });
  else reason = t('duel.roundCap', { rounds });
  box.appendChild(el('p', 'g2-duel-banner-reason', reason));
  return box;
}
