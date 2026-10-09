/**
 * Leaderboard table (SPEC §10.4, §10.7): rank, player, points, time; the caller's row highlighted. When the
 * caller's entry is outside the listed top entries it is appended after a gap row. An `aside` (the player's nickname
 * editor after a game) sits at the right end of the heading line.
 *
 * {@link autoFitLeaderboard} keeps a page that must fit 1280×720 (daily, summary, challenge) free of an inner
 * scrollbar: it hides the lowest rows (never the caller's) until the scrolling card fits, keeps at least
 * {@link FIT_MIN_ROWS}, and offers "Show all" for the rest (after which the card may scroll: the player asked).
 */
import type { LeaderboardEntry, LeaderboardView } from '../../shared/api';
import { formatDuration, t } from '../i18n';
import { el, formatScore, nicknameEl } from './dom';

export interface LeaderboardOptions {
  /** Heading above the table (default "Leaderboard"); null for none. */
  heading?: string | null;
  /** A muted note on the heading line (e.g. the player count). */
  note?: string;
  /** The caller is banned: their games never appear, say so. */
  banned?: boolean;
  /** Shown at the right end of the heading line (e.g. the nickname with Change, src/ui/nickname.ts). */
  aside?: HTMLElement;
}

/** Fewest top rows a fitted leaderboard shows. */
export const FIT_MIN_ROWS = 3;

function row(entry: LeaderboardEntry): HTMLTableRowElement {
  const tr = el('tr');
  if (entry.me) tr.className = 'g2-lb-me';
  tr.dataset.rank = String(entry.rank);
  tr.appendChild(el('td', 'g2-lb-rank', `${entry.rank}.`));
  const name = el('td', 'g2-lb-name');
  // Nicknames may be in any script: nicknameEl keeps a word from mixing the game font and the fallback.
  const nick = nicknameEl(el('span', 'g2-lb-nick', entry.nickname));
  name.appendChild(nick);
  if (entry.me) name.appendChild(el('span', 'g2-lb-you', ` (${t('lb.you')})`));
  tr.appendChild(name);
  tr.appendChild(el('td', 'g2-lb-total', formatScore(entry.total)));
  tr.appendChild(el('td', 'g2-lb-time', formatDuration(entry.timeMs)));
  return tr;
}

function gapRow(extraClass = ''): HTMLTableRowElement {
  const gap = el('tr', `g2-lb-gap${extraClass ? ` ${extraClass}` : ''}`);
  const cell = el('td', undefined, '…');
  cell.colSpan = 4;
  gap.appendChild(cell);
  return gap;
}

/** Build the leaderboard block for `view`. */
export function leaderboard(view: LeaderboardView, opts: LeaderboardOptions = {}): HTMLElement {
  const box = el('section', 'g2-lb');
  if (opts.heading !== null || opts.note || opts.aside) {
    const head = el('div', 'g2-lb-head');
    if (opts.heading !== null) head.appendChild(el('h3', 'g2-legend g2-lb-heading', opts.heading ?? t('lb.heading')));
    if (opts.note) head.appendChild(el('span', 'g2-muted g2-lb-note', opts.note));
    if (opts.aside) {
      opts.aside.classList.add('g2-lb-aside');
      head.appendChild(opts.aside);
    }
    box.appendChild(head);
  }
  if (view.entries.length === 0) {
    box.appendChild(el('p', 'g2-muted g2-lb-empty', t('lb.empty')));
  } else {
    const table = el('table', 'g2-table g2-lb-table');
    const head = table.createTHead().insertRow();
    for (const h of [t('lb.rank'), t('lb.player'), t('lb.total'), t('lb.time')]) head.appendChild(el('th', undefined, h));
    const body = table.createTBody();
    for (const entry of view.entries) body.appendChild(row(entry));
    const me = view.me;
    if (me && !view.entries.some((e) => e.me)) {
      body.appendChild(gapRow());
      body.appendChild(row(me));
    }
    box.appendChild(table);
  }
  if (opts.banned) box.appendChild(el('p', 'g2-muted', t('lb.banned')));
  return box;
}

