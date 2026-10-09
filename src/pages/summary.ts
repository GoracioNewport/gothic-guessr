/**
 * Summary page after the last round (SPEC §10.7): total with the score bar, per-round results, the share block
 * (daily: the Wordle-style share text; other games: the challenge link), the challenge leaderboard with the
 * player's row highlighted, the player's nickname with Change (a saved name reloads the leaderboard), "Main menu"
 * and the replay button of {@link replayAction}.
 */
import { ROUND_COUNTS } from '../../shared/api';
import type { GameKind, GameSummaryView, PublicSettings } from '../../shared/api';
import { formatDistance, formatDuration, t, worldName } from '../i18n';
import { challengeLink, squares } from '../play/share';
import { button, copyField, el, formatScore, hasModifier, isOwnSpaceTarget, isTypingTarget, keyButton, ROUND_MAX_SCORE, scoreBar } from '../ui/dom';
import { autoFitLeaderboard, leaderboard } from '../ui/leaderboard';
import { legalLink } from '../ui/legal';
import { NicknameEditor } from '../ui/nickname';
import { resultKind } from '../ui/screens';
import type { AppContext, Page } from './context';

/**
 * The replay button of a summary:
 * - solo → "Play again": a new solo game with the same settings ({@link replaySettings});
 * - challenge → "New game": also a new solo game with these settings (the challenge itself has one attempt per
 *   player, so "again" would promise a replay that cannot happen);
 * - daily → none: one attempt a day, the summary offers only Main menu (and the share text).
 * Room games end on the room page, not here.
 */
export function replayAction(kind: GameKind): 'playAgain' | 'newGame' | null {
  if (kind === 'solo') return 'playAgain';
  if (kind === 'challenge') return 'newGame';
  return null;
}

/** Settings of the replay: the game's own, with a round count solo offers (a duel's challenge has 30 → 5). */
export function replaySettings(settings: PublicSettings): PublicSettings {
  return { ...settings, rounds: ROUND_COUNTS.includes(settings.rounds) ? settings.rounds : 5 };
}

