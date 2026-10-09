/**
 * Shared e2e fixtures and helpers.
 *
 * - `players.create()` opens a browser context per player (1280×720, its own X-Forwarded-For address so per-IP limits
 *   stay per player, optional UI language) and records every `/api` and `/data` response body and every WebSocket
 *   frame of that context. The records go to `$E2E_RUN_DIR/records/` when the test ends; leak.e2e.ts crawls them.
 * - Answers: the test process (never the browser) reads the private manifests in `server-data/` to know where a
 *   round's start node is, so a duel can be won by a perfect guess and scores can be predicted.
 * - Round helpers drive the real UI: the map widget (hover to expand, world tab, click), Guess, Next.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page, Response, WebSocket } from '@playwright/test';
import type { GameView, Lang, WorldGuess } from '../shared/api';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const RUN_DIR = process.env.E2E_RUN_DIR ?? join(ROOT, 'e2e', '.output', 'run');
export const RECORDS_DIR = join(RUN_DIR, 'records');

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

/** One recorded body: an HTTP response under /api or /data, or a WebSocket frame. */
export interface RecordEntry {
  /** Wall-clock ms when the response headers / the frame arrived. */
  at: number;
  /** Order of arrival within the player (ties on `at`). */
  seq: number;
  player: string;
  kind: 'http' | 'ws-in' | 'ws-out';
  method?: string;
  url: string;
  status?: number;
  contentType?: string;
  /** Text bodies only (JSON, text); binary bodies (tiles) are recorded with `body: null`. */
  body: string | null;
}

class Recorder {
  readonly entries: RecordEntry[] = [];
  private seq = 0;
  private readonly pending: Promise<void>[] = [];

  constructor(private readonly player: string) {}

  attach(context: BrowserContext): void {
    context.on('response', (res) => this.pending.push(this.onResponse(res)));
    const onPage = (page: Page): void => {
      page.on('websocket', (ws) => this.onSocket(ws));
    };
    for (const page of context.pages()) onPage(page);
    context.on('page', onPage);
  }

  private async onResponse(res: Response): Promise<void> {
    const url = new URL(res.url());
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/data/')) return;
    const entry: RecordEntry = {
      at: Date.now(),
      seq: this.seq++,
      player: this.player,
      kind: 'http',
      method: res.request().method(),
      url: url.pathname + url.search,
      status: res.status(),
      contentType: res.headers()['content-type'] ?? '',
      body: null,
    };
    this.entries.push(entry);
    if (!/json|text|javascript/i.test(entry.contentType ?? '')) return;
    try {
      entry.body = await res.text();
    } catch {
      entry.body = null; // the page navigated away before the body was read
    }
  }

  private onSocket(ws: WebSocket): void {
    const url = new URL(ws.url());
    const path = url.pathname; // the query holds the token: not recorded
    ws.on('framereceived', (f) => {
      this.entries.push({ at: Date.now(), seq: this.seq++, player: this.player, kind: 'ws-in', url: path, body: typeof f.payload === 'string' ? f.payload : null });
    });
    ws.on('framesent', (f) => {
      this.entries.push({ at: Date.now(), seq: this.seq++, player: this.player, kind: 'ws-out', url: path, body: typeof f.payload === 'string' ? f.payload : null });
    });
  }

  async flush(testId: string): Promise<void> {
    await Promise.allSettled(this.pending);
    mkdirSync(RECORDS_DIR, { recursive: true });
    writeFileSync(join(RECORDS_DIR, `${testId}-${this.player}-${randomUUID().slice(0, 8)}.json`), JSON.stringify(this.entries));
  }
}

/** Every record written so far in this run. */
export function readAllRecords(): RecordEntry[] {
  let files: string[] = [];
  try {
    files = readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap((f) => JSON.parse(readFileSync(join(RECORDS_DIR, f), 'utf8')) as RecordEntry[]);
}

// ---------------------------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------------------------

export interface PlayerOptions {
  /** Label used in records and failure messages. */
  name: string;
  /** UI language stored before the first page load (default: navigator language = English). */
  lang?: Lang;
  /** Grant clipboard access (copy buttons). */
  clipboard?: boolean;
}

export interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
  /** The client IP this player presents (X-Forwarded-For). */
  ip: string;
  /**
   * A same-origin API call from the page with the player's token (waits up to 10 s for the app to create it);
   * `anonymous` sends no token and does not wait.
   */
  api<T = unknown>(method: string, path: string, body?: unknown, opts?: { anonymous?: boolean }): Promise<{ status: number; body: T }>;
  token(): Promise<string | null>;
  /** Open a fresh tab in the same context (same token), e.g. to come back after closing the page. */
  reopen(): Promise<Page>;
}

