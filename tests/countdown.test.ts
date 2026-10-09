import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMEOUT_SUBMIT_DELAY_MS, TIMEOUT_SUBMIT_LEAD_MS, countdownLevel, formatCountdown, remainingMs, startCountdown } from '../src/play/countdown';

afterEach(() => {
  vi.useRealTimers();
});

describe('countdown helpers', () => {
  it('remaining time is never negative', () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 12_000)).toBe(0);
  });

  it('levels: normal, warn ≤ 30 s, urgent ≤ 10 s, over at 0', () => {
    expect(countdownLevel(120_000)).toBe('normal');
    expect(countdownLevel(30_000)).toBe('warn');
    expect(countdownLevel(10_000)).toBe('urgent');
    expect(countdownLevel(1)).toBe('urgent');
    expect(countdownLevel(0)).toBe('over');
  });

  it('formats as m:ss rounding up, so 0:00 means time is up', () => {
    expect(formatCountdown(120_000)).toBe('2:00');
    expect(formatCountdown(119_001)).toBe('2:00');
    expect(formatCountdown(59_000)).toBe('0:59');
    expect(formatCountdown(500)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(3_600_000)).toBe('1:00:00');
  });
});

describe('startCountdown', () => {
  it('ticks and expires once, shortly after the deadline', () => {
    vi.useFakeTimers();
    let now = 0;
    const ticks: number[] = [];
    let expired = 0;
    const handle = startCountdown({
      deadline: 1_000,
      now: () => now,
      onTick: (r) => ticks.push(r),
      onExpire: () => expired++,
      intervalMs: 100,
    });
    expect(ticks).toEqual([1_000]);
    for (let i = 0; i < 20; i++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
    expect(expired).toBe(1);
    expect(ticks).toContain(0);
    // Expiry happened at deadline + delay, not before.
    const zeroTicks = ticks.filter((r) => r === 0).length;
    expect(zeroTicks).toBeGreaterThanOrEqual(Math.floor(TIMEOUT_SUBMIT_DELAY_MS / 100));
    handle.stop();
  });

  it('setDeadline moves the end (duel countdown); stop prevents expiry', () => {
    vi.useFakeTimers();
    let now = 0;
    let expired = 0;
    const handle = startCountdown({ deadline: 10_000, now: () => now, onTick: () => undefined, onExpire: () => expired++, intervalMs: 100 });
    handle.setDeadline(500);
    now = 900;
    vi.advanceTimersByTime(100);
    expect(expired).toBe(1);
    const other = startCountdown({ deadline: 100, now: () => now, onTick: () => undefined, onExpire: () => expired++, intervalMs: 100 });
    // Already past the deadline at start: expires immediately on the first tick.
    expect(expired).toBe(2);
    other.stop();
    const third = startCountdown({ deadline: 5_000, now: () => now, onTick: () => undefined, onExpire: () => expired++, intervalMs: 100 });
    third.stop();
    now = 10_000;
    vi.advanceTimersByTime(1_000);
    expect(expired).toBe(2);
  });

  it('last call fires once, before the deadline (the placed marker goes out while the server takes guesses)', () => {
    vi.useFakeTimers();
    let now = 0;
    const events: string[] = [];
    const handle = startCountdown({
      deadline: 2_000,
      now: () => now,
      onTick: () => undefined,
      onExpire: () => events.push(`expire@${now}`),
      onLastCall: () => events.push(`last@${now}`),
      intervalMs: 100,
    });
    for (let i = 0; i < 30; i++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
    expect(events).toEqual([`last@${2_000 - TIMEOUT_SUBMIT_LEAD_MS}`, `expire@${2_000 + TIMEOUT_SUBMIT_DELAY_MS}`]);
    handle.stop();
  });

  it('a deadline moved earlier (host ends the round) triggers the last call at once; later re-arms it', () => {
    vi.useFakeTimers();
    let now = 1_000;
    let calls = 0;
    const handle = startCountdown({ deadline: 60_000, now: () => now, onTick: () => undefined, onExpire: () => undefined, onLastCall: () => calls++, intervalMs: 100 });
    expect(calls).toBe(0);
    handle.setDeadline(1_200);
    expect(calls).toBe(1);
    handle.setDeadline(10_000);
    expect(calls).toBe(1);
    now = 9_800;
    vi.advanceTimersByTime(100);
    expect(calls).toBe(2);
    handle.stop();
  });
});
