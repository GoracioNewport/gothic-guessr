/**
 * Challenge page (SPEC §10.4, §10.7, route `/c/<code>`): kind, creator, settings, how many have taken it, your
 * result or Play / Continue, and the leaderboard. A second attempt is refused by the server (`already_played`);
 * the page then shows your result. Once you have played it, your nickname with Change sits on the leaderboard's
 * heading line (a saved name reloads the leaderboard).
 */
import type { ChallengeView, GameSummaryView, LeaderboardView } from '../../shared/api';
import { errorMessage, formatDate, t, tp } from '../i18n';
import { isApiError } from '../net/api';
import { squares } from '../play/share';
import { button, el, formatScore, settingsLine, toast } from '../ui/dom';
import { autoFitLeaderboard, leaderboard } from '../ui/leaderboard';
import { createLangSelect } from '../ui/langselect';
import { legalLink } from '../ui/legal';
import { NicknameEditor } from '../ui/nickname';
import type { AppContext, Page } from './context';
import { pageScope } from './context';

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; view: ChallengeView; board: LeaderboardView; summary: GameSummaryView | null };

export function challengePage(ctx: AppContext, code: string): Page {
  const page = pageScope();
  let state: State = { kind: 'loading' };
  let busy = false;
  let notice = '';
  let unfit: (() => void) | null = null;
  const nick = new NicknameEditor({
    api: ctx.api,
    player: () => ctx.player(),
    variant: 'inline',
    onSaved: () => {
      if (state.kind !== 'ok') return;
      const shown = state.view.code;
      void ctx.api
        .leaderboard(shown, 50)
        .then((board) => {
          if (state.kind === 'ok' && state.view.code === shown) state = { ...state, board };
          render();
        })
        .catch(() => undefined);
    },
  });

  const load = async (): Promise<void> => {
    try {
      const view = await ctx.api.challenge(code);
      const [board, summary] = await Promise.all([
        ctx.api.leaderboard(view.code, 50),
        view.myGame?.finished ? ctx.api.summary(view.myGame.id).catch(() => null) : Promise.resolve(null),
      ]);
      state = { kind: 'ok', view, board, summary };
    } catch (err) {
      state = isApiError(err, 'not_found') ? { kind: 'missing' } : { kind: 'error', message: messageOf(err) };
    }
    render();
  };

  const play = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    try {
      const game = await ctx.api.createGame({ kind: 'challenge', code });
      if (page.alive) ctx.openGame(game, `/c/${code}`);
    } catch (err) {
      busy = false;
      if (isApiError(err, 'already_played')) {
        notice = t('challenge.alreadyPlayed');
        await load();
      } else {
        toast(messageOf(err));
        render();
      }
    }
  };

  const render = (): void => {
    if (!page.alive) return;
    const screen = el('div', 'g2-screen g2-centered g2-challenge');
    const lang = createLangSelect({ corner: true });
    screen.appendChild(lang.root);
    const card = el('div', 'g2-card g2-card-wide');
    screen.appendChild(card);
    let lb: HTMLElement | null = null;

    if (state.kind === 'loading') {
      card.appendChild(el('h1', 'g2-heading', t('challenge.heading')));
      card.appendChild(el('p', 'g2-boot-text', t('menu.loading')));
    } else if (state.kind === 'missing') {
      card.appendChild(el('h1', 'g2-heading', t('challenge.heading')));
      card.appendChild(el('p', 'g2-field-error', t('challenge.notFound')));
    } else if (state.kind === 'error') {
      card.appendChild(el('h1', 'g2-heading', t('challenge.heading')));
      const p = el('p', 'g2-field-error', state.message);
      p.setAttribute('role', 'alert');
      card.appendChild(p);
      card.appendChild(button(t('app.retry'), 'g2-btn g2-btn-secondary', () => {
        state = { kind: 'loading' };
        render();
        void load();
      }));
    } else {
      const { view, board, summary } = state;
      const head = el('div', 'g2-summary-head');
      head.appendChild(el('h1', 'g2-heading', t(`challenge.kind.${view.kind}`)));
      head.appendChild(el('span', 'g2-result-world', view.date ? formatDate(view.date) : formatDate(view.createdAt)));
      card.appendChild(head);
      if (view.createdBy) {
        const by = el('p', 'g2-challenge-by');
        by.textContent = t('challenge.by', { name: view.createdBy });
        by.dir = 'auto';
        card.appendChild(by);
      }
      card.appendChild(settingsLine(view.settings, ctx.slugs));

      const status = el('section', 'g2-daily-status');
      if (notice) {
        const n = el('p', 'g2-field-error', notice);
        n.setAttribute('role', 'alert');
        status.appendChild(n);
      }
      const mine = view.myGame;
      if (mine?.finished) {
        status.appendChild(el('h3', 'g2-legend', t('daily.yourResult')));
        const total = el('div', 'g2-total');
        total.appendChild(el('div', 'g2-stat-value g2-accent', formatScore(mine.total)));
        total.appendChild(el('div', 'g2-stat-label', t('summary.totalLabel')));
        if (summary) total.appendChild(el('div', 'g2-squares', squares(summary.game.results)));
        status.appendChild(total);
        if (!notice) status.appendChild(el('p', 'g2-muted', t('challenge.alreadyPlayed')));
      } else if (view.unavailable && !mine) {
        // A room game still running, or one that ended before its first round: nothing to play here (yet).
        const note = el('p', 'g2-muted g2-challenge-unavailable', t(view.unavailable === 'running' ? 'challenge.running' : 'challenge.abandoned'));
        note.setAttribute('role', 'status');
        status.appendChild(note);
      } else {
        const playBtn = button(mine ? t('challenge.resume') : t('challenge.play'), 'g2-btn g2-btn-primary g2-btn-big g2-challenge-play', () => void play());
        playBtn.disabled = busy;
        status.appendChild(playBtn);
      }
      card.appendChild(status);
      lb = leaderboard(board, {
        banned: ctx.player()?.banned === true,
        note: tp('challenge.players', view.players),
        aside: view.myGame?.finished ? nick.element() : undefined,
      });
      card.appendChild(lb);
    }

    const actions = el('div', 'g2-actions');
    actions.appendChild(button(t('summary.backToMenu'), 'g2-btn g2-btn-secondary', () => ctx.router.navigate('/')));
    card.appendChild(actions);
    screen.appendChild(legalLink());
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
    if (lb) unfit = autoFitLeaderboard(card, lb);
  };

  render();
  void load();
  return page;
}

function messageOf(err: unknown): string {
  return isApiError(err) ? errorMessage(err.code) : t('error.unknown');
}
