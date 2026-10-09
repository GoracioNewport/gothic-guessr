/**
 * The screen shell and the in-game screens (SPEC.md §1, §9, §10.7), plain DOM.
 *
 * {@link Screens} owns the root element: every `show*` / `page` call tears down the previous screen (DOM, keyboard
 * listener, cleanups) and mounts the next one. Pages (menu, solo setup, daily, challenge, summary; src/pages/) build
 * their own DOM and mount it with {@link Screens.page}, passing a `rerender` callback so a language switch rebuilds
 * them in place. The round and result screens are built here because their layout is shared by every game kind,
 * rooms included.
 *
 * One exception to "replace everything": `showResult` called while a round screen is active keeps that round's
 * panorama element in the DOM and draws the overlay above it, so the frozen panorama stays visible behind the
 * result card.
 */
import type { RoundResultView } from '../../shared/api';
import { formatDistance, formatDuration, onLanguageChange, t, worldName } from '../i18n';
import { formatCountdown, startCountdown } from '../play/countdown';
import type { CountdownHandle } from '../play/countdown';
import { el, formatScore, hasModifier, isConfirmKey, isOwnSpaceTarget, isTypingTarget, keyButton, ROUND_MAX_SCORE, scoreBar } from './dom';
import { reportFlagButton } from './report';

/** Delay before the map widget collapses after the pointer leaves it. */
const COLLAPSE_DELAY_MS = 250;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** Apply the toggle rules of SPEC §9.2: No look needs No move. `change` is the toggle the player flipped. */
export function applyToggleRules(
  current: { noMove: boolean; noLook: boolean },
  change: { noMove?: boolean; noLook?: boolean },
): { noMove: boolean; noLook: boolean } {
  let { noMove, noLook } = current;
  if (change.noLook !== undefined) {
    noLook = change.noLook;
    if (noLook) noMove = true;
  }
  if (change.noMove !== undefined) {
    noMove = change.noMove;
    if (!noMove) noLook = false;
  }
  return { noMove, noLook };
}

/** How a round ended, for the result card: a distance, a wrong world, a timeout or no guess at all. */
export type ResultKind = 'distance' | 'wrongWorld' | 'timedOut' | 'noGuess';

export function resultKind(r: Pick<RoundResultView, 'guess' | 'answer' | 'distanceM' | 'timedOut'>): ResultKind {
  if (!r.guess) return r.timedOut ? 'timedOut' : 'noGuess';
  // A room result still `pending` has no answer and no distance; it is never shown as a result card.
  if (!r.answer || r.guess.world !== r.answer.world || r.distanceM === null) return 'wrongWorld';
  return 'distance';
}

// ---------------------------------------------------------------------------------------------
// Screen options
// ---------------------------------------------------------------------------------------------

type KeyHandler = (e: KeyboardEvent) => void;

/** Options of {@link Screens.page}. */
export interface PageOptions {
  /** Keyboard handler while the page is shown. */
  keys?: KeyHandler;
  /** Rebuild the page in the new language (called on a language switch). */
  rerender?: () => void;
  /** Called when the page is replaced. */
  cleanup?: () => void;
}

/** Inputs for {@link Screens.showRound}. */
export interface RoundScreenOptions {
  /** 1-based round number. */
  round: number;
  /** Total rounds of the game. */
  total: number;
  /** Score accumulated before this round. */
  score: number;
  /** "No move": no Return button, `R` does nothing; shown as a badge. */
  noMove?: boolean;
  /** "No look": shown as a badge (the panorama freezes itself). */
  noLook?: boolean;
  /** Round deadline, server epoch ms; null/undefined = untimed (no countdown). */
  deadline?: number | null;
  /** Server clock estimate, for the countdown (default Date.now). */
  now?: () => number;
  /** Called once when the countdown has run out (the caller submits the placed marker, or `null`). */
  onTimeout?: () => void;
  /** Called once just before the deadline (the caller submits a placed marker while the server still takes it). */
  onLastCall?: () => void;
  /** Player pressed "Guess" (button or Space/Enter) while it was enabled. */
  onGuess: () => void;
  /** Player pressed "Return to start" (button or R). */
  onReturnToStart: () => void;
  /** Shows the HUD flag button: the player reports a problem with the place on screen (src/ui/report.ts). */
  onReport?: () => void;
  /** Called once with the empty full-screen element for the panorama. */
  mountPanorama: (el: HTMLElement) => void;
  /** Called once with the empty element of the collapsible map widget. */
  mountMap: (el: HTMLElement) => void;
  /** Fired when the map widget expands or collapses (forward to `GuessMap.setExpanded`). */
  onMapExpandChanged?: (expanded: boolean) => void;
}