function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${Math.max(1, b[2]!)}`;
}

export class PlayerFactory {
  private readonly recorders: Recorder[] = [];
  private readonly contexts: BrowserContext[] = [];

  constructor(private readonly browser: Browser) {}

  async create(opts: PlayerOptions): Promise<Player> {
    const ip = randomIp();
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      extraHTTPHeaders: { 'X-Forwarded-For': ip },
      permissions: opts.clipboard ? ['clipboard-read', 'clipboard-write'] : [],
    });
    if (opts.lang) {
      await context.addInitScript((lang) => {
        try {
          if (!localStorage.getItem('gothic2guessr.lang')) localStorage.setItem('gothic2guessr.lang', lang);
        } catch {
          /* ignore */
        }
      }, opts.lang);
    }
    const recorder = new Recorder(opts.name);
    recorder.attach(context);
    this.recorders.push(recorder);
    this.contexts.push(context);
    const errors: string[] = [];
    const watch = (page: Page): void => {
      page.on('pageerror', (err) => errors.push(err.message));
    };
    context.on('page', watch);
    const page = await context.newPage();
    const player: Player = {
      name: opts.name,
      context,
      ip,
      page,
      async api<T>(method: string, path: string, body?: unknown, opts: { anonymous?: boolean } = {}) {
        return player.page.evaluate(
          async ({ method, path, body, anonymous }) => {
            // The app creates the player on its first call; wait for its token (up to 10 s).
            let token = anonymous ? null : localStorage.getItem('gothic2guessr.token');
            for (let i = 0; !anonymous && !token && i < 100; i++) {
              await new Promise((r) => setTimeout(r, 100));
              token = localStorage.getItem('gothic2guessr.token');
            }
            const headers: Record<string, string> = {};
            if (token) headers.Authorization = `Bearer ${token}`;
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
            const text = await res.text();
            return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
          },
          { method, path, body, anonymous: opts.anonymous === true },
        );
      },
      token: () => player.page.evaluate(() => localStorage.getItem('gothic2guessr.token')),
      async reopen() {
        player.page = await context.newPage();
        return player.page;
      },
    };
    return player;
  }

  async close(testId: string): Promise<void> {
    for (const c of this.contexts) await c.close().catch(() => undefined);
    for (const r of this.recorders) await r.flush(testId);
  }
}

export const test = base.extend<{ players: PlayerFactory }>({
  players: async ({ browser }, use, testInfo) => {
    const factory = new PlayerFactory(browser);
    await use(factory);
    await factory.close(testInfo.testId);
  },
});

export { expect };

// ---------------------------------------------------------------------------------------------
// Answers from the private manifests (test process only)
// ---------------------------------------------------------------------------------------------

interface PrivateNode {
  key: string;
  wp: string;
  x: number;
  z: number;
}

let answerIndex: Map<string, WorldGuess & { wp: string }> | null = null;

export const WORLDS = ['khorinis', 'valley', 'jharkendar'] as const;

export function privateNodes(): Map<string, WorldGuess & { wp: string }> {
  if (answerIndex) return answerIndex;
  const index = new Map<string, WorldGuess & { wp: string }>();
  for (const world of WORLDS) {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'server-data', world, 'manifest.json'), 'utf8')) as { nodes: PrivateNode[] };
    for (const n of manifest.nodes) index.set(n.key, { world, x: n.x, z: n.z, wp: n.wp });
  }
  answerIndex = index;
  return index;
}

/** The exact location of a node key (a perfect guess). */
export function answerOf(key: string): WorldGuess {
  const node = privateNodes().get(key);
  if (!node) throw new Error(`unknown node key ${key}`);
  return { world: node.world, x: node.x, z: node.z };
}

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

/** Wait until a round screen with its panorama canvas is up. */
export async function waitForRound(page: Page): Promise<void> {
  await expect(page.locator('.g2-round .g2-guess')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.g2-round .g2-pano canvas').first()).toBeVisible({ timeout: 30_000 });
}

/** Expand the map widget, optionally pick a world tab, click the map: the Guess button becomes enabled. */
export async function placeGuess(page: Page, opts: { world?: string; at?: { fx: number; fy: number } } = {}): Promise<void> {
  const widget = page.locator('.g2-map-widget');
  await widget.hover();
  await expect(widget).toHaveClass(/g2-expanded/);
  if (opts.world) {
    const tab = widget.locator(`.gm-tab[data-world="${opts.world}"]`);
    if (await tab.isVisible()) await tab.click();
  }
  const canvas = widget.locator('.gm-canvas');
  // Let the expand transition settle so the click lands on the map's real position.
  await page.waitForTimeout(400);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('map canvas has no box');
  const { fx, fy } = opts.at ?? { fx: 0.5, fy: 0.55 };
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await expect(page.locator('.g2-guess')).toBeEnabled();
}

/** Place a guess and press Guess; resolves when the result card is up. */
export async function guessViaUi(page: Page, opts: { world?: string } = {}): Promise<void> {
  await placeGuess(page, opts);
  await page.locator('.g2-guess').click();
  await expect(page.locator('.g2-result')).toBeVisible();
}

/** The result card's primary button (Next round / See summary). */
export async function nextFromResult(page: Page): Promise<void> {
  await page.locator('.g2-result .g2-btn-primary').click();
}

/** The running REST game of the page (sessionStorage), as the server sees it. */
export async function storedGame(player: Player): Promise<GameView> {
  const id = await player.page.evaluate(() => {
    const raw = sessionStorage.getItem('gothic2guessr.game');
    return raw ? (JSON.parse(raw) as { id: string }).id : null;
  });
  if (!id) throw new Error(`${player.name}: no stored game`);
  const res = await player.api<GameView>('GET', `/games/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Text of every visible element whose own text looks like an untranslated i18n key (`area.name`). */
