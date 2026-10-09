/**
 * Admin × the real rooms module (server/rooms/): live counts, the room list, closing a room, banned players refused,
 * and rooms_log feeding the "rooms created" statistic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminRoomsView, AdminStats, ApiError, PublicSettings, RoomView } from '../../shared/api';
import { adminPlugin } from '../../server/admin/plugin';
import { SESSION_COOKIE } from '../../server/admin/session';
import { createRoomsPlugin, roomsAdminSource } from '../../server/rooms';
import { Client, harness } from './helpers';
import type { Harness } from './helpers';

const SETTINGS: PublicSettings = { mode: 'mixed', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 5 };

const API = '/api/ops-rooms-4';

let h: Harness;
let cookie = '';
const rooms = createRoomsPlugin({ registerAdmin: false });

beforeEach(async () => {
  h = harness({ config: { adminPath: 'ops-rooms-4' }, app: { plugins: [rooms, adminPlugin({ rooms: () => roomsAdminSource(h.services) })] } });
  const res = await h.app.request(`${API}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' },
    body: JSON.stringify({ password: 'test-admin-password' }),
  });
  cookie = `${SESSION_COOKIE}=${/g2g_admin=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')![1]}`;
});
afterEach(async () => {
  await rooms.close?.();
  h.close();
});

async function admin<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await h.app.request(path, {
    method,
    headers: { cookie, host: 'guessr.test', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

describe('admin with the rooms registry', () => {
  it('lists a live room, counts it on the dashboard, and closes it', async () => {
    const host = new Client(h.app, '10.2.2.2');
    const hostId = await host.register();
    await host.call('PATCH', '/api/me', { nickname: 'Xardas' });
    const created = await host.call<{ code: string }>('POST', '/api/rooms', { type: 'party', settings: SETTINGS });
    expect(created.status).toBe(201);
    const code = created.body.code;

    const list = await admin<AdminRoomsView>('GET', `${API}/rooms`);
    expect(list.body.available).toBe(true);
    expect(list.body.rooms).toHaveLength(1);
    expect(list.body.rooms[0]).toMatchObject({ code, type: 'party', phase: 'lobby' });
    expect(list.body.rooms[0]!.players.map((p) => p.id)).toContain(hostId);

    const stats = await admin<AdminStats>('GET', `${API}/stats`);
    expect(stats.body.live).toMatchObject({ rooms: 1, sockets: 0 });
    expect(stats.body.totals.roomsCreated).toBe(1);

    const closed = await admin<AdminRoomsView>('POST', `${API}/rooms/${code}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.rooms).toEqual([]);
    expect((await host.call<RoomView>('GET', `/api/rooms/${code}`)).status).toBe(404);
    expect((await admin<ApiError>('POST', `${API}/rooms/${code}/close`)).status).toBe(404);
  });

  it('a player banned in the admin cannot create rooms', async () => {
    const p = new Client(h.app, '10.3.3.3');
    const id = await p.register();
    expect((await admin('POST', `${API}/players/${id}/ban`, { banned: true })).status).toBe(200);
    const res = await p.call<ApiError>('POST', '/api/rooms', { type: 'duel', settings: SETTINGS });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('banned');
  });
});