/** Visible-row bookkeeping of one fit pass. */
function reset(box: HTMLElement): void {
  for (const tr of box.querySelectorAll<HTMLElement>('tr.g2-lb-hidden')) tr.classList.remove('g2-lb-hidden');
  for (const tr of box.querySelectorAll('tr.g2-lb-fit-gap')) tr.remove();
  box.querySelector('.g2-lb-more')?.remove();
}

/**
 * Hide the lowest top-list rows of `box` until `scroller` (the card) no longer overflows. The caller's row stays
 * (behind a gap row when rows above it are hidden), at least `minRows` top rows stay, and a "Show all" / "Show
 * fewer" toggle appears when anything was hidden. Returns how many rows it hid.
 */
export function fitLeaderboard(scroller: HTMLElement, box: HTMLElement, minRows = FIT_MIN_ROWS): number {
  reset(box);
  const body = box.querySelector('tbody');
  if (!body || box.dataset.expanded === '1') {
    if (body && box.dataset.expanded === '1') addToggle(scroller, box, minRows, true);
    return 0;
  }
  const overflows = (): boolean => scroller.scrollHeight > scroller.clientHeight + 1;
  if (!overflows()) return 0;
  const rows = [...body.querySelectorAll<HTMLTableRowElement>('tr')];
  // Top-list rows that may go, lowest first; the caller's row and the "…" before an appended own row stay.
  const appendedMe = rows.some((r) => r.classList.contains('g2-lb-gap'));
  const candidates = rows.filter((r, i) => !r.classList.contains('g2-lb-me') && !r.classList.contains('g2-lb-gap') && i >= minRows).reverse();
  if (candidates.length === 0) return 0;
  addToggle(scroller, box, minRows, false);
  let hidden = 0;
  for (const r of candidates) {
    if (!overflows()) break;
    r.classList.add('g2-lb-hidden');
    hidden++;
  }
  if (hidden === 0) {
    box.querySelector('.g2-lb-more')?.remove();
    return 0;
  }
  // The caller's row inside the top list, below hidden rows: put a gap row in front of it.
  const me = rows.find((r) => r.classList.contains('g2-lb-me'));
  if (me && !appendedMe) {
    const above = me.previousElementSibling;
    if (above && above.classList.contains('g2-lb-hidden')) {
      me.before(gapRow('g2-lb-fit-gap'));
      // The gap row costs a line: hide one more row if that made it overflow again.
      const more = candidates.find((r) => !r.classList.contains('g2-lb-hidden'));
      if (overflows() && more) {
        more.classList.add('g2-lb-hidden');
        hidden++;
      }
    }
  }
  return hidden;
}

function addToggle(scroller: HTMLElement, box: HTMLElement, minRows: number, expanded: boolean): void {
  const btn = el('button', 'g2-btn g2-btn-secondary g2-btn-small g2-lb-more', expanded ? t('lb.showFewer') : t('lb.showAll'));
  btn.type = 'button';
  btn.addEventListener('click', () => {
    btn.blur();
    if (expanded) delete box.dataset.expanded;
    else box.dataset.expanded = '1';
    fitLeaderboard(scroller, box, minRows);
  });
  const head = box.querySelector('.g2-lb-head');
  // "Show all" goes before an aside (the nickname stays at the right end).
  if (head) head.insertBefore(btn, head.querySelector(':scope > .g2-lb-aside'));
  else box.prepend(btn);
}

/**
 * Fit now, again once the web fonts are in and on every window resize. Returns the cleanup (call it when the
 * page goes away).
 */
export function autoFitLeaderboard(scroller: HTMLElement, box: HTMLElement, minRows = FIT_MIN_ROWS): () => void {
  let frame = 0;
  const run = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (box.isConnected) fitLeaderboard(scroller, box, minRows);
    });
  };
  if (box.isConnected) fitLeaderboard(scroller, box, minRows);
  void document.fonts?.ready.then(run);
  window.addEventListener('resize', run);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', run);
  };
}
