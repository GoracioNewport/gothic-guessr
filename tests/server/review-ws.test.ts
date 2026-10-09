/**
 * Security review (stage 3): WebSocket abuse against a real server on port 0 (in-memory DB, fixture worlds).
 *
 * CONFIRMED issue (fails until fixed): the hub accepts any number of sockets per player (and per IP), and both the
 * 20-messages-per-5-s limit and "a socket is in at most one room" are per socket, so one token multiplies its message
 * budget and sits connected in many rooms at once. The passing checks pin down what already holds (frame size cap).
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { CreateRoomResponse, PublicSettings, RoomView, ServerMessage } from '../../shared/api';
import { createRoomsPlugin } from '../../server/rooms';
import type { ServerPlugin } from '../../server/plugins';
import { harness } from './helpers';
import type { Harness } from './helpers';

let h: Harness;
let plugin: ServerPlugin;
let server: ServerType;
let base: string;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  plugin = createRoomsPlugin({ heartbeatMs: 60_000, registerAdmin: false });
  h = harness({ app: { plugins: [plugin] } });
  server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  plugin.attach!(server, h.services);
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await plugin.close?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  h.close();
});

async function api<T>(method: string, path: string, token: string | null, body?: unknown, ip = '10.50.0.1'): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function newPlayer(ip: string): Promise<string> {
  const res = await api<{ token: string }>('POST', '/api/players', null, undefined, ip);
  expect(res.status).toBe(201);
  return res.body.token;
}

function open(token: string): Promise<{ ws: WebSocket; inbox: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    const inbox: ServerMessage[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString()) as ServerMessage));
    ws.once('open', () => resolve({ ws, inbox }));
    ws.once('error', reject);
  });
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const PARTY: PublicSettings = { mode: 'classic', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 3 };

describe('review: WebSocket hub', () => {
  it('caps sockets per player, so the per-socket message limit cannot be multiplied', async () => {
    const token = await newPlayer('10.50.1.1');
    const conns = await Promise.all(Array.from({ length: 10 }, () => open(token)));
    for (const { ws } of conns) for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ t: 'ping' }));
    await settle(300);
    const pongs = conns.reduce((n, c) => n + c.inbox.filter((m) => m.t === 'pong').length, 0);
    // Today: 10 sockets accepted for one token and all 200 pings answered within 5 s (limit: 20 per socket).
    expect(pongs).toBeLessThanOrEqual(20);
  });

  it('keeps one player connected in at most one room', async () => {
    const hostTokens = await Promise.all([1, 2, 3].map((i) => newPlayer(`10.50.2.${i}`)));
    const codes: string[] = [];
    for (const t of hostTokens) {
      const res = await api<CreateRoomResponse>('POST', '/api/rooms', t, { type: 'party', settings: PARTY });
      expect(res.status).toBe(201);
      codes.push(res.body.code);
    }
    const lurker = await newPlayer('10.50.2.9');
    const conns = await Promise.all(codes.map(() => open(lurker)));
    conns.forEach(({ ws }, i) => ws.send(JSON.stringify({ t: 'join', code: codes[i] })));
    await settle();
    let connectedIn = 0;
    for (const code of codes) {
      const view = (await api<RoomView>('GET', `/api/rooms/${code}`, null)).body;
      if (view.players.some((p) => p.connected && p.host === false)) connectedIn++;
    }
    // Today: the same token is a connected member of all three lobbies at once.
    expect(connectedIn).toBeLessThanOrEqual(1);
  });

  it('closes a socket that sends a frame above 4 KB (passes today)', async () => {
    const token = await newPlayer('10.50.3.1');
    const { ws } = await open(token);
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send(JSON.stringify({ t: 'settings', settings: { pad: 'x'.repeat(10_000) } }));
    expect(await closed).toBe(1009);
  });
});
