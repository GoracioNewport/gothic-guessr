import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../shared/api';
import {
  CLOSE_AUTH,
  CLOSE_BANNED,
  PING_INTERVAL_MS,
  RECONNECT_DELAYS_MS,
  RoomConnection,
  SILENCE_TIMEOUT_MS,
  defaultSocketUrl,
  parseServerMessage,
  reconnectDelay,
  socketUrl,
} from '../src/net/ws';
import type { RoomConnectionOptions, SocketLike } from '../src/net/ws';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed: number | null = null;

  constructor(readonly url: string) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
}

function setup(extra: Partial<RoomConnectionOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const messages: ServerMessage[] = [];
  const statuses: string[] = [];
  const stopped: string[] = [];
  let token: string | null = 'tok/1';
  const conn = new RoomConnection({
    url: 'ws://test/ws',
    token: () => token,
    onOpen: () => conn.send({ t: 'join', code: 'ABCDE' }),
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    onStopped: (r) => stopped.push(r),
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    random: () => 0,
    eventTarget: null,
    ...extra,
  });
  return { conn, sockets, messages, statuses, stopped, setToken: (t: string | null) => (token = t) };
}

describe('ws helpers', () => {
  it('builds URLs', () => {
    expect(defaultSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
    expect(defaultSocketUrl({ protocol: 'https:', host: 'g2.example' })).toBe('wss://g2.example/ws');
    expect(socketUrl('ws://h/ws', 'a b/c')).toBe('ws://h/ws?token=a%20b%2Fc');
    expect(socketUrl('ws://h/ws?x=1', 't')).toBe('ws://h/ws?x=1&token=t');
  });

  it('backs off exponentially with bounded jitter', () => {
    expect(reconnectDelay(1, () => 0)).toBe(500);
    expect(reconnectDelay(2, () => 0)).toBe(1000);
    expect(reconnectDelay(5, () => 0)).toBe(8000);
    expect(reconnectDelay(50, () => 0)).toBe(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]);
    expect(reconnectDelay(1, () => 0.999)).toBeLessThanOrEqual(625);
    expect(reconnectDelay(0, () => 0)).toBe(500);
  });

  it('parses only known server messages', () => {
    expect(parseServerMessage('{"t":"kicked"}')).toEqual({ t: 'kicked' });
    expect(parseServerMessage('{"t":"nope"}')).toBeNull();
    expect(parseServerMessage('[1]')).toBeNull();
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });
});

describe('RoomConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('joins on open and delivers messages (pong is swallowed, junk ignored)', () => {
    const { conn, sockets, messages, statuses } = setup();
    conn.start();
    conn.start(); // idempotent
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('ws://test/ws?token=tok%2F1');
    expect(conn.send({ t: 'ping' })).toBe(false); // not open yet
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([{ t: 'join', code: 'ABCDE' }]);
    sockets[0]!.receive({ t: 'guessed', playerId: 'p' });
    sockets[0]!.receive({ t: 'pong' });
    sockets[0]!.receive('garbage');
    expect(messages).toEqual([{ t: 'guessed', playerId: 'p' }]);
    expect(statuses).toEqual(['connecting', 'open']);
    expect(conn.status).toBe('open');
  });

  it('reconnects with backoff after a drop and rejoins', () => {
    const { conn, sockets, statuses } = setup();
    conn.start();
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(conn.status).toBe('reconnecting');
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop(); // the server is still away
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    expect(sockets[2]!.sent).toEqual([{ t: 'join', code: 'ABCDE' }]);
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    // Backoff resets after a successful open.
    sockets[2]!.drop();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(4);
  });

  it('reconnectNow skips the wait', () => {
    const { conn, sockets } = setup();
    conn.start();
    sockets[0]!.open();
    sockets[0]!.drop();
    conn.reconnectNow();
    expect(sockets).toHaveLength(2);
    conn.reconnectNow(); // already connecting
    expect(sockets).toHaveLength(2);
  });

  it('pings while open and replaces a silent socket', () => {
    const { conn, sockets } = setup();
    conn.start();
    sockets[0]!.open();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(sockets[0]!.sent).toContainEqual({ t: 'ping' });
    sockets[0]!.receive({ t: 'pong' });
    // Nothing more arrives: after the silence timeout the socket is dropped and a new one opens.
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS + PING_INTERVAL_MS);
    expect(sockets[0]!.closed).not.toBeNull();
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]!);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it('stops for good on 4403 banned', () => {
    const { conn, sockets, stopped } = setup();
    conn.start();
    sockets[0]!.open();
    sockets[0]!.drop(CLOSE_BANNED);
    expect(conn.status).toBe('stopped');
    expect(stopped).toEqual(['banned']);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('on 4401 asks for a fresh token once, then gives up', async () => {
    const onAuthFailure = vi.fn(async () => true);
    const { conn, sockets, stopped, setToken } = setup({ onAuthFailure });
    conn.start();
    sockets[0]!.drop(CLOSE_AUTH);
    setToken('tok2');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]!.url).toContain('token=tok2');
    sockets[1]!.drop(CLOSE_AUTH); // still refused
    await vi.waitFor(() => expect(stopped).toEqual(['auth']));
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(conn.status).toBe('stopped');
  });

  it('without a token it does not connect', async () => {
    const { conn, sockets, stopped } = setup({ token: () => null });
    conn.start();
    await vi.waitFor(() => expect(stopped).toEqual(['auth']));
    expect(sockets).toHaveLength(0);
  });

  it('stop closes the socket and cancels retries; restart opens again', () => {
    const { conn, sockets, stopped } = setup();
    conn.start();
    sockets[0]!.open();
    sockets[0]!.drop();
    conn.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(stopped).toEqual([]); // a caller's stop is not reported
    conn.restart();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    conn.stop();
    expect(sockets[1]!.closed).toBe(1000);
    // A late close event of the stopped socket does not schedule anything.
    sockets[1]!.drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it('reacts to the browser coming back online', () => {
    const target = new EventTarget();
    const { conn, sockets } = setup({ eventTarget: target });
    conn.start();
    sockets[0]!.open();
    sockets[0]!.drop();
    target.dispatchEvent(new Event('online'));
    expect(sockets).toHaveLength(2);
    conn.stop();
    target.dispatchEvent(new Event('online'));
    expect(sockets).toHaveLength(2);
  });
});
