/**
 * Rooms (party and duel, SPEC §10.6) — the module the menu and the app call. The implementation lives in
 * src/ui/roompage.ts (page controller), src/ui/lobby.ts (lobby), src/ui/roomhud.ts (HUD, tables, standings),
 * src/ui/roomstate.ts (pure reducer and rules) and src/net/ws.ts (the reconnecting socket).
 *
 * - `create(ctx, type = 'party')`: `POST /api/rooms {type, settings}` with the last solo settings (party: 2 min per
 *   round, duel: no limit), then `/r/<CODE>`; the host changes the type and the settings in the lobby. The menu's
 *   single "Create room" button creates a normal room (party).
 * - `page(ctx, code)`: the room page for `/r/<CODE>`; its `destroy()` closes the socket (a disconnect, not a leave).
 *
 * A game view with `roomCode` (reload during a room game) is routed here by the game flow.
 */
import type { RoomType } from '../../shared/api';
import { createRoom, roomPage } from '../ui/roompage';
import type { AppContext, Page } from './context';

export interface RoomsModule {
  /** Create a room of `type` (default: a normal room) and open its page. */
  create(ctx: AppContext, type?: RoomType): Promise<void>;
  /** The page of room `code` (`/r/<CODE>`). */
  page(ctx: AppContext, code: string): Page;
}

export const rooms: RoomsModule = {
  create: (ctx, type = 'party') => createRoom(ctx, type),
  page: (ctx, code) => roomPage(ctx, code),
};
