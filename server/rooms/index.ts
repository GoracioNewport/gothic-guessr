/**
 * Rooms module (SPEC §10.6) as a {@link ServerPlugin}: REST routes (routes/rooms.ts), the WebSocket hub at `/ws`
 * (hub.ts) and the live room registry (registry.ts), one registry per {@link Services} instance.
 *
 * ─── For the admin (SPEC §10.10) ──────────────────────────────────────────────────────────────────────────────────────
 *   roomsAdminSource(services) → AdminRoomsSource (server/admin/rooms.ts):
 *     liveCounts()     {sockets: open WebSockets, rooms: rooms in memory}
 *     listRooms()      AdminRoom[] (code, type, phase, players with connection state, createdAt, lastActivityAt)
 *     closeRoom(code)  members get `{t:'error', error:'room_closed'}`, sockets leave the room, a running room game is
 *                      finished (its challenge link opens), the registry forgets the room; false for an unknown code.
 *   The plugin also registers that source with `registerAdminRoomsSource` once it is attached to the HTTP server
 *   (and unregisters it on close), so the admin plugin finds it without a reference.
 *   roomRegistryOf(services) → the RoomRegistry itself (`list()`, `close(code)`, `size`, `playing`).
 */
import { registerAdminRoomsSource } from '../admin/rooms';
import { clientKey } from '../core/ip';
import type { ServerPlugin } from '../plugins';
import { roomsRoutes } from '../routes/rooms';
import type { Services } from '../services';
import { RoomHub } from './hub';
import { roomsAdminSource, runtimeOf, runtimes } from './runtime';

export { roomRegistryOf, roomsAdminSource } from './runtime';
export { RoomRegistry } from './registry';
export { RoomHub } from './hub';

export interface RoomsPluginOptions {
  /** Register the admin source globally on attach (default true). */
  registerAdmin?: boolean;
  /** Heartbeat interval of the hub (tests). */
  heartbeatMs?: number;
}

export function createRoomsPlugin(opts: RoomsPluginOptions = {}): ServerPlugin {
  const used = new Set<Services>();
  let registered = false;
  return {
    name: 'rooms',
    routes(api, services) {
      used.add(services);
      runtimeOf(services);
      api.route('/', roomsRoutes());
    },
    attach(server, services) {
      used.add(services);
      const rt = runtimeOf(services);
      rt.hub ??= new RoomHub({
        registry: rt.registry,
        players: services.players,
        repo: services.repo,
        clock: services.clock,
        limits: services.limits,
        clientKey: (req) => {
          const xff = req.headers['x-forwarded-for'];
          return clientKey(Array.isArray(xff) ? xff.join(',') : xff, req.socket.remoteAddress, services.config.trustProxy);
        },
        heartbeatMs: opts.heartbeatMs,
      });
      rt.hub.attach(server as unknown as Parameters<RoomHub['attach']>[0]);
      if (opts.registerAdmin ?? true) {
        registerAdminRoomsSource(roomsAdminSource(services));
        registered = true;
      }
    },
    async close() {
      for (const services of used) {
        const rt = runtimes.get(services);
        if (!rt) continue;
        await rt.registry.shutdown();
        rt.hub?.close();
        rt.hub = null;
        runtimes.delete(services);
      }
      used.clear();
      if (registered) registerAdminRoomsSource(null);
      registered = false;
    },
  };
}
