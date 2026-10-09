/**
 * Admin (SPEC §10.9, §10.10), after the flows: login (a wrong password refused), the dashboard totals include the
 * games played by the flows plus a daily played during this test, a daily override for tomorrow (today needs
 * "force" because it has plays), and a ban that removes a player from the daily leaderboard (unban restores it).
 *
 * The admin password and path are the run's random E2E_ADMIN_PASSWORD and E2E_ADMIN_PATH (playwright.config.ts): the
 * UI is at `/<path>`, its API at `/api/<path>`; the password is typed into the form and never logged.
 */
import type { Page } from '@playwright/test';
import type { AdminDailyDetail, AdminStats, GameKind, GameView, LeaderboardView, RoundResultView, RoundView } from '../shared/api';
import type { Player } from './fixtures';
import { answerOf, expect, test } from './fixtures';

const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const ADMIN = `/${process.env.E2E_ADMIN_PATH ?? ''}`;

async function adminApi<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async ([api, p]) => {
    const res = await fetch(`${api}${p}`);
    if (!res.ok) throw new Error(`admin ${p}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }, [`/api${ADMIN}`, path] as const);
}

const utc = (offsetDays = 0): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** A whole daily over REST with perfect guesses (25 000 points, so the player tops the day's leaderboard). */
async function playDailyPerfectly(p: Player): Promise<GameView> {
  const created = await p.api<GameView>('POST', '/games', { kind: 'daily' });
  expect(created.status).toBe(200);
  const id = created.body.id;
  for (let n = 1; n <= 5; n++) {
    const round = await p.api<RoundView>('POST', `/games/${id}/rounds`);
    expect(round.status).toBe(200);
    const res = await p.api<RoundResultView>('POST', `/games/${id}/guess`, { guess: answerOf(round.body.start.key) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.score).toBe(5000);
    await p.page.waitForTimeout(600); // guesses are limited to 2 per second
  }
  const done = await p.api<GameView>('GET', `/games/${id}`);
  expect(done.body.finished).toBe(true);
  return done.body;
}

function tile(page: Page, label: string) {
  return page.locator('.tile', { has: page.locator('.tile-label', { hasText: label }) });
}

test('admin: login, stats with the games just played, daily override, ban removes from the leaderboard', async ({ players }) => {
  expect(PASSWORD.length).toBeGreaterThan(8);
  expect(ADMIN).toMatch(/^\/[A-Za-z0-9_-]{4,64}$/);
  expect(ADMIN).not.toBe('/admin');
  const admin = await players.create({ name: 'admin' });
  const page = admin.page;
  page.on('dialog', (d) => void d.accept());

  // --- login
  await page.goto(ADMIN);
  const password = page.locator('input[type=password]');
  await expect(password).toBeVisible();
  await password.fill('definitely-not-the-password');
  await page.locator('button[type=submit]').click();
  await expect(page.locator('.login-error')).not.toBeEmpty();
  await password.fill(PASSWORD);
  await page.locator('button[type=submit]').click();
  await expect(page.locator('main.content h1')).toHaveText('Dashboard');
  const cookies = await admin.context.cookies();
  const session = cookies.find((c) => c.name === 'g2g_admin');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');

  // --- stats: the flows' games are counted
  const before = await adminApi<AdminStats>(page, `/stats?from=${utc(-29)}&to=${utc()}`);
  const fin = before.totals.gamesFinished;
  const atLeast: Partial<Record<GameKind, number>> = { solo: 2, daily: 1, challenge: 1, party: 3, duel: 2 };
  for (const [kind, n] of Object.entries(atLeast)) expect(fin[kind as GameKind], `finished ${kind} games`).toBeGreaterThanOrEqual(n);
  expect(before.totals.roomsCreated).toBeGreaterThanOrEqual(2);
  expect(before.totals.dailyPlayers).toBeGreaterThanOrEqual(1);
  expect(before.totals.newPlayers).toBeGreaterThanOrEqual(10);
  expect(before.totals.pageViews).toBeGreaterThan(0);

  // A player plays today's daily now; the dashboard shows it after a refresh.
  const victim = await players.create({ name: 'admin-victim' });
  await victim.page.goto('/');
  const nickname = `Victim${Math.floor(Math.random() * 1e6)}`;
  const renamed = await victim.api<{ id: string; nickname: string }>('PATCH', '/me', { nickname });
  expect(renamed.status).toBe(200);
  const victimId = renamed.body.id;
  const daily = await playDailyPerfectly(victim);
  await page.reload();
  await expect(page.locator('main.content h1')).toHaveText('Dashboard');
  const after = await adminApi<AdminStats>(page, `/stats?from=${utc(-29)}&to=${utc()}`);
  expect(after.totals.gamesFinished.daily).toBe(fin.daily + 1);
  expect(after.totals.gamesStarted.daily).toBe(before.totals.gamesStarted.daily + 1);
  expect(after.totals.dailyPlayers).toBe(before.totals.dailyPlayers + 1);
  const finishedSum = Object.values(after.totals.gamesFinished).reduce((s, n) => s + n, 0);
  await expect(tile(page, 'Games finished').locator('.tile-value')).toHaveText(finishedSum.toLocaleString('en-US'));
  await expect(tile(page, 'Games finished').locator('.tile-note')).toContainText(`Daily ${after.totals.gamesFinished.daily}`);
  await expect(tile(page, 'Games finished').locator('.tile-note')).toContainText(`Duel ${after.totals.gamesFinished.duel}`);
  await expect(tile(page, 'Daily participants').locator('.tile-value')).toHaveText(String(after.totals.dailyPlayers));
  await expect(page.locator('.charts svg').first()).toBeVisible();

  // --- daily override: today has plays and needs "force"; tomorrow can be changed freely
  await page.goto(`${ADMIN}/daily/${utc()}`);
  await expect(page.locator('main.content h1')).toHaveText(`Daily ${utc()}`);
  await page.locator('select[name=mode]').selectOption('hardcore');
  await page.getByRole('button', { name: 'Save override' }).click();
  await expect(page.locator('.form-status')).toContainText('force');
  const today = await adminApi<AdminDailyDetail>(page, `/daily/${utc()}`);
  expect(today.row.overridden).toBe(false);
  expect(today.row.settings.mode).toBe('mixed');

  const tomorrow = utc(1);
  await page.goto(`${ADMIN}/daily/${tomorrow}`);
  await expect(page.locator('main.content h1')).toHaveText(`Daily ${tomorrow}`);
  await page.locator('select[name=mode]').selectOption('hardcore');
  await page.locator('select[name=timeLimit]').selectOption('60');
  await page.getByRole('button', { name: 'Save override' }).click();
  await expect(page.locator('.toast')).toContainText(`Settings of ${tomorrow} saved`);
  const next = await adminApi<AdminDailyDetail>(page, `/daily/${tomorrow}`);
  expect(next.row.overridden).toBe(true);
  expect(next.row.settings).toMatchObject({ mode: 'hardcore', timeLimit: 60 });
  // Players cannot look at a future daily.
  expect((await victim.api('GET', `/daily/${tomorrow}`)).status).not.toBe(200);

  // --- ban: the victim tops today's daily leaderboard, then disappears from it
  const code = `daily-${daily.date}`;
  const board = async (): Promise<LeaderboardView> => (await admin.api<LeaderboardView>('GET', `/challenges/${code}/leaderboard?limit=50`, undefined, { anonymous: true })).body;
  expect((await board()).entries[0]?.playerId).toBe(victimId);
  await page.goto(`${ADMIN}/players`);
  await page.locator('input[type=search]').fill(nickname);
  await page.getByRole('button', { name: 'Search' }).click();
  const row = page.locator('tr.clickable', { hasText: nickname });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page.locator('main.content h1')).toHaveText(nickname);
  await page.locator('input[aria-label="Ban reason"]').fill('e2e test');
  await page.getByRole('button', { name: 'Ban', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unban' })).toBeVisible();
  expect((await board()).entries.map((e) => e.playerId)).not.toContain(victimId);
  // The banned player still sees a page, without themselves on the board.
  const own = await victim.api<LeaderboardView>('GET', `/challenges/${code}/leaderboard`);
  expect(own.body.entries.map((e) => e.playerId)).not.toContain(victimId);
  // The moderation view still lists the row, as banned.
  const mod = await adminApi<AdminDailyDetail>(page, `/daily/${daily.date}`);
  expect(mod.challenge?.entries.find((e) => e.playerId === victimId)).toMatchObject({ banned: true, rank: 0 });
  // Banned players cannot create rooms.
  const roomTry = await victim.api<{ error: string }>('POST', '/rooms', { type: 'party', settings: daily.settings });
  expect(roomTry.status).toBe(403);
  expect(roomTry.body.error).toBe('banned');

  // Unban restores the entry.
  await page.getByRole('button', { name: 'Unban' }).click();
  await expect(page.getByRole('button', { name: 'Ban', exact: true })).toBeVisible();
  expect((await board()).entries[0]?.playerId).toBe(victimId);
});