/** Controls returned by {@link Screens.showRound} for the lifetime of that round screen. */
export interface RoundScreenHandle {
  /** Enable the Guess button (and Space/Enter). Starts disabled. */
  setGuessEnabled(enabled: boolean): void;
  /** True while a guess is being sent: Guess shows as busy, shortcuts are ignored. */
  setBusy(busy: boolean): void;
  setScore(score: number): void;
  /** Move or set the deadline (duel countdown), null removes the countdown. */
  setDeadline(deadline: number | null): void;
  /** An empty HUD area under the round info for room extras ("X guessed" ticks, duel HP bars). */
  readonly slot: HTMLElement;
  /** Replace the "Round n/total" line (a duel has no fixed round count). */
  setRoundLabel(text: string): void;
  /** The round screen element (rooms mark it while waiting for the other players). */
  readonly screen: HTMLElement;
}

/** Inputs for {@link Screens.showResult}. */
export interface ResultScreenOptions {
  result: RoundResultView;
  /** Total rounds of the game ("See summary" on the last). */
  total: number;
  onNext: () => void;
  /** Called once with the element of the result map; the caller mounts the map and calls `showResult`. */
  mountMap: (el: HTMLElement) => void;
  /** Label of the Next button (default: next round / see summary). */
  nextLabel?: string;
  /** Hide the Next button (rooms: the host or a timer advances). */
  hideNext?: boolean;
  /** Extra content under the stats (rooms: the round table). */
  extra?: HTMLElement;
}

/** Parts of the active round screen that `showResult` reuses or removes. */
interface ActiveRound {
  screen: HTMLElement;
  hud: HTMLElement;
}