export async function rawKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const keyLike = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim();
      if (text && keyLike.test(text) && !/^\d/.test(text)) out.push(text);
    }
    for (const elm of document.querySelectorAll<HTMLElement>('[title],[aria-label],[placeholder]')) {
      for (const attr of ['title', 'aria-label', 'placeholder']) {
        const v = elm.getAttribute(attr)?.trim();
        if (v && keyLike.test(v)) out.push(`${attr}=${v}`);
      }
    }
    for (const elm of document.querySelectorAll<HTMLInputElement>('input[type=button],input[type=submit]')) {
      if (keyLike.test(elm.value)) out.push(elm.value);
    }
    return out;
  });
}

/**
 * Visible buttons (and pill labels) that overflow: text wider than the box, or the box outside the 1280×720 viewport.
 * Returns a description per offender.
 */
export async function overflowingControls(page: Page, selector = 'button, .g2-pill, .g2-menu-entry, .g2-lang label'): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const elm of document.querySelectorAll<HTMLElement>(sel)) {
      const style = getComputedStyle(elm);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = elm.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Inside a scrolling container the box may sit below the fold: only horizontal escape counts there.
      const label = `${elm.tagName.toLowerCase()}.${[...elm.classList].join('.')} "${(elm.textContent ?? '').trim().slice(0, 40)}"`;
      if (elm.scrollWidth > elm.clientWidth + 1 && style.overflowX !== 'visible') out.push(`${label}: text ${elm.scrollWidth}px > box ${elm.clientWidth}px`);
      if (style.textOverflow === 'ellipsis' && elm.scrollWidth > elm.clientWidth + 1) out.push(`${label}: ellipsis`);
      if (r.left < -1 || r.right > vw + 1) out.push(`${label}: outside the viewport horizontally (${Math.round(r.left)}..${Math.round(r.right)})`);
      if (r.top < -1 || r.bottom > vh + 1) {
        let scroller: HTMLElement | null = elm.parentElement;
        let scrolls = false;
        while (scroller) {
          const s = getComputedStyle(scroller);
          if (/(auto|scroll)/.test(s.overflowY) && scroller.scrollHeight > scroller.clientHeight) {
            scrolls = true;
            break;
          }
          scroller = scroller.parentElement;
        }
        if (!scrolls) out.push(`${label}: outside the viewport vertically (${Math.round(r.top)}..${Math.round(r.bottom)})`);
      }
    }
    return out;
  }, selector);
}

/** No horizontal page scroll. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
