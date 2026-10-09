/**
 * The room page (SPEC §10.6, §10.7, route `/r/<CODE>`): party and duel on top of the WebSocket protocol.
 *
 * Flow: `GET /api/rooms/:code` (404 → "no such room"), `GET /api/me` (who am I), then the socket
 * (src/net/ws.ts) joins the room on every open. Every server message is folded into {@link RoomState}
 * (src/ui/roomstate.ts) and the page follows it:
 *
 *   lobby / over  → {@link lobbyScreen} or the final standings (until "Back to the lobby")
 *   started       → this player's game view (`GET /games/:id`, resume position after a reload)
 *   round         → {@link RoundPlayer} with this player's game over REST (nodes, guess); the HUD slot carries the
 *                   "guessed" ticks, the duel HP bars and the duel countdown banner
 *   roundResult   → the result card with every player's marker, the round table, the auto-advance countdown and the
 *                   host's Next button
 *   gameOver      → final standings, duel winner/draw/forfeit, "Let friends play these rounds", back to the lobby
 *
 * Messages are handled one at a time (a `started` waits for its game view before the `round` that follows).
 * A reload or a dropped connection rejoins the room and the server re-sends its state; a round that was already
 * guessed shows the waiting screen instead of the panorama. Leaving the page (route change) only disconnects;
 * "Leave room" (lobby, round HUD, result card, standings) sends `leave` first. Server semantics (core/party.ts):
 * in a party game the leaver stays in the standings and scores 0 for the rounds left (coming back by link resumes);
 * in a running duel `leave` forfeits at once, so the page asks first.
 * The host of a party round also gets "End round": the server gives everyone still guessing a short countdown,
 * their placed markers are submitted before it runs out (src/play/flow.ts), the rest time out with 0.
 */
import type { GameView, PlayerView, PublicSettings, RoomType, RoomView, RoundResultView, ServerMessage } from '../../shared/api';
import type { PlayerMarker } from '../contracts';
import { errorMessage, t } from '../i18n';
import { isApiError } from '../net/api';
import { RoomConnection } from '../net/ws';
import type { ConnectionStatus } from '../net/ws';
import type { AppContext, Page, Viewers } from '../pages/context';
import { readSoloSettings } from '../pages/setup';
import { RoundPlayer } from '../play/flow';
import type { RoundPlay } from '../play/flow';
import { RestGameSession } from '../play/session';
import { challengeLink } from '../play/share';
import { button, copyField, el, toast } from './dom';
import { createLangSelect } from './langselect';
import { legalLink } from './legal';
import { DEFAULT_TIME_LIMIT, lobbyScreen, roomTypeTitle, settingsForType } from './lobby';
import { duelBanner, duelPanel, guessedPanel, hudBanner, roundTable, standingsTable } from './roomhud';
import {
  duelOutcome,
  duelSides,
  errorSeverity,
  initialRoomState,
  isHost,
  nicknames,
  playerColors,
  reduceRoom,
  roomScreen,
  roundRows,
  secondsUntil,
  standingRows,
} from './roomstate';
import type { RoomState } from './roomstate';

/** Settings edits are sent this long after the last change (the server allows 20 messages per 5 s). */
const SETTINGS_DEBOUNCE_MS = 300;
/** A `conflict` this soon after our `start` is the answer to it, not "another tab took over". */
const START_ANSWER_MS = 5000;

/** Default settings of a new room: the last solo settings, 2 min per round for a party, no limit for a duel. */
export function newRoomSettings(type: RoomType, slugs: readonly string[]): PublicSettings {
  const solo = readSoloSettings(slugs);
  return settingsForType(type, { ...solo, timeLimit: DEFAULT_TIME_LIMIT[type], rounds: 5 });
}

/**
 * "Create room" from the menu (a normal room; the host may turn it into a duel in the lobby): `POST /api/rooms`,
 * then the room page. Errors are shown as a toast.
 */
export async function createRoom(ctx: AppContext, type: RoomType): Promise<void> {
  try {
    const res = await ctx.api.call<{ code: string }>('/rooms', { method: 'POST', body: { type, settings: newRoomSettings(type, ctx.slugs) } });
    ctx.router.navigate({ name: 'room', code: res.code });
  } catch (err) {
    toast(isApiError(err) ? errorMessage(err.code) : t('error.unknown'));
  }
}

