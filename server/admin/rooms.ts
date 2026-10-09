/**
 * What the admin needs from the live room registry (server/rooms/, SPEC §10.6, §10.10): counts for the dashboard,
 * the list of active rooms and "close a room". The rooms module owns the registry; it hands the admin an
 * implementation of {@link AdminRoomsSource} through {@link registerAdminRoomsSource} (or the admin plugin is built
 * with `adminPlugin({ rooms })`). Without one the admin shows zeros and an empty list with `available: false`.
 */
import type { AdminRoom } from '../../shared/api';

export interface AdminRoomsSource {
  /** Open WebSocket connections and rooms currently in the registry. */
  liveCounts(): { sockets: number; rooms: number };
  /** Active rooms, any order (the admin sorts by last activity). */
  listRooms(): AdminRoom[];
  /**
   * Close a room: every member gets `{t:'error', error:'room_closed'}`, sockets leave it, the registry forgets it and
   * any running room game is finished. Resolves false when the code is unknown.
   */
  closeRoom(code: string): boolean | Promise<boolean>;
}

let registered: AdminRoomsSource | null = null;

/** Called by the rooms module when its registry exists (pass null on shutdown). */
export function registerAdminRoomsSource(source: AdminRoomsSource | null): void {
  registered = source;
}

/** The registered source, if any. */
export function registeredAdminRoomsSource(): AdminRoomsSource | null {
  return registered;
}
