/**
 * Daily challenge page (SPEC §10.5, routes `/daily` and `/daily/YYYY-MM-DD`): the day's settings, your result with
 * the share text once played, Play (or Continue) for today, the leaderboard (top 50 + your row), a date picker for
 * past days (view only) and the time until the next challenge. Once you have played the day, your nickname with
 * Change sits on the leaderboard's heading line (a saved name reloads the leaderboard).
 *
 * The countdown and the past-days picker share one row that never wraps and never moves while the clock ticks:
 * the digits sit in fixed-width cells ({@link countdownEl}), the row is a two-column grid, and only the countdown's
 * label may give way (ellipsis) on a very narrow card.
 */
import type { ChallengeView, GameSummaryView, LeaderboardView } from '../../shared/api';
import { errorMessage, formatDate, t, tp } from '../i18n';
import { isApiError } from '../net/api';
import { squares } from '../play/share';
import { button, copyField, el, formatScore, settingsLine, toast } from '../ui/dom';
import { autoFitLeaderboard, leaderboard } from '../ui/leaderboard';
import { createLangSelect } from '../ui/langselect';
import { legalLink } from '../ui/legal';
import { NicknameEditor } from '../ui/nickname';
import { rulesPanel, withRules } from '../ui/rulespanel';
import type { AppContext, Page } from './context';
import { pageScope } from './context';

/** `YYYY-MM-DD` (UTC) of an epoch-ms instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A message split around its placeholder: `splitAround('Next challenge in \u0001', '\u0001')` → `['Next challenge
 * in', '']`. Both parts trimmed; no marker → the whole message before.
 */
export function splitAround(message: string, marker: string): [string, string] {
  const i = message.indexOf(marker);
  if (i < 0) return [message.trim(), ''];
  return [message.slice(0, i).trim(), message.slice(i + marker.length).trim()];
}

/**
 * The countdown "18:12:03" with every digit in a fixed-width cell (`.g2-digit`), so its width never changes while
 * it ticks: the game font's digits are proportional ("1" is half as wide as "4") and have no tabular figures.
 */
export function countdownEl(text: string): HTMLElement {
  const box = el('span', 'g2-daily-countdown');
  box.dataset.time = text;
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') box.appendChild(el('span', 'g2-digit', ch));
    else box.appendChild(el('span', 'g2-digit-sep', ch));
  }
  return box;
}

/** The time until the next daily as `HH:MM:SS`, always eight characters (the row keeps its width all day). */
export function countdownText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

/** Milliseconds until the next UTC midnight (the next daily). */
export function msUntilNextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

type State =
  | { kind: 'loading' }
  | { kind: 'missing'; date: string }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; view: ChallengeView; board: LeaderboardView; summary: GameSummaryView | null };

