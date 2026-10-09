/**
 * Per-server admin state (one per {@link Services} object, so tests with several apps stay isolated): the session
 * signer, the SQL store and the live rooms source.
 */
import type { Services } from '../services';
import { registeredAdminRoomsSource } from './rooms';
import type { AdminRoomsSource } from './rooms';
import { AdminSessions } from './session';
import { AdminStore } from './store';

export interface AdminState {
  sessions: AdminSessions;
  store: AdminStore;
  /** The live room registry, or null when the rooms module is not running. */
  rooms(): AdminRoomsSource | null;
}

export interface AdminOptions {
  /** Room registry for this server; default: whatever the rooms module registered via registerAdminRoomsSource. */
  rooms?: AdminRoomsSource | (() => AdminRoomsSource | null);
}

const states = new WeakMap<Services, AdminState>();
const options = new WeakMap<Services, AdminOptions>();

/** Bind plugin options to a services container (called when the plugin mounts its routes). */
export function configureAdmin(services: Services, opts: AdminOptions): void {
  options.set(services, opts);
  states.delete(services);
}

export function adminState(services: Services): AdminState {
  let st = states.get(services);
  if (!st) {
    const opts = options.get(services) ?? {};
    const rooms = opts.rooms;
    st = {
      sessions: new AdminSessions(services.config.serverSecret, services.config.adminPassword, services.clock),
      store: new AdminStore(services.repo.db),
      rooms: () => (typeof rooms === 'function' ? rooms() : (rooms ?? registeredAdminRoomsSource())),
    };
    states.set(services, st);
  }
  return st;
}
