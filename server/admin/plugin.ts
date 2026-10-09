/**
 * The admin {@link ServerPlugin} (SPEC §10.9, §10.10): mounts server/routes/admin.ts at `/api/<ADMIN_PATH>`
 * (config.adminPath; any other `/api/admin…` falls through to the API's 404). Listed in PLUGINS (server/plugins.ts);
 * tests build it with their own rooms source: `adminPlugin({ rooms })`.
 */
import type { ServerPlugin } from '../plugins';
import { adminRoutes } from '../routes/admin';
import { configureAdmin } from './state';
import type { AdminOptions } from './state';

export function adminPlugin(opts: AdminOptions = {}): ServerPlugin {
  return {
    name: 'admin',
    routes(api, services) {
      configureAdmin(services, opts);
      api.route(`/${services.config.adminPath}`, adminRoutes());
    },
  };
}
