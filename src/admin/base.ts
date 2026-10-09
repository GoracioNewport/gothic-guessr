/**
 * Where the admin lives: the server's ADMIN_PATH (server/config.ts). The admin SPA is served at `/<ADMIN_PATH>/…` and
 * talks to `/api/<ADMIN_PATH>/…`; nothing in the bundle knows the path, the shell gets it injected
 * (`<meta name="g2-admin-path" content="%ADMIN_PATH%">`: server/app.ts shellHtml in production, vite.config.ts in
 * dev). Without a filled meta (a plain `vite preview` of dist/) the first segment of the page's own URL is used: the
 * shell is only ever served under the admin path.
 */

const SEGMENT = /^[A-Za-z0-9_-]{4,64}$/;

function readAdminPath(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="g2-admin-path"]')?.content ?? '';
  if (SEGMENT.test(meta)) return meta;
  const first = location.pathname.split('/')[1] ?? '';
  return SEGMENT.test(first) ? first : 'admin';
}

/** The ADMIN_PATH segment, e.g. `admin` in dev. */
export const ADMIN_PATH = readAdminPath();

/** `/<ADMIN_PATH>` + `sub` (`''`, `/players/<id>`, `?from=…`): an in-app URL of the admin SPA. */
export function adminUrl(sub = ''): string {
  return `/${ADMIN_PATH}${sub}`;
}

/** `/api/<ADMIN_PATH>`: the admin API base (routes/admin.ts). */
export const ADMIN_API = `/api/${ADMIN_PATH}`;

/** Is `pathname` inside the admin SPA (`/<ADMIN_PATH>` or below)? */
export function isAdminPath(pathname: string): boolean {
  return pathname === `/${ADMIN_PATH}` || pathname.startsWith(`/${ADMIN_PATH}/`);
}
