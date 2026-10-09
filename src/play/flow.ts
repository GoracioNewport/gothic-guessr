/**
 * The game UI over a {@link GameDriver} (SPEC §10.7): round screen → result → … → summary.
 *
 * - {@link RoundPlayer} plays ONE round on screen: panorama fed by the driver's `node`, guess map on the game's
 *   worlds, countdown that submits the placed marker just before zero (GeoGuessr behaviour) or `null` when there is
 *   none, Guess → `driver.guess`. It knows nothing about how
 *   rounds are opened, so a room flow (SPEC §10.6) can call `play()` when its socket pushes `round`, `cancel()` when
 *   the room closes the round first, and `showResult()` with every player's marker (`others`) and its own table.
 * - {@link GameFlow} loops rounds of a REST-driven game (solo, daily, challenge) and ends on the summary page; it
 *   also resumes a running game from its {@link GameView} (current round, current node).
 */
import type { GameView, PublicSettings, RoundResultView, RoundView, WorldGuess } from '../../shared/api';
import type { PlayerMarker } from '../contracts';
import { errorMessage, t } from '../i18n';
import { isApiError } from '../net/api';
import type { AppContext, Page, Viewers } from '../pages/context';
import { renderSummary } from '../pages/summary';
import { toast } from '../ui/dom';
import { noteReportRound, openReportDialog } from '../ui/report';
import type { GuessMap } from '../ui/guessmap';
import type { RoundScreenHandle } from '../ui/screens';
import type { GameDriver } from './session';

/** One guess listener per GuessMap instance (the map has no unsubscribe); the active round swaps the target. */
const guessTargets = new WeakMap<GuessMap, { cb: ((p: WorldGuess) => void) | null }>();

function onMapGuess(map: GuessMap, cb: ((p: WorldGuess) => void) | null): void {
  let target = guessTargets.get(map);
  if (!target) {
    const created: { cb: ((p: WorldGuess) => void) | null } = { cb: null };
    map.onGuess((p) => created.cb?.(p));
    guessTargets.set(map, created);
    target = created;
  }
  target.cb = cb;
}

export interface RoundPlayOptions {
  round: RoundView;
  /** Total rounds of the game (HUD "Round n/total"). */
  total: number;
  /** Score before this round. */
  score: number;
  settings: PublicSettings;
  /** Resume at this node instead of the start (reload). */
  resumeKey?: string | null;
  driver: Pick<GameDriver, 'node' | 'guess' | 'refresh' | 'view'>;
}

export interface RoundPlay {
  /** Resolves with the server's result, or null when cancelled. */
  result: Promise<RoundResultView | null>;
  /** The round screen (HUD slot for room extras, deadline changes). */
  handle: RoundScreenHandle;
  /** Stop the round without a guess (the room closed it). */
  cancel(): void;
}

/** Retries of an automatic (timer) submission that failed on the network. */
const TIMEOUT_RETRIES = 3;

export class RoundPlayer {
  private readonly ctx: AppContext;
  private readonly viewers: Viewers;

  constructor(ctx: AppContext, viewers: Viewers) {
    this.ctx = ctx;
    this.viewers = viewers;
  }

  play(opts: RoundPlayOptions): RoundPlay {
    const { panorama, map } = this.viewers;
    const { round, settings, driver } = opts;
    const noMove = settings.noMove || settings.noLook;
    const noLook = settings.noLook;
    let done = false;
    let submitting = false;
    let settle: (r: RoundResultView | null) => void = () => undefined;
    const result = new Promise<RoundResultView | null>((resolve) => (settle = resolve));

    panorama.setProvider((key) => driver.node(key));
    const gameId = driver.view.id;
    noteReportRound(gameId, round.n);

    const finish = (r: RoundResultView | null): void => {
      if (done) return;
      done = true;
      onMapGuess(map, null);
      handle.setDeadline(null);
      panorama.setMovementEnabled(false);
      settle(r);
    };

    /** The server already closed the round (timeout recorded lazily, double submit): take its result. */
    const recover = async (): Promise<void> => {
      try {
        const view = await driver.refresh();
        const r = view.results.find((x) => x.n === round.n);
        if (r) finish(r);
        else toast(t('error.round_over'));
      } catch (err) {
        toast(messageOf(err));
      }
    };

    /** `auto`: sent by the timer, retried on network errors (the server's grace window still takes it). */
    const submit = async (guess: WorldGuess | null, auto = false, attempt = 0): Promise<void> => {
      if (done || submitting) return;
      submitting = true;
      handle.setBusy(true);
      try {
        finish(await driver.guess(guess));
      } catch (err) {
        if (isApiError(err, 'round_over')) {
          await recover();
        } else {
          toast(messageOf(err));
          if (auto && attempt < TIMEOUT_RETRIES && !done) {
            submitting = false;
            window.setTimeout(() => void submit(guess, true, attempt + 1), 1000);
            return;
          }
        }
      } finally {
        submitting = false;
        if (!done) handle.setBusy(false);
      }
    };

    const handle = this.ctx.screens.showRound({
      round: round.n,
      total: opts.total,
      score: opts.score,
      noMove,
      noLook,
      deadline: round.deadline,
      now: () => this.ctx.api.serverNow(),
      // Time is up: the placed marker counts as the guess (sent just before the deadline); no marker → timeout.
      onLastCall: () => {
        const marker = map.getGuess();
        if (marker) void submit(marker, true);
      },
      onTimeout: () => void submit(map.getGuess(), true),
      onGuess: () => void submit(map.getGuess()),
      // The flag reports where the player stands (the server knows it) or an earlier round's start.
      onReport: () => openReportDialog(this.ctx.api, { current: { gameId }, game: { gameId, rounds: round.n - 1 } }),
      onReturnToStart: () => {
        if (noMove || done) return;
        void panorama.goTo(round.start.key, { instant: true }).catch(reportError);
      },
      mountPanorama: (el) => {
        void panorama
          .init(el)
          .then(() => {
            // Toggles first: a frozen camera opens facing north at the default zoom.
            panorama.setMovementEnabled(!noMove);
            panorama.setLookEnabled(!noLook);
            return panorama.goTo(opts.resumeKey ?? round.start.key, { instant: true, resetView: true });
          })
          .catch((err: unknown) => {
            if (isApiError(err, 'round_over')) void recover();
            else reportError(err);
          });
      },
      mountMap: (el) => {
        // Fresh map every round: no marker, every world fitted again, and the first tab is the first enabled
        // world, never the round's own one (SPEC §9.4).
        map.clearGuess();
        map.init(el, this.ctx.mapWorlds(settings.worlds));
      },
      onMapExpandChanged: (expanded) => map.setExpanded(expanded),
    });
    onMapGuess(map, () => {
      if (!done) handle.setGuessEnabled(true);
    });

    return {
      result,
      handle,
      cancel: () => finish(null),
    };
  }

