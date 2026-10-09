/**
 * Mount points for the modules that plug into the backend core: rooms (server/rooms/, routes/rooms.ts, the WebSocket
 * hub at /ws) and admin (routes/admin.ts, server/admin/). Each exports a {@link ServerPlugin}; add it to
 * {@link PLUGINS} below. app.ts mounts `routes` under `/api`, main.ts calls `attach` with the HTTP server after
 * listening (WebSocket `upgrade` handling) and `close` on shutdown. Tests build apps with their own plugin lists.
 */
import type { ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AppEnv } from './http';
import type { Services } from './services';
import { adminPlugin } from './admin/plugin';
import { createRoomsPlugin } from './rooms';

export interface ServerPlugin {
  name: string;
  /** Register routes on the `/api` sub-app (paths relative to `/api`, e.g. `api.post('/rooms', …)`). */
  routes?(api: Hono<AppEnv>, services: Services): void;
  /** Hook into the HTTP server once it listens, e.g. `server.on('upgrade', …)` for `/ws`. */
  attach?(server: ServerType, services: Services): void;
  /** Release timers/sockets on shutdown. */
  close?(): void | Promise<void>;
}

/** Plugins of the production/dev server, in mount order. Rooms and admin: register yours here. */
export const PLUGINS: ServerPlugin[] = [createRoomsPlugin(), adminPlugin()];
