/**
 * Per-{@link Services} runtime of the rooms module: the live registry (created on first use) and, once the plugin is
 * attached to an HTTP server, the WebSocket hub. See server/rooms/index.ts for what the admin uses.
 */
import type { AdminRoomsSource } from '../admin/rooms';
import type { Services } from '../services';
import type { RoomHub } from './hub';
import { RoomRegistry } from './registry';

export interface Runtime {
  registry: RoomRegistry;
  hub: RoomHub | null;
}

export const runtimes = new WeakMap<Services, Runtime>();

export function runtimeOf(services: Services): Runtime {
  let rt = runtimes.get(services);
  if (!rt) {
    rt = {
      registry: new RoomRegistry({ games: services.games, repo: services.repo, clock: services.clock }),
      hub: null,
    };
    runtimes.set(services, rt);
  }
  return rt;
}

/** The live room registry of a service container (created on first use). */
export function roomRegistryOf(services: Services): RoomRegistry {
  return runtimeOf(services).registry;
}

/** What the admin reads and does with live rooms (see the header). */
export function roomsAdminSource(services: Services): AdminRoomsSource {
  const rt = runtimeOf(services);
  return {
    liveCounts: () => ({ sockets: rt.hub?.socketCount ?? 0, rooms: rt.registry.size }),
    listRooms: () => rt.registry.list(),
    closeRoom: (code) => rt.registry.close(code),
  };
}