export class Screens {
  private readonly root: HTMLElement;
  private keyHandler: KeyHandler | null = null;
  private cleanups: Array<() => void> = [];
  private activeRound: ActiveRound | null = null;
  /** Re-renders the current screen in the new language; null where that is not supported (round, result). */
  private rerender: (() => void) | null = null;
  private readonly unsubscribeLanguage: () => void;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add('g2-root');
    this.unsubscribeLanguage = onLanguageChange(() => this.refreshLanguage());
  }

  /** The root element (for toasts and overlays). */
  get element(): HTMLElement {
    return this.root;
  }

  /** Re-render the current page after a language switch; a focused language selector keeps its focus. */
  refreshLanguage(): void {
    const rerender = this.rerender;
    if (!rerender) return;
    const focusInSelector = document.activeElement instanceof Element && document.activeElement.closest('.g2-lang') !== null;
    rerender();
    if (focusInSelector) this.root.querySelector<HTMLInputElement>('.g2-lang input:checked')?.focus();
  }

  // --- lifecycle ---------------------------------------------------------------------------

  /** Drop listeners and timers of the current screen but keep its DOM. */
  private releaseListeners(): void {
    const fns = this.cleanups;
    this.cleanups = [];
    for (const fn of fns) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
  }

  /** Replace the current screen with `screen`. */
  private mount(screen: HTMLElement): void {
    this.releaseListeners();
    this.activeRound = null;
    this.rerender = null;
    // A toast on screen (e.g. "report sent") outlives a re-render of the page; it removes itself on its timer.
    const toast = this.root.querySelector<HTMLElement>(':scope > .g2-toast');
    this.root.replaceChildren(screen);
    if (toast) this.root.appendChild(toast);
  }

  private setKeys(handler: KeyHandler): void {
    this.keyHandler = handler;
    document.addEventListener('keydown', handler);
  }

  /** Mount a page built elsewhere (src/pages/). */
  page(screen: HTMLElement, options: PageOptions = {}): void {
    this.mount(screen);
    if (options.cleanup) this.cleanups.push(options.cleanup);
    if (options.rerender) this.rerender = options.rerender;
    if (options.keys) this.setKeys(options.keys);
  }

  /** Register a cleanup for the current screen (timers, subscriptions). */
  addCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  /**
   * A centred message panel: loading text, or an error with actions (Retry, Main menu). `rerender` rebuilds it
   * in a new language.
   */
  showMessage(opts: { text: () => string; error?: boolean; actions?: { label: () => string; onClick: () => void; primary?: boolean }[] }): void {
    const render = (): void => {
      const screen = el('div', 'g2-screen g2-centered g2-boot');
      const card = el('div', 'g2-card g2-boot-card');
      const p = el('p', opts.error ? 'g2-boot-text g2-boot-error' : 'g2-boot-text', opts.text());
      p.setAttribute(opts.error ? 'role' : 'aria-live', opts.error ? 'alert' : 'polite');
      card.appendChild(p);
      if (opts.actions?.length) {
        const row = el('div', 'g2-actions');
        for (const a of opts.actions) {
          const btn = el('button', `g2-btn ${a.primary ? 'g2-btn-primary' : 'g2-btn-secondary'}`, a.label());
          btn.type = 'button';
          btn.addEventListener('click', () => a.onClick());
          row.appendChild(btn);
        }
        card.appendChild(row);
      }
      screen.appendChild(card);
      this.page(screen, { rerender: render });
    };
    render();
  }

  // --- round -------------------------------------------------------------------------------

  showRound(opts: RoundScreenOptions): RoundScreenHandle {
    const noMove = opts.noMove === true || opts.noLook === true;
    const noLook = opts.noLook === true;
    const now = opts.now ?? Date.now;

    const screen = el('div', 'g2-screen g2-round');
    const pano = el('div', 'g2-pano');
    screen.appendChild(pano);

    // The HUD layer ignores pointer events; only its children re-enable them, so the panorama stays draggable.
    const hud = el('div', 'g2-hud');
    screen.appendChild(hud);

    const left = el('div', 'g2-hud-left');
    const info = el('div', 'g2-panel g2-hud-info');
    const roundLabel = el('div', 'g2-hud-round', t('round.counter', { round: opts.round, total: opts.total }));
    info.appendChild(roundLabel);
    const scoreValue = el('span', 'g2-hud-score-value', formatScore(opts.score));
    const scoreLine = el('div', 'g2-hud-score', `${t('round.score')} `);
    scoreLine.appendChild(scoreValue);
    info.appendChild(scoreLine);
    const hudBar = scoreBar(opts.total * ROUND_MAX_SCORE, opts.score);
    info.appendChild(hudBar.root);
    left.appendChild(info);
    const slot = el('div', 'g2-hud-slot');
    left.appendChild(slot);
    hud.appendChild(left);

    // Countdown (top centre) when the round has a deadline.
    const clock = el('div', 'g2-panel g2-countdown');
    clock.setAttribute('role', 'timer');
    clock.hidden = true;
    const clockValue = el('span', 'g2-countdown-value');
    clock.append(el('span', 'g2-countdown-label', t('round.timeLeft')), clockValue);
    hud.appendChild(clock);

    // Top-right: the toggle badges and (unless No move) the Return button.
    const topRight = el('div', 'g2-hud-topright');
    if (noMove || noLook) {
      const badges = el('div', 'g2-badges');
      if (noMove) badges.appendChild(el('span', 'g2-badge', t('start.noMove')));
      if (noLook) badges.appendChild(el('span', 'g2-badge', t('start.noLook')));
      topRight.appendChild(badges);
    }
    if (opts.onReport) topRight.appendChild(reportFlagButton(opts.onReport));
    if (!noMove) {
      const returnBtn = keyButton('g2-btn g2-btn-secondary g2-hud-return', t('round.return'), 'R');
      returnBtn.addEventListener('click', () => {
        returnBtn.blur();
        opts.onReturnToStart();
      });
      topRight.appendChild(returnBtn);
    }
    hud.appendChild(topRight);

    // Guess map widget: small in the corner, expanded on hover or click, pinnable.
    const widget = el('div', 'g2-map-widget');
    const bar = el('div', 'g2-map-bar');
    bar.appendChild(el('span', 'g2-map-hint', t('round.mapHint')));
    const pinBtn = el('button', 'g2-pin', t('round.pin'));
    pinBtn.type = 'button';
    pinBtn.title = t('round.pinTitle');
    bar.appendChild(pinBtn);
    widget.appendChild(bar);
    const mapMount = el('div', 'g2-map-mount');
    widget.appendChild(mapMount);
    const guessBtn = keyButton('g2-btn g2-btn-primary g2-guess', t('round.guess'), 'Space');
    guessBtn.disabled = true;
    widget.appendChild(guessBtn);
    hud.appendChild(widget);

    let expanded = false;
    let pinned = false;
    let collapseTimer = 0;
    const setExpanded = (value: boolean): void => {
      if (value === expanded) return;
      expanded = value;
      widget.classList.toggle('g2-expanded', value);
      opts.onMapExpandChanged?.(value);
    };
    const cancelCollapse = (): void => window.clearTimeout(collapseTimer);
    widget.addEventListener('mouseenter', () => {
      cancelCollapse();
      setExpanded(true);
    });
    widget.addEventListener('mouseleave', () => {
      if (pinned) return;
      cancelCollapse();
      collapseTimer = window.setTimeout(() => setExpanded(false), COLLAPSE_DELAY_MS);
    });
    // Click also expands (touch, pens). That click is swallowed in the capture phase so Leaflet does not place a
    // marker on the expanded map at the point aimed at on the collapsed one; the next click places the guess.
    mapMount.addEventListener(
      'click',
      (e) => {
        if (expanded) return;
        const onTab = e.target instanceof Element && e.target.closest('.gm-tabs') !== null;
        if (!onTab) e.stopPropagation();
        setExpanded(true);
      },
      true,
    );
    pinBtn.addEventListener('click', () => {
      pinned = !pinned;
      pinBtn.classList.toggle('g2-active', pinned);
      pinBtn.textContent = pinned ? t('round.unpin') : t('round.pin');
      pinBtn.blur();
      if (pinned) setExpanded(true);
    });
    this.mount(screen);
    this.cleanups.push(cancelCollapse);

    let guessEnabled = false;
    let busy = false;
    const syncGuess = (): void => {
      guessBtn.disabled = !guessEnabled || busy;
      guessBtn.classList.toggle('g2-busy', busy);
    };
    const guess = (): void => {
      if (!guessEnabled || busy) return;
      guessBtn.blur();
      opts.onGuess();
    };
    guessBtn.addEventListener('click', guess);

    // --- countdown
    let countdown: CountdownHandle | null = null;
    const setDeadline = (deadline: number | null): void => {
      if (deadline === null) {
        countdown?.stop();
        countdown = null;
        clock.hidden = true;
        return;
      }
      clock.hidden = false;
      if (countdown) {
        countdown.setDeadline(deadline);
        return;
      }
      countdown = startCountdown({
        deadline,
        now,
        onTick: (remaining, level) => {
          clockValue.textContent = formatCountdown(remaining);
          clock.dataset.level = level;
          clock.setAttribute('aria-label', t('round.countdownAria', { time: formatCountdown(remaining) }));
        },
        onExpire: () => {
          clock.dataset.level = 'over';
          clockValue.textContent = formatCountdown(0);
          opts.onTimeout?.();
        },
        onLastCall: () => opts.onLastCall?.(),
      });
    };
    if (opts.deadline != null) setDeadline(opts.deadline);
    this.cleanups.push(() => countdown?.stop());

    this.activeRound = { screen, hud };
    this.setKeys((e) => {
      if (isTypingTarget(e) || hasModifier(e) || e.repeat) return;
      if (isConfirmKey(e)) {
        if (!guessEnabled || busy) return;
        e.preventDefault();
        guess();
      } else if ((e.key === 'r' || e.key === 'R') && !noMove) {
        e.preventDefault();
        opts.onReturnToStart();
      }
    });

    // Mount callbacks run once the elements are laid out, so viewers see their real size.
    opts.mountPanorama(pano);
    opts.mountMap(mapMount);

    return {
      setGuessEnabled(enabled: boolean): void {
        guessEnabled = enabled;
        syncGuess();
      },
      setBusy(value: boolean): void {
        busy = value;
        syncGuess();
      },
      setScore(score: number): void {
        scoreValue.textContent = formatScore(score);
        hudBar.set(score);
      },
      setDeadline,
      slot,
      setRoundLabel(text: string): void {
        roundLabel.textContent = text;
      },
      screen,
    };
  }

  // --- result ------------------------------------------------------------------------------

  showResult(opts: ResultScreenOptions): void {
    const { result } = opts;
    const isLast = result.n >= opts.total;

    let screen: HTMLElement;
    if (this.activeRound) {
      // Keep the panorama behind the overlay; the HUD (with the map widget) goes away because the same map
      // instance gets re-mounted inside the result card.
      const round = this.activeRound;
      this.releaseListeners();
      this.activeRound = null;
      round.hud.remove();
      screen = round.screen;
    } else {
      screen = el('div', 'g2-screen g2-round');
      this.mount(screen);
    }

    const overlay = el('div', 'g2-overlay');
    const card = el('div', 'g2-card g2-result');
    overlay.appendChild(card);

    const heading = el('div', 'g2-result-head');
    heading.appendChild(el('h2', 'g2-heading', t('result.heading', { round: result.n })));
    const answerWorld = result.answer ? worldName(result.answer.world) : '—';
    heading.appendChild(el('span', 'g2-result-world', answerWorld));
    card.appendChild(heading);

    const stats = el('div', 'g2-stats');
    const distance = el('div', 'g2-stat');
    const kind = resultKind(result);
    if (kind === 'distance') {
      distance.appendChild(el('div', 'g2-stat-value', formatDistance(result.distanceM ?? 0)));
      distance.appendChild(el('div', 'g2-stat-label', t('result.fromAnswer')));
    } else {
      distance.classList.add('g2-stat-wrong');
      const title = kind === 'wrongWorld' ? t('result.wrongWorld') : kind === 'timedOut' ? t('result.timedOut') : t('result.noGuess');
      distance.appendChild(el('div', 'g2-stat-value g2-wrong-world', title));
      distance.appendChild(el('div', 'g2-stat-label', t('result.itWas', { world: answerWorld })));
    }
    stats.appendChild(distance);
    const score = el('div', 'g2-stat');
    score.appendChild(el('div', 'g2-stat-value g2-accent', formatScore(result.score)));
    score.appendChild(el('div', 'g2-stat-label', t('result.points')));
    stats.appendChild(score);
    const time = el('div', 'g2-stat g2-stat-time');
    time.appendChild(el('div', 'g2-stat-value', formatDuration(result.timeMs)));
    time.appendChild(el('div', 'g2-stat-label', t('summary.col.time')));
    stats.appendChild(time);
    card.appendChild(stats);

    const mapMount = el('div', 'g2-result-map');
    card.appendChild(mapMount);
    if (opts.extra) card.appendChild(opts.extra);

    const next = (): void => opts.onNext();
    if (!opts.hideNext) {
      const nextBtn = keyButton(
        'g2-btn g2-btn-primary g2-btn-big',
        opts.nextLabel ?? (isLast ? t('result.seeSummary') : t('result.next')),
        'Enter',
      );
      nextBtn.addEventListener('click', () => {
        nextBtn.blur();
        next();
      });
      card.appendChild(nextBtn);
    }

    screen.appendChild(overlay);
    if (!opts.hideNext) {
      this.setKeys((e) => {
        if (isTypingTarget(e) || hasModifier(e) || e.repeat) return;
        if (isConfirmKey(e) && !(e.code === 'Space' && isOwnSpaceTarget(e))) {
          e.preventDefault();
          next();
        }
      });
    }
    opts.mountMap(mapMount);
  }

  // --- teardown ----------------------------------------------------------------------------

  /** Remove the current screen and its listeners (keeps the root and the language subscription). */
  clear(): void {
    this.releaseListeners();
    this.rerender = null;
    this.activeRound = null;
    this.root.replaceChildren();
  }

  destroy(): void {
    this.clear();
    this.unsubscribeLanguage();
    this.root.classList.remove('g2-root');
  }
}

