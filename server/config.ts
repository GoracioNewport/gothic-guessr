/**
 * Server configuration from the environment (SPEC §10.2). `.env.local` in the project root is read first; real
 * environment variables win over it.
 *
 *   PORT / API_PORT   HTTP port (default 8787). Dev prefers API_PORT (the Vite proxy uses it), production PORT.
 *   HOST              bind address (dev default `localhost`, production: all interfaces)
 *   DATA_DIR          public dataset (worlds.json, <slug>/world.json, panos/…), default `public/data`
 *   SERVER_DATA_DIR   private manifests `<slug>/manifest.json`, default `server-data`
 *   DB_PATH           SQLite file, default `<SERVER_DATA_DIR>/db.sqlite`
 *   DIST_DIR          built client served in production, default `dist`
 *   ADMIN_PASSWORD    admin login (required)
 *   ADMIN_PATH        URL segment of the admin UI (`/<ADMIN_PATH>`) and API (`/api/<ADMIN_PATH>/*`),
 *                     [A-Za-z0-9_-]{4,64}. Required in production and must not be `admin` there (the admin is not
 *                     linked from anywhere, so an unguessable path keeps scanners off its login); dev and tests
 *                     default to `admin`
 *   SERVER_SECRET     HMAC key of the daily seeds and admin sessions (required)
 *   TRUST_PROXY=1     take the client IP from the LAST X-Forwarded-For entry (one reverse proxy that appends the peer)
 *   PUBLIC_ORIGIN     origin used in share texts (default: the request's origin)
 *   PUBLIC_CONTACT    optional contact shown in the legal notice (e-mail, URL or short text; GET /api/config); no default
 *   DEV=1|0           force dev/production (default: production when NODE_ENV=production)
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface Config {
  dev: boolean;
  port: number;
  host: string | undefined;
  root: string;
  dataDir: string;
  serverDataDir: string;
  dbPath: string;
  distDir: string;
  adminPassword: string;
  /** ADMIN_PATH: the admin UI lives at `/<adminPath>`, its API at `/api/<adminPath>` ({@link parseAdminPath}). */
  adminPath: string;
  serverSecret: string;
  trustProxy: boolean;
  publicOrigin: string | null;
  /** PUBLIC_CONTACT (trimmed, at most {@link MAX_CONTACT_LENGTH} chars) or null. Optional so test configs may omit it. */
  publicContact?: string | null;
}

export const MAX_CONTACT_LENGTH = 200;

/** PUBLIC_CONTACT → the value shown to players, or null when unset/blank. Throws on control characters or a too long value. */
export function parseContact(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  if (value.length > MAX_CONTACT_LENGTH) throw new Error(`config: PUBLIC_CONTACT is longer than ${MAX_CONTACT_LENGTH} chars`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('config: PUBLIC_CONTACT contains control characters');
  return value;
}

export const DEFAULT_PORT = 8787;

/** ADMIN_PATH of dev and tests when unset; refused in production. */
export const DEFAULT_ADMIN_PATH = 'admin';
export const ADMIN_PATH_RE = /^[A-Za-z0-9_-]{4,64}$/;
/** First path segments the app already uses (client routes, static dirs, `/api/<segment>` routes): never ADMIN_PATH. */
const RESERVED_ADMIN_PATHS = new Set([
  'api', 'assets', 'data', 'ui', 'ws', 'play', 'daily', 'players', 'games', 'challenges', 'hits', 'config', 'reports',
  'health', 'rooms',
]);

/**
 * ADMIN_PATH → the admin URL segment. Unset/blank: `admin` in dev, an error in production; a value outside
 * [A-Za-z0-9_-]{4,64}, one of the app's own segments, or `admin` in production are errors too.
 */
export function parseAdminPath(raw: string | undefined, dev: boolean): string {
  const value = (raw ?? '').trim();
  if (value === '') {
    if (dev) return DEFAULT_ADMIN_PATH;
    throw new Error('config: ADMIN_PATH is missing: production needs a secret admin path (deploy/scripts/secrets.sh or `npm run setup` writes a random one)');
  }
  if (!ADMIN_PATH_RE.test(value)) throw new Error('config: ADMIN_PATH must be 4-64 chars of A-Z a-z 0-9 _ -');
  if (RESERVED_ADMIN_PATHS.has(value.toLowerCase())) throw new Error('config: ADMIN_PATH collides with a route of the app');
  if (!dev && value.toLowerCase() === DEFAULT_ADMIN_PATH) {
    throw new Error('config: ADMIN_PATH must not be "admin" in production: pick an unguessable one (deploy/scripts/secrets.sh writes a random one)');
  }
  return value;
}

/** Parse a dotenv-style file: `KEY=value`, `# comments`, optional single/double quotes, `export ` prefix. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]!] = value;
  }
  return out;
}

/** `.env.local` of `root` as a map ({} when absent). */
export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
}

/** Environment = `.env.local` overlaid with `process.env`. */
export function loadEnv(root: string, env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return { ...readEnvFile(resolve(root, '.env.local')), ...env };
}

const flag = (v: string | undefined): boolean | undefined =>
  v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/** Build the config; throws when a required secret is missing. */
export function loadConfig(env: Record<string, string | undefined>, root: string): Config {
  const dev = flag(env.DEV) ?? env.NODE_ENV !== 'production';
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(root, p));
  const rawPort = dev ? (env.API_PORT ?? env.PORT) : (env.PORT ?? env.API_PORT);
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`config: bad port ${rawPort}`);
  const serverDataDir = abs(env.SERVER_DATA_DIR || 'server-data');
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  const serverSecret = env.SERVER_SECRET ?? '';
  if (adminPassword.length < 8) throw new Error('config: ADMIN_PASSWORD is missing or shorter than 8 chars (run `npm run setup`)');
  if (serverSecret.length < 16) throw new Error('config: SERVER_SECRET is missing or shorter than 16 chars (run `npm run setup`)');
  const adminPath = parseAdminPath(env.ADMIN_PATH, dev);
  return {
    dev,
    port,
    host: env.HOST || (dev ? 'localhost' : undefined),
    root,
    dataDir: abs(env.DATA_DIR || 'public/data'),
    serverDataDir,
    dbPath: env.DB_PATH ? abs(env.DB_PATH) : resolve(serverDataDir, 'db.sqlite'),
    distDir: abs(env.DIST_DIR || 'dist'),
    adminPassword,
    adminPath,
    serverSecret,
    trustProxy: flag(env.TRUST_PROXY) ?? false,
    publicOrigin: env.PUBLIC_ORIGIN ? env.PUBLIC_ORIGIN.replace(/\/+$/, '') : null,
    publicContact: parseContact(env.PUBLIC_CONTACT),
  };
}