export function renderSummary(ctx: AppContext, page: Page, initial: GameSummaryView): void {
  let summary = initial;
  const { game } = summary;
  const replay = replayAction(game.kind);
  const playAgain = (): void => {
    void ctx.startSolo(replaySettings(game.settings));
  };
  const goMenu = (): void => ctx.router.navigate('/');
  // A new name shows on the leaderboard: fetch it again (the row is the server's, not patched locally).
  const nick = new NicknameEditor({
    api: ctx.api,
    player: () => ctx.player(),
    variant: 'inline',
    onSaved: () => {
      void ctx.api
        .leaderboard(game.challengeCode)
        .then((board) => {
          summary = { ...summary, leaderboard: board };
          render();
        })
        .catch(() => undefined);
    },
  });

  let unfit: (() => void) | null = null;
  const render = (): void => {
    if (!page.alive) return;
    const screen = el('div', 'g2-screen g2-centered g2-summary');
    const card = el('div', 'g2-card g2-card-wide');
    screen.appendChild(card);

    const head = el('div', 'g2-summary-head');
    head.appendChild(el('h2', 'g2-heading', t('summary.heading')));
    if (game.kind === 'daily' && game.date) head.appendChild(el('span', 'g2-result-world', t('daily.heading')));
    card.appendChild(head);

    const total = el('div', 'g2-total');
    total.appendChild(el('div', 'g2-stat-value g2-accent', formatScore(game.total)));
    total.appendChild(el('div', 'g2-stat-label', t('summary.totalLabel')));
    const sq = el('div', 'g2-squares', squares(game.results));
    sq.setAttribute('aria-hidden', 'true');
    total.appendChild(sq);
    card.appendChild(total);
    card.appendChild(scoreBar(Math.max(1, game.totalRounds) * ROUND_MAX_SCORE, game.total).root);

    const table = el('table', 'g2-table g2-rounds-table');
    const headRow = table.createTHead().insertRow();
    for (const h of [t('summary.col.round'), t('summary.col.world'), t('summary.col.distance'), t('summary.col.score'), t('summary.col.time')]) {
      headRow.appendChild(el('th', undefined, h));
    }
    const body = table.createTBody();
    for (const r of game.results) {
      const tr = body.insertRow();
      tr.insertCell().textContent = String(r.n);
      const w = tr.insertCell();
      w.className = 'g2-table-world';
      w.textContent = r.answer ? worldName(r.answer.world) : '—';
      const d = tr.insertCell();
      const kind = resultKind(r);
      if (kind === 'distance') d.textContent = formatDistance(r.distanceM ?? 0);
      else {
        d.className = 'g2-table-wrong';
        d.textContent = kind === 'wrongWorld' ? t('summary.wrongWorld') : kind === 'timedOut' ? t('result.timedOut') : t('result.noGuess');
        if (kind === 'wrongWorld' && r.guess) d.title = t('summary.guessedOn', { world: worldName(r.guess.world) });
      }
      tr.insertCell().textContent = formatScore(r.score);
      tr.insertCell().textContent = formatDuration(r.timeMs);
    }
    const foot = table.createTFoot().insertRow();
    const label = foot.insertCell();
    label.colSpan = 3;
    label.textContent = t('summary.total');
    foot.insertCell().textContent = formatScore(game.total);
    foot.insertCell().textContent = formatDuration(game.results.reduce((s, r) => s + r.timeMs, 0));
    card.appendChild(table);

    // Share: daily → the share text; otherwise → the challenge link (everyone who opens it plays these rounds).
    const share = el('section', 'g2-share');
    if (summary.shareText) {
      share.appendChild(el('h3', 'g2-legend', t('summary.shareResult')));
      share.appendChild(copyField(summary.shareText, { label: t('share.copyText'), multiline: true, className: 'g2-share-daily' }));
    } else {
      share.appendChild(el('h3', 'g2-legend', t('summary.challengeLink')));
      share.appendChild(el('p', 'g2-muted g2-share-hint', t('summary.challengeHint')));
      share.appendChild(copyField(challengeLink(game.challengeCode), { label: t('share.copyLink'), className: 'g2-share-link' }));
    }
    card.appendChild(share);

    // The nickname with Change on the leaderboard's heading line: the name shows in that table.
    const lb = leaderboard(summary.leaderboard, { banned: ctx.player()?.banned === true, aside: nick.element() });
    card.appendChild(lb);

    // Enter runs the primary button: the replay, or Main menu when there is none (daily).
    const actions = el('div', 'g2-actions g2-actions-end');
    if (replay) {
      actions.appendChild(button(t('summary.backToMenu'), 'g2-btn g2-btn-secondary g2-summary-menu', goMenu));
      const label = replay === 'playAgain' ? t('summary.playAgain') : t('summary.newGame');
      const again = keyButton('g2-btn g2-btn-primary g2-summary-again', label, 'Enter');
      if (replay === 'newGame') again.title = t('summary.newGameHint');
      again.addEventListener('click', () => {
        again.blur();
        playAgain();
      });
      actions.appendChild(again);
    } else {
      const menu = keyButton('g2-btn g2-btn-primary g2-summary-menu', t('summary.backToMenu'), 'Enter');
      menu.addEventListener('click', () => {
        menu.blur();
        goMenu();
      });
      actions.appendChild(menu);
    }
    card.appendChild(actions);
    screen.appendChild(legalLink());

    unfit?.();
    unfit = null;
    ctx.screens.page(screen, {
      rerender: render,
      cleanup: () => {
        unfit?.();
        unfit = null;
      },
      keys: (e) => {
        if (isTypingTarget(e) || hasModifier(e) || e.repeat) return;
        if (e.key === 'Enter' && !isOwnSpaceTarget(e)) {
          e.preventDefault();
          if (replay) playAgain();
          else goMenu();
        }
      },
    });
    // As many leaderboard rows as fit at this height (the player's own row always), "Show all" for the rest.
    unfit = autoFitLeaderboard(card, lb);
  };
  render();
}