/** Mount the room page for `code`. */
export function roomPage(ctx: AppContext, code: string): Page {
  const page = new RoomController(ctx, code.toUpperCase());
  void page.start();
  return page;
}

type Shown = 'loading' | 'lobby' | 'round' | 'waiting' | 'result' | 'over' | 'message';

class RoomController implements Page {
  alive = true;
  private readonly ctx: AppContext;
  private readonly code: string;
  private state: RoomState = initialRoomState();
  private me: PlayerView | null = null;
  private conn: RoomConnection | null = null;
  private queue: Promise<void> = Promise.resolve();
  private shown: Shown = 'loading';
  /** Joined at least once on the current connection (errors after that are not fatal). */
  private joined = false;
  /** The player left the standings for the lobby. */
  private overDismissed = false;
  private awaitingStartUntil = 0;
  // --- game
  private viewers: Viewers | null = null;
  private roundPlayer: RoundPlayer | null = null;
  private session: RestGameSession | null = null;
  private play: RoundPlay | null = null;
  private playN = 0;
  /** Rounds this player has guessed (from REST answers and the game view). */
  private readonly guessedRounds = new Set<number>();
  private resultN = 0;
  // --- settings edits
  private draft: { type: RoomType; settings: PublicSettings } | null = null;
  private draftTimer = 0;
  private draftSent = false;
  // --- timers and widgets
  private slotTimer = 0;
  private resultTimer = 0;
  private resultExtra: HTMLElement | null = null;
  private connBanner: HTMLElement | null = null;
  private langCleanup: (() => void) | null = null;