export function dailyPage(ctx: AppContext, date: string | null): Page {
  let timer: ReturnType<typeof setInterval> | null = null;
  const page = pageScope(() => {
    if (timer !== null) clearInterval(timer);
  });
  const today = utcDay(ctx.api.serverNow());
  // A link to today's date or the future is the today page.
  const day = date && date < today ? date : null;
  let state: State = { kind: 'loading' };
  let busy = false;
  let unfit: (() => void) | null = null;
  // Shown once the day is played; a new name reloads the leaderboard.
  const nick = new NicknameEditor({
    api: ctx.api,
    player: () => ctx.player(),
    variant: 'inline',
    onSaved: () => {
      if (state.kind !== 'ok') return;
      const code = state.view.code;
      void ctx.api
        .leaderboard(code, 50)
        .then((board) => {
          if (state.kind === 'ok' && state.view.code === code) state = { ...state, board };
          render();
        })
        .catch(() => undefined);
    },
  });

  const load = async (): Promise<void> => {
    try {
      const view = await ctx.api.daily(day ?? undefined);
      const [board, summary] = await Promise.all([
        ctx.api.leaderboard(view.code, 50),
        view.myGame?.finished ? ctx.api.summary(view.myGame.id).catch(() => null) : Promise.resolve(null),
      ]);
      state = { kind: 'ok', view, board, summary };
    } catch (err) {
      state = isApiError(err, 'not_found') && day ? { kind: 'missing', date: day } : { kind: 'error', message: messageOf(err) };
    }
    render();
  };

  const play = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    try {
      const game = await ctx.api.createGame({ kind: 'daily' });
      if (page.alive) ctx.openGame(game, '/daily');
    } catch (err) {
      toast(messageOf(err));
      busy = false;
      if (isApiError(err, 'already_played')) await load();
      else render();
    }
  };

  const render = (): void => {
    if (!page.alive) return;
    const screen = el('div', 'g2-screen g2-centered g2-daily');
    const lang = createLangSelect({ corner: true });
    screen.appendChild(lang.root);
    const card = el('div', 'g2-card g2-card-wide');
    // The day's rules to the right of the card (below it on narrow screens), once its settings are known.
    if (state.kind === 'ok') screen.appendChild(withRules(card, rulesPanel(state.view.settings, { kind: 'daily' }).root));
    else screen.appendChild(card);
    screen.appendChild(legalLink());
    let board: HTMLElement | null = null;

    const head = el('div', 'g2-summary-head');
    head.appendChild(el('h1', 'g2-heading', t('daily.heading')));
    const shownDay = day ?? (state.kind === 'ok' ? (state.view.date ?? today) : today);
    head.appendChild(el('span', 'g2-result-world', day ? formatDate(shownDay) : `${t('daily.today')} · ${formatDate(shownDay)}`));
    card.appendChild(head);

    if (state.kind === 'loading') {
      card.appendChild(el('p', 'g2-boot-text', t('menu.loading')));
    } else if (state.kind === 'missing') {
      card.appendChild(el('p', 'g2-muted', t('daily.noChallenge')));
    } else if (state.kind === 'error') {
      const p = el('p', 'g2-field-error', state.message);
      p.setAttribute('role', 'alert');
      card.appendChild(p);
      card.appendChild(button(t('app.retry'), 'g2-btn g2-btn-secondary', () => {
        state = { kind: 'loading' };
        render();
        void load();
      }));
    } else {
      const { view, board: lbView, summary } = state;
      const mine = view.myGame;
      const status = el('section', 'g2-daily-status');
      if (mine?.finished) {
        // "Your result" and "already played" share a line (the page must fit 1280×720 in every language).
        const resultHead = el('div', 'g2-daily-status-head');
        resultHead.appendChild(el('h3', 'g2-legend', t('daily.yourResult')));
        if (!day) resultHead.appendChild(el('span', 'g2-muted', t('daily.played')));
        status.appendChild(resultHead);
        const total = el('div', 'g2-total');
        total.appendChild(el('div', 'g2-stat-value g2-accent', formatScore(mine.total)));
        total.appendChild(el('div', 'g2-stat-label', t('summary.totalLabel')));
        if (summary) total.appendChild(el('div', 'g2-squares', squares(summary.game.results)));
        status.appendChild(total);
        if (summary?.shareText) status.appendChild(copyField(summary.shareText, { label: t('share.copyText'), multiline: true, className: 'g2-share-daily' }));
      } else if (day) {
        status.appendChild(el('p', 'g2-muted', t('daily.pastDay')));
      } else {
        status.appendChild(el('p', 'g2-muted', mine ? t('daily.inProgress') : t('daily.notPlayed')));
        const playBtn = button(mine ? t('challenge.resume') : t('daily.play'), 'g2-btn g2-btn-primary g2-btn-big g2-daily-play', () => void play());
        playBtn.disabled = busy;
        status.appendChild(playBtn);
      }
      card.appendChild(status);
      card.appendChild(settingsLine(view.settings, ctx.slugs));
      board = leaderboard(lbView, {
        banned: ctx.player()?.banned === true,
        note: tp('daily.players', view.players),
        aside: mine?.finished ? nick.element() : undefined,
      });
      card.appendChild(board);
    }

    // The countdown and the past-days picker share one row (the page must fit 1280×720 in every language). Only
    // the digits change on a tick, each in a cell of its own width, so nothing on the row moves.
    const foot = el('div', 'g2-daily-foot');
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (!day) {
      const next = el('p', 'g2-muted g2-daily-next');
      const MARK = '\u0001';
      const [before, after] = splitAround(t('daily.nextIn', { time: MARK }), MARK);
      const label = el('span', 'g2-daily-next-label', before);
      next.appendChild(label);
      let clock = countdownEl(countdownText(msUntilNextUtcDay(ctx.api.serverNow())));
      next.appendChild(clock);
      if (after) next.appendChild(el('span', 'g2-daily-next-after', after));
      const tick = (): void => {
        const text = countdownText(msUntilNextUtcDay(ctx.api.serverNow()));
        if (clock.dataset.time === text) return;
        const fresh = countdownEl(text);
        clock.replaceWith(fresh);
        clock = fresh;
      };
      tick();
      timer = setInterval(tick, 1000);
      foot.appendChild(next);
    }

    // Past days picker (view only).
    const picker = el('form', 'g2-daily-picker');
    const label = el('label', 'g2-join-label', t('daily.pickDate'));
    const input = el('input', 'g2-input g2-daily-date');
    input.type = 'date';
    input.id = 'g2-daily-date';
    input.max = today;
    input.value = day ?? today;
    label.htmlFor = input.id;
    const show = el('button', 'g2-btn g2-btn-secondary g2-btn-small', t('daily.show'));
    show.type = 'submit';
    picker.append(label, input, show);
    picker.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      ctx.router.navigate({ name: 'daily', date: v >= today ? null : v });
    });
    foot.appendChild(picker);
    card.appendChild(foot);

    // Sticky like the summary's: a long leaderboard scrolls the card, Main menu stays in view.
    const actions = el('div', 'g2-actions g2-daily-actions');
    actions.appendChild(button(t('summary.backToMenu'), 'g2-btn g2-btn-secondary', () => ctx.router.navigate('/')));
    if (day) actions.appendChild(button(t('daily.backToToday'), 'g2-btn g2-btn-secondary', () => ctx.router.navigate('/daily')));
    card.appendChild(actions);

    // The leaderboard shows as many rows as fit at this height (the player's own row always), "Show all" for the
    // rest, so the next-daily line, the picker and Main menu stay in view without an inner scrollbar.
    unfit?.();
    unfit = null;
    ctx.screens.page(screen, {
      rerender: render,
      cleanup: () => {
        lang.destroy();
        unfit?.();
        unfit = null;
      },
    });
    if (board) unfit = autoFitLeaderboard(card, board);
  };

  render();
  void load();
  return page;
}

function messageOf(err: unknown): string {
  return isApiError(err) ? errorMessage(err.code) : t('error.unknown');
}
