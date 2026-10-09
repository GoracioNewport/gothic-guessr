/**
 * Round countdown (SPEC §10.1 "Timer", §10.7): pure helpers plus a small ticking widget for the round HUD.
 *
 * Deadlines are server epoch ms; `now` is the client's estimate of the server clock (`ApiClient.serverNow`).
 * GeoGuessr behaviour at zero: a marker the player has placed is submitted as the guess {@link TIMEOUT_SUBMIT_LEAD_MS}
 * BEFORE the deadline (`onLastCall`), so it lands while the server still takes guesses. Without a marker the round
 * screen submits `null` (SPEC §10.4: timer expired on the client) a moment after the deadline
 * ({@link TIMEOUT_SUBMIT_DELAY_MS}, `onExpire`), so the server records it as a timeout. The server accepts guesses
 * up to 2 s after the deadline, which absorbs clock estimate errors.
 */
import { formatDuration } from '../i18n';

/** Delay after the deadline before the client submits the timeout. */
export const TIMEOUT_SUBMIT_DELAY_MS = 300;
/** Lead before the deadline at which a placed marker is submitted. */
export const TIMEOUT_SUBMIT_LEAD_MS = 300;
/** Below this the countdown turns amber. */
export const WARN_MS = 30_000;
/** Below this the countdown turns red and pulses. */
export const URGENT_MS = 10_000;

export type CountdownLevel = 'normal' | 'warn' | 'urgent' | 'over';

/** Milliseconds left until `deadline`, never negative. */
export function remainingMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

/** Visual level for `remaining` ms. */
export function countdownLevel(remaining: number): CountdownLevel {
  if (remaining <= 0) return 'over';
  if (remaining <= URGENT_MS) return 'urgent';
  if (remaining <= WARN_MS) return 'warn';
  return 'normal';
}

/** `m:ss`, rounding up so the display reads 0:00 only when time is really up. */
export function formatCountdown(remaining: number): string {
  return formatDuration(remaining);
}

export interface CountdownOptions {
  deadline: number;
  /** Server clock estimate. */
  now: () => number;
  /** Called on every tick with the remaining ms. */
  onTick: (remaining: number, level: CountdownLevel) => void;
  /** Called once, {@link TIMEOUT_SUBMIT_DELAY_MS} after the deadline. */
  onExpire: () => void;
  /** Called once, {@link TIMEOUT_SUBMIT_LEAD_MS} before the deadline (again if the deadline moves later). */
  onLastCall?: () => void;
  /** Tick interval, ms. */
  intervalMs?: number;
}

/** A running countdown; `stop()` cancels it (idempotent), `setDeadline` moves it (duel countdown). */
export interface CountdownHandle {
  stop(): void;
  setDeadline(deadline: number): void;
}

export function startCountdown(opts: CountdownOptions): CountdownHandle {
  let deadline = opts.deadline;
  let expired = false;
  let lastCalled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = (): void => {
    const now = opts.now();
    const left = remainingMs(deadline, now);
    opts.onTick(left, countdownLevel(left));
    if (!lastCalled && !expired && now >= deadline - TIMEOUT_SUBMIT_LEAD_MS) {
      lastCalled = true;
      opts.onLastCall?.();
    }
    if (!expired && now >= deadline + TIMEOUT_SUBMIT_DELAY_MS) {
      expired = true;
      stop();
      opts.onExpire();
    }
  };
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  timer = setInterval(tick, opts.intervalMs ?? 200);
  tick();
  return {
    stop,
    setDeadline(next: number): void {
      if (next > deadline && opts.now() < next - TIMEOUT_SUBMIT_LEAD_MS) lastCalled = false;
      deadline = next;
      if (!expired) tick();
    },
  };
}