  constructor(ctx: AppContext, code: string) {
    this.ctx = ctx;
    this.code = code;
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.showMessage(() => t('room.joining'));
    let view: RoomView;
    try {
      view = await this.ctx.api.call<RoomView>(`/rooms/${encodeURIComponent(this.code)}`);
      this.me = await this.ctx.api.me();
    } catch (err) {
      if (!this.alive) return;
      if (isApiError(err, 'not_found')) this.fatal('not_found');
      else this.showError(err);
      return;
    }
    if (!this.alive) return;
    if (this.me.banned) {
      this.fatal('banned');
      return;
    }
    this.state = { ...this.state, room: view, challengeCode: view.challengeCode };
    this.connect();
  }

  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    this.conn?.stop();
    this.conn = null;
    this.stopRound();
    this.clearTimers();
    window.clearTimeout(this.draftTimer);
    this.connBanner?.remove();
    this.connBanner = null;
    this.langCleanup?.();
    this.langCleanup = null;
  }

  private connect(): void {
    this.conn?.stop();
    this.joined = false;
    const conn = new RoomConnection({
      token: () => this.ctx.api.getToken(),
      onOpen: () => {
        this.joined = false;
        conn.send({ t: 'join', code: this.code });
      },
      onMessage: (msg) => this.enqueue(msg),
      onStatus: (status) => this.onStatus(status),
      onStopped: (reason) => {
        if (this.alive) this.fatal(reason === 'banned' ? 'banned' : 'auth');
      },
      onAuthFailure: async () => {
        // The REST client replaces an unknown token on its next call (401 → new player).
        try {
          this.me = await this.ctx.api.me();
          return true;
        } catch {
          return false;
        }
      },
    });
    this.conn = conn;
    conn.start();
  }

  private send(msg: Parameters<RoomConnection['send']>[0]): void {
    if (!this.conn?.send(msg)) toast(t('room.reconnecting'), 'info');
  }

  private enqueue(msg: ServerMessage): void {
    this.queue = this.queue
      .then(() => (this.alive ? this.handle(msg) : undefined))
      .catch((err: unknown) => console.error('room message failed', msg.t, err));
  }

  private onStatus(status: ConnectionStatus): void {
    if (!this.alive) return;
    if (status === 'reconnecting') {
      this.joined = false;
      if (!this.connBanner) {
        this.connBanner = el('div', 'g2-room-conn', t('room.reconnecting'));
        this.connBanner.setAttribute('role', 'status');
        document.body.appendChild(this.connBanner);
      }
    } else if (status === 'open' || status === 'stopped') {
      this.connBanner?.remove();
      this.connBanner = null;
    }
  }

  private get myId(): string | null {
    return this.me?.id ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------------------------

  private async handle(msg: ServerMessage): Promise<void> {
    const prev = this.state;
    this.state = reduceRoom(prev, msg);
    switch (msg.t) {
      case 'room':
        this.joined = true;
        if (this.draft && this.draftSent) {
          this.draft = null;
          this.draftSent = false;
        }
        if (msg.room.phase === 'round' || msg.room.phase === 'result') this.awaitingStartUntil = 0;
        this.refresh();
        return;
      case 'started':
        this.awaitingStartUntil = 0;
        this.overDismissed = false;
        await this.loadGame(msg.gameId);
        return;
      case 'round':
        await this.showRound();
        return;
      case 'guessed':
      case 'countdown':
        this.updateRoundHud();
        return;
      case 'roundResult':
        await this.showRoundResult();
        return;
      case 'gameOver':
        // Someone who joined after that game goes straight to the lobby.
        this.overDismissed = !msg.standings.some((s) => s.playerId === this.myId);
        this.refresh();
        return;
      case 'kicked':
        this.conn?.stop();
        this.stopRound();
        this.showMessage(() => t('room.kicked'), true);
        return;
      case 'error':
        this.onError(msg.error);
        return;
      case 'pong':
        return;
    }
  }

  private onError(code: Extract<ServerMessage, { t: 'error' }>['error']): void {
    const awaitingStart = Date.now() < this.awaitingStartUntil;
    const severity = errorSeverity(code, { awaitingStart, joined: this.joined });
    if (severity === 'fatal') {
      this.fatal(code);
      return;
    }
    if (severity === 'replaced') {
      this.conn?.stop();
      this.stopRound();
      this.showMessage(() => t('room.replaced'), false, [
        {
          label: () => t('room.useHere'),
          primary: true,
          onClick: () => {
            this.shown = 'loading';
            this.showMessage(() => t('room.joining'));
            this.connect();
          },
        },
      ]);
      return;
    }
    if (code === 'conflict' && awaitingStart) {
      this.awaitingStartUntil = 0;
      this.refresh();
      toast(this.state.room?.type === 'duel' ? t('room.needTwo') : errorMessage(code));
      return;
    }
    if (this.draft && this.draftSent) {
      // The settings were refused: show the room's own again.
      this.draft = null;
      this.draftSent = false;
      this.refresh();
    }
    toast(errorMessage(code));
  }

  /** Re-render whatever the state asks for (lobby/over changes, HUD updates, result totals). */
  private refresh(): void {
    const screen = roomScreen(this.state);
    if (screen === 'lobby' || (screen === 'over' && this.overDismissed)) {
      this.showLobby();
    } else if (screen === 'over') {
      this.showOver();
    } else if (screen === 'round') {
      this.updateRoundHud();
    } else if (screen === 'result') {
      this.updateResultExtra();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------------------------

  private showLobby(): void {
    const room = this.state.room;
    if (!room || !this.alive) return;
    if (this.shown === 'round' || this.shown === 'waiting' || this.shown === 'result') this.releaseViewers();
    this.stopRound();
    this.clearTimers();
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focus;
    const type = this.draft?.type ?? room.type;
    const settings = this.draft?.settings ?? room.settings;
    const view = lobbyScreen(
      {
        room,
        me: this.myId,
        type,
        settings,
        colors: playerColors(room.players),
        worlds: this.ctx.worlds.index.worlds,
        slugs: this.ctx.slugs,
        starting: Date.now() < this.awaitingStartUntil,
      },
      {
        onSettings: (nextType, next) => this.editSettings(nextType, next),
        onKick: (id, name) => {
          if (window.confirm(t('room.kickConfirm', { name }))) this.send({ t: 'kick', playerId: id });
        },
        onStart: () => {
          this.flushSettings();
          this.awaitingStartUntil = Date.now() + START_ANSWER_MS;
          this.send({ t: 'start' });
          this.showLobby();
        },
        onLeave: () => this.leave(),
      },
    );
    this.shown = 'lobby';
    this.ctx.screens.page(view.screen, { rerender: () => this.showLobby(), cleanup: () => view.destroy() });
    if (focusKey) view.screen.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
  }

  private editSettings(type: RoomType, settings: PublicSettings): void {
    this.draft = { type, settings };
    this.draftSent = false;
    window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => this.flushSettings(), SETTINGS_DEBOUNCE_MS);
    this.showLobby();
  }

  private flushSettings(): void {
    window.clearTimeout(this.draftTimer);
    const draft = this.draft;
    if (!draft || this.draftSent) return;
    this.draftSent = true;
    this.send({ t: 'settings', type: draft.type, settings: draft.settings });
  }

  private leave(): void {
    const room = this.state.room;
    if (room?.type === 'duel' && this.state.gameId && !window.confirm(t('room.leaveDuelConfirm'))) return;
    this.conn?.send({ t: 'leave' });
    this.conn?.stop();
    this.conn = null;
    this.ctx.router.navigate('/');
  }

  // -------------------------------------------------------------------------------------------
  // Game
  // -------------------------------------------------------------------------------------------

  private async loadGame(gameId: string): Promise<void> {
    try {
      const view: GameView = await this.ctx.api.getGame(gameId);
      if (!this.alive) return;
      if (this.session?.id !== gameId) this.guessedRounds.clear();
      this.session = new RestGameSession(this.ctx.api, view);
      for (const r of view.results) this.guessedRounds.add(r.n);
    } catch (err) {
      console.error('room game view failed', err);
      if (this.session?.id !== gameId) this.session = null;
    }
  }

  private async ensureViewers(): Promise<boolean> {
    if (this.viewers && this.roundPlayer) return true;
    try {
      this.viewers = await this.ctx.viewers();
      this.roundPlayer = new RoundPlayer(this.ctx, this.viewers);
      return true;
    } catch (err) {
      console.error(err);
      if (this.alive) this.showMessage(() => t('boot.viewerFailed', { error: err instanceof Error ? err.message : String(err) }), true);
      return false;
    }
  }

  /** The game's settings (its own view; the room's while it loads). */
  private gameSettings(): PublicSettings {
    return this.session?.view.settings ?? this.state.room?.settings ?? newRoomSettings('party', this.ctx.slugs);
  }

  private myTotal(): number {
    return this.state.room?.players.find((p) => p.id === this.myId)?.total ?? 0;
  }

  private roundLabel(n: number): string {
    const settings = this.gameSettings();
    return this.state.room?.type === 'duel' ? t('room.roundN', { round: n }) : t('round.counter', { round: n, total: settings.rounds });
  }

  private async showRound(): Promise<void> {
    const round = this.state.round;
    if (!round || !this.state.gameId) return;
    // The same round again (reconnect): keep the panorama, refresh the HUD.
    if (this.play && this.playN === round.n && this.shown === 'round') {
      this.play.handle.setDeadline(round.deadline);
      this.updateRoundHud();
      return;
    }
    if (!this.session || this.session.id !== this.state.gameId) await this.loadGame(this.state.gameId);
    if (!this.alive || this.state.round?.n !== round.n || this.state.result) return;
    if (!(await this.ensureViewers()) || !this.alive) return;
    if (this.state.round?.n !== round.n || this.state.result) return;
    this.stopRound();
    this.clearTimers();
    if (this.guessedRounds.has(round.n)) {
      this.showWaiting();
      return;
    }
    const session = this.session;
    if (!session) {
      this.showMessage(() => t('error.unknown'), true);
      return;
    }
    const resumeKey = session.view.current?.n === round.n ? session.view.currentKey : null;
    const settings = this.gameSettings();
    const play = this.roundPlayer!.play({
      round: { n: round.n, start: round.node, deadline: round.deadline, startedAt: round.startedAt },
      total: settings.rounds,
      score: this.myTotal(),
      settings,
      resumeKey,
      driver: session,
    });
    this.play = play;
    this.playN = round.n;
    this.shown = 'round';
    play.handle.setRoundLabel(this.roundLabel(round.n));
    this.updateRoundHud();
    void play.result.then((r) => {
      if (!r || this.play !== play || !this.alive) return;
      this.guessedRounds.add(r.n);
      play.handle.screen.classList.add('g2-room-waiting');
      // Keep showing the round's clock (the duel countdown matters to the one who already guessed too).
      if (this.state.round?.deadline != null && !this.state.result) play.handle.setDeadline(this.state.round.deadline);
      this.updateRoundHud();
    });
  }

  /** A round this player already guessed (reload, reconnect): ticks and HP on a plain screen. */
  private showWaiting(): void {
    const render = (): void => {
      if (!this.alive) return;
      const screen = el('div', 'g2-screen g2-centered g2-room-wait');
      const card = el('div', 'g2-card g2-room-wait-card');
      const n = this.state.round?.n ?? 0;
      card.appendChild(el('h2', 'g2-heading', this.roundLabel(n)));
      card.appendChild(el('p', 'g2-muted', t('round.waitingOthers')));
      const slot = el('div', 'g2-room-wait-slot');
      card.appendChild(slot);
      screen.appendChild(card);
      this.shown = 'waiting';
      this.ctx.screens.page(screen, { rerender: render });
      this.fillSlot(slot, true);
    };
    render();
  }

  /** Re-draw the HUD extras of the round on screen. */
  private updateRoundHud(): void {
    if (this.shown === 'waiting') {
      const slot = this.ctx.screens.element.querySelector<HTMLElement>('.g2-room-wait-slot');
      if (slot) this.fillSlot(slot, true);
      return;
    }
    if (this.shown !== 'round' || !this.play) return;
    if (this.state.countdown !== null && this.state.round) this.play.handle.setDeadline(this.state.round.deadline);
    this.fillSlot(this.play.handle.slot, this.guessedRounds.has(this.playN));
  }

  private fillSlot(slot: HTMLElement, waiting: boolean): void {
    window.clearInterval(this.slotTimer);
    const { room, round } = this.state;
    if (!room || !round) return;
    const me = this.myId;
    const colors = playerColors(room.players);
    const names = nicknames(room);
    const parts: HTMLElement[] = [];
    if (round.duel) {
      parts.push(duelPanel(duelSides(round.duel.hp, me, names), round.duel.multiplier, { colors, compact: true }));
    }
    parts.push(guessedPanel(room.players, this.state.guessed, me, colors));
    if (waiting) {
      parts.push(hudBanner(t('round.waitingOthers')));
    } else if (this.state.countdown !== null) {
      const first = this.state.guessed.find((id) => id !== me);
      const banner = hudBanner('', 'alert');
      const deadline = this.state.countdown;
      const party = room.type === 'party';
      const tick = (): void => {
        const seconds = secondsUntil(deadline, this.ctx.api.serverNow());
        banner.textContent = party
          ? t('room.endingRound', { seconds })
          : t('duel.countdown', { name: names.get(first ?? '') ?? '?', seconds });
      };
      tick();
      this.slotTimer = window.setInterval(tick, 250);
      parts.push(banner);
    }
    parts.push(this.roundActions(room));
    slot.replaceChildren(...parts);
  }

  /** Round HUD buttons: "End round" (party host, until the countdown runs) and "Leave room". */
  private roundActions(room: RoomView): HTMLElement {
    const box = el('div', 'g2-room-hud-actions');
    if (room.type === 'party' && isHost(room, this.myId) && this.state.countdown === null) {
      const end = button(t('room.endRound'), 'g2-btn g2-btn-secondary g2-btn-small g2-room-end', () => {
        if (window.confirm(t('room.endRoundConfirm'))) this.send({ t: 'endRound' });
      });
      end.title = t('room.endRoundHint');
      box.appendChild(end);
    }
    box.appendChild(button(t('room.leave'), 'g2-btn g2-btn-secondary g2-btn-small g2-room-leave', () => this.leave()));
    return box;
  }

  private async showRoundResult(): Promise<void> {
    const msg = this.state.result;
    const room = this.state.room;
    if (!msg || !room || !this.state.gameId) return;
    if (this.shown === 'result' && this.resultN === msg.n) {
      this.updateResultExtra();
      return;
    }
    this.play?.cancel();
    this.play = null;
    this.guessedRounds.add(msg.n);
    window.clearInterval(this.slotTimer);
    if (!(await this.ensureViewers()) || !this.alive) return;
    if (this.state.result !== msg) return;
    const me = this.myId;
    const names = nicknames(room);
    const colors = playerColors(room.players, msg.results.map((r) => r.playerId));
    const mine = msg.results.find((r) => r.playerId === me);
    const result: RoundResultView = {
      n: msg.n,
      guess: mine?.guess ?? null,
      answer: msg.answer,
      distanceM: mine?.distanceM ?? null,
      score: mine?.score ?? 0,
      timeMs: mine?.timeMs ?? 0,
      timedOut: !mine?.guess,
    };
    const others: PlayerMarker[] = msg.results
      .filter((r) => r.playerId !== me)
      .map((r) => ({ id: r.playerId, name: names.get(r.playerId) ?? '?', color: colors.get(r.playerId) ?? '#999', guess: r.guess }));
    const settings = this.gameSettings();
    const last = msg.duel ? Object.values(msg.duel.hp).some((hp) => hp <= 0) || msg.n >= settings.rounds : msg.n >= settings.rounds;
    const extra = el('div', 'g2-room-result-extra');
    this.resultExtra = extra;
    this.resultN = msg.n;
    this.shown = 'result';
    this.fillResultExtra(extra, last);
    const host = isHost(room, me);
    void this.roundPlayer!.showResult(result, {
      total: settings.rounds,
      others,
      extra,
      nextLabel: last ? t('room.showStandings') : t('room.next'),
      hideNext: !host,
      settings,
    }).then(() => {
      if (this.alive && this.state.result === msg) this.send({ t: 'next' });
    });
  }

  private updateResultExtra(): void {
    const msg = this.state.result;
    if (this.shown !== 'result' || !this.resultExtra || !msg) return;
    const settings = this.gameSettings();
    const last = msg.duel ? Object.values(msg.duel.hp).some((hp) => hp <= 0) || msg.n >= settings.rounds : msg.n >= settings.rounds;
    this.fillResultExtra(this.resultExtra, last);
  }

  private fillResultExtra(box: HTMLElement, last: boolean): void {
    window.clearInterval(this.resultTimer);
    const msg = this.state.result;
    const room = this.state.room;
    if (!msg || !room) return;
    const me = this.myId;
    const names = nicknames(room);
    const colors = playerColors(room.players, msg.results.map((r) => r.playerId));
    const parts: HTMLElement[] = [];
    if (msg.duel) {
      parts.push(duelPanel(duelSides(msg.duel.hp, me, names), msg.duel.multiplier, { colors, before: this.state.hpBefore }));
    }
    const totals = new Map(room.players.map((p) => [p.id, p.total] as const));
    parts.push(roundTable(roundRows(msg, me, names), { colors, totals, duel: !!msg.duel }));
    // The auto-advance line and Leave room share one row.
    const actions = el('div', 'g2-room-hud-actions g2-room-result-actions');
    if (msg.nextAt !== undefined) {
      const nextAt = msg.nextAt;
      const line = el('p', 'g2-muted g2-room-next');
      line.setAttribute('aria-live', 'off');
      const tick = (): void => {
        const seconds = secondsUntil(nextAt, this.ctx.api.serverNow());
        line.textContent = last ? t('room.standingsIn', { seconds }) : t('room.nextIn', { seconds });
      };
      tick();
      this.resultTimer = window.setInterval(tick, 250);
      actions.appendChild(line);
    }
    actions.appendChild(button(t('room.leave'), 'g2-btn g2-btn-secondary g2-btn-small g2-room-leave', () => this.leave()));
    parts.push(actions);
    box.replaceChildren(...parts);
  }

  // -------------------------------------------------------------------------------------------
  // Game over
  // -------------------------------------------------------------------------------------------

  private showOver(): void {
    const over = this.state.gameOver;
    const room = this.state.room;
    if (!over || !room || !this.alive) return;
    if (this.overDismissed) {
      this.showLobby();
      return;
    }
    if (this.shown === 'round' || this.shown === 'waiting' || this.shown === 'result') this.releaseViewers();
    this.stopRound();
    this.clearTimers();
    this.session = null;
    this.guessedRounds.clear();
    const render = (): void => {
      if (!this.alive) return;
      this.langCleanup?.();
      const me = this.myId;
      const names = nicknames(room, over.standings);
      const colors = playerColors(this.state.room?.players ?? [], over.standings.map((s) => s.playerId));
      const duel = over.winner !== undefined;
      const screen = el('div', 'g2-screen g2-centered g2-summary g2-room-over');
      const lang = createLangSelect({ corner: true });
      this.langCleanup = () => lang.destroy();
      screen.appendChild(lang.root);
      const card = el('div', 'g2-card g2-card-wide');
      screen.appendChild(card);
      const head = el('div', 'g2-summary-head');
      head.appendChild(el('h2', 'g2-heading', t('room.finalStandings')));
      head.appendChild(el('span', 'g2-result-world', roomTypeTitle(duel ? 'duel' : 'party')));
      card.appendChild(head);
      const outcome = duelOutcome(over, me, this.state.room);
      if (outcome) card.appendChild(duelBanner(outcome, names, this.state.room?.settings.rounds ?? 30));
      card.appendChild(standingsTable(standingRows(over.standings, me, over.winner), { colors, duel }));
      const share = el('section', 'g2-share');
      share.appendChild(el('h3', 'g2-legend', t('room.letFriendsPlay')));
      share.appendChild(el('p', 'g2-muted g2-share-hint', t('room.letFriendsPlayHint')));
      share.appendChild(copyField(challengeLink(over.challengeCode), { label: t('share.copyLink'), className: 'g2-share-link' }));
      card.appendChild(share);
      const actions = el('div', 'g2-actions g2-actions-end');
      actions.appendChild(button(t('room.leave'), 'g2-btn g2-btn-secondary g2-room-leave', () => this.leave()));
      const back = button(t('room.backToLobby'), 'g2-btn g2-btn-primary g2-room-back', () => {
        this.overDismissed = true;
        this.showLobby();
      });
      actions.appendChild(back);
      card.appendChild(actions);
      screen.appendChild(legalLink());
      this.shown = 'over';
      this.ctx.screens.page(screen, {
        rerender: render,
        cleanup: () => {
          lang.destroy();
          if (this.langCleanup) this.langCleanup = null;
        },
      });
    };
    render();
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  private stopRound(): void {
    this.play?.cancel();
    this.play = null;
    this.playN = 0;
    this.resultExtra = null;
    this.resultN = 0;
  }

  /** Stop the HUD and result tickers (the pending settings send keeps running: it outlives lobby re-renders). */
  private clearTimers(): void {
    window.clearInterval(this.slotTimer);
    window.clearInterval(this.resultTimer);
  }

  /** Release WebGL and the map while no round is on screen (the next round initialises them again). */
  private releaseViewers(): void {
    const v = this.viewers;
    if (!v) return;
    this.stopRound();
    v.panorama.destroy();
    v.map.destroy();
    v.map.clearGuess();
  }

  private fatal(code: string): void {
    this.conn?.stop();
    this.conn = null;
    if (this.shown === 'round' || this.shown === 'waiting' || this.shown === 'result') this.releaseViewers();
    this.stopRound();
    this.clearTimers();
    const text = (): string => {
      if (code === 'not_found') return t('room.notFound');
      if (code === 'room_closed') return t('room.closed');
      if (code === 'forbidden') return t('room.kicked');
      return errorMessage(code);
    };
    this.showMessage(text, true);
  }

  private showError(err: unknown): void {
    console.error(err);
    this.showMessage(() => (isApiError(err) ? errorMessage(err.code) : t('error.unknown')), true, [
      { label: () => t('app.retry'), primary: true, onClick: () => void this.start() },
    ]);
  }

  private showMessage(text: () => string, error = false, actions: { label: () => string; onClick: () => void; primary?: boolean }[] = []): void {
    if (!this.alive) return;
    this.shown = actions.length || error ? 'message' : 'loading';
    this.ctx.screens.showMessage({
      text,
      error,
      actions: [...actions, { label: () => t('summary.backToMenu'), onClick: () => this.ctx.router.navigate('/') }],
    });
  }
}