  /**
   * The result overlay with the map in result mode. `others` = other players' markers (rooms). Resolves when the
   * player presses Next (never, with `hideNext`).
   */
  showResult(
    result: RoundResultView,
    opts: { total: number; others?: PlayerMarker[]; extra?: HTMLElement; nextLabel?: string; hideNext?: boolean; settings: PublicSettings },
  ): Promise<void> {
    const { map } = this.viewers;
    return new Promise((resolve) => {
      this.ctx.screens.showResult({
        result,
        total: opts.total,
        extra: opts.extra,
        nextLabel: opts.nextLabel,
        hideNext: opts.hideNext,
        onNext: () => resolve(),
        mountMap: (el) => {
          // Same map instance, new container: re-init with the game's worlds, then result mode.
          map.init(el, this.ctx.mapWorlds(opts.settings.worlds));
          if (result.answer) map.showResult(result.guess, result.answer, opts.others);
        },
      });
    });
  }
}

/**
 * Plays a REST-driven game to its end and shows the summary. Destroying it (route change) stops at the next step;
 * the server keeps the game, so the challenge or daily page can resume it later.
 */
export class GameFlow implements Page {
  alive = true;
  private readonly ctx: AppContext;
  private readonly driver: GameDriver;
  private current: RoundPlay | null = null;

  constructor(ctx: AppContext, driver: GameDriver) {
    this.ctx = ctx;
    this.driver = driver;
  }

  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    this.current?.cancel();
    this.current = null;
    const viewers = this.ctx.viewers();
    void viewers.then(({ map }) => onMapGuess(map, null)).catch(() => undefined);
  }

  /** Run (or resume) the game. Errors show a message with Retry and Main menu. */
  async start(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      if (!this.alive) return;
      reportError(err);
      this.ctx.screens.showMessage({
        text: () => messageOf(err),
        error: true,
        actions: [
          { label: () => t('app.retry'), primary: true, onClick: () => void this.retry() },
          { label: () => t('summary.backToMenu'), onClick: () => this.ctx.router.navigate('/') },
        ],
      });
    }
  }

  private async retry(): Promise<void> {
    this.ctx.screens.showMessage({ text: () => t('menu.loading') });
    try {
      await this.driver.refresh();
    } catch {
      /* start() shows the error again */
    }
    await this.start();
  }

  private async run(): Promise<void> {
    const viewers = await this.ctx.viewers();
    const player = new RoundPlayer(this.ctx, viewers);
    while (this.alive) {
      const view: GameView = this.driver.view;
      if (view.finished) {
        await this.showSummary(viewers);
        return;
      }
      if (view.roomCode) {
        // Room games are driven by the room (SPEC §10.6): go there.
        this.ctx.router.navigate({ name: 'room', code: view.roomCode }, { replace: true });
        return;
      }
      const resumeKey = view.current ? view.currentKey : null;
      const round = await this.driver.nextRound();
      if (!this.alive) return;
      const play = player.play({
        round,
        total: view.totalRounds,
        score: view.total,
        settings: view.settings,
        resumeKey,
        driver: this.driver,
      });
      this.current = play;
      const result = await play.result;
      this.current = null;
      if (!result || !this.alive) return;
      await player.showResult(result, { total: this.driver.view.totalRounds, settings: view.settings });
    }
  }

  private async showSummary(viewers: Viewers): Promise<void> {
    const summary = await this.driver.summary();
    if (!this.alive) return;
    // The summary replaces the panorama: release WebGL and the map until the next game.
    viewers.panorama.destroy();
    viewers.map.destroy();
    viewers.map.clearGuess();
    renderSummary(this.ctx, this, summary);
  }
}

function messageOf(err: unknown): string {
  if (isApiError(err)) return errorMessage(err.code);
  return t('error.unknown');
}

function reportError(err: unknown): void {
  console.error(err);
}
