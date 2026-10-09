/**
 * Test harness: in-memory SQLite, the fixture worlds, a controllable clock, and the Hono app.
 */
import type { Config } from '../../server/config';
import { createApp } from '../../server/app';
import type { AppOptions } from '../../server/app';
import { RateLimits } from '../../server/core/ratelimit';
import { openDatabase } from '../../server/db/database';
import { SqliteRepository } from '../../server/db/repository';
import { createServices } from '../../server/services';
import type { Services } from '../../server/services';
import type { WorldRegistry } from '../../server/core/worlds';
import { fixtureRegistry } from './fixtures/world';

/** 2026-10-07T12:00:00Z */
export const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

export class FakeClock {
  constructor(public now = T0) {}
  readonly fn = (): number => this.now;
  advance(ms: number): number {
    this.now += ms;
    return this.now;
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    dev: true,
    port: 0,
    host: '127.0.0.1',
    root: '/nonexistent',
    dataDir: '/nonexistent/data',
    serverDataDir: '/nonexistent/server-data',
    dbPath: ':memory:',
    distDir: '/nonexistent/dist',
    adminPassword: 'test-admin-password',
    adminPath: 'admin',
    serverSecret: 'test-server-secret-0123456789',
    trustProxy: true,
    publicOrigin: null,
    ...overrides,
  };
}

export interface Harness {
  services: Services;
  clock: FakeClock;
  app: ReturnType<typeof createApp>;
  close(): void;
}

export function harness(opts: { config?: Partial<Config>; worlds?: WorldRegistry; app?: AppOptions; limits?: RateLimits } = {}): Harness {
  const clock = new FakeClock();
  const db = openDatabase(':memory:');
  const services = createServices({
    config: testConfig(opts.config),
    repo: new SqliteRepository(db),
    worlds: opts.worlds ?? fixtureRegistry(),
    clock: clock.fn,
    limits: opts.limits,
  });
  const app = createApp(services, opts.app ?? {});
  return { services, clock, app, close: () => db.close() };
}

/** A tiny fetch wrapper over `app.request` with JSON and a bearer token. */
export class Client {
  token: string | null = null;
  constructor(
    private readonly app: Harness['app'],
    private readonly ip = '10.0.0.1',
  ) {}

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip, host: 'guessr.test' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  async register(): Promise<string> {
    const res = await this.call<{ token: string; player: { id: string } }>('POST', '/api/players');
    if (res.status !== 201) throw new Error(`register: ${res.status} ${JSON.stringify(res.body)}`);
    this.token = res.body.token;
    return res.body.player.id;
  }
}
