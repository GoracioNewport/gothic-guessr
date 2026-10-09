/**
 * Solo (SPEC §10.1, §10.7): setup with a 30 s limit, walking along links (the server sees the new node), Return to
 * start, a guess, a round that times out (0 points, "Out of time"), a reload that resumes the running round, and the
 * summary with the challenge link and the player's leaderboard row.
 */
import type { Page } from '@playwright/test';
import { expect, guessViaUi, nextFromResult, storedGame, test, waitForRound } from '../fixtures';

/** Click a link arrow of the panorama; resolves with the key of the node fetched for it. */
async function walk(page: Page): Promise<string> {
  const arrow = page.locator('.psv-virtual-tour-link').first();
  await expect(arrow).toBeVisible({ timeout: 20_000 });
  const fetched = page.waitForResponse((r) => /\/api\/games\/[^/]+\/nodes\/[^/]+$/.test(new URL(r.url()).pathname) && r.status() === 200);
  await arrow.click();
  const res = await fetched;
  return new URL(res.url()).pathname.split('/').pop()!;
}

test('solo game: movement, return to start, a timed-out round, resume after reload, summary', async ({ players }) => {
  const p = await players.create({ name: 'solo' });
  const page = p.page;
  await page.goto('/');
  await expect(page.locator('.g2-menu-card')).toBeVisible();
  await page.locator('.g2-menu-play').click();
  await expect(page).toHaveURL(/\/play$/);
  await page.locator('.g2-pill[data-time="30"]').click();
  await page.locator('.g2-start-btn').click();

  // --- round 1: walk, come back, guess
  await waitForRound(page);
  await expect(page.locator('.g2-countdown')).toBeVisible();
  let game = await storedGame(p);
  expect(game.settings.timeLimit).toBe(30);
  const start = game.current!.start;
  expect(start.links.length).toBeGreaterThan(0);
  const walkedTo = await walk(page);
  expect(walkedTo).not.toBe(start.key);
  expect(start.links.map((l) => l.key)).toContain(walkedTo);
  await expect.poll(async () => (await storedGame(p)).currentKey).toBe(walkedTo);
  // A key the player has not reached is refused (reach check).
  const far = await p.api('GET', `/games/${game.id}/nodes/aaaaaaaaaaaa`);
  expect(far.status).toBe(404);
  // R at once, while the walk transition may still be running, must still bring the player back.
  await page.keyboard.press('r');
  await expect.poll(async () => (await storedGame(p)).currentKey).toBe(start.key);
  // The viewer still walks after that, and the Return button works as well as R.
  await page.waitForTimeout(1500);
  const again = await walk(page);
  await expect.poll(async () => (await storedGame(p)).currentKey).toBe(again);
  await page.waitForTimeout(1500);
  await page.locator('.g2-hud-return').click();
  await expect.poll(async () => (await storedGame(p)).currentKey).toBe(start.key);
  await guessViaUi(page);
  await expect(page.locator('.g2-result .g2-stat-value').first()).not.toBeEmpty();
  await nextFromResult(page);

  // --- round 2: let the 30 s countdown run out
  await waitForRound(page);
  await expect(page.locator('.g2-result')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.g2-result .g2-wrong-world')).toHaveText('Out of time');
  await expect(page.locator('.g2-result .g2-accent')).toHaveText('0');
  game = await storedGame(p);
  expect(game.results[1]).toMatchObject({ n: 2, guess: null, score: 0, timedOut: true });
  await nextFromResult(page);

  // --- round 3: reload mid-round resumes the same round
  await waitForRound(page);
  const before = (await storedGame(p)).current!;
  await page.reload();
  await waitForRound(page);
  await expect(page.locator('.g2-hud-round')).toHaveText('Round 3/5');
  const after = (await storedGame(p)).current!;
  expect(after.n).toBe(3);
  expect(after.start.key).toBe(before.start.key);
  await guessViaUi(page);
  await nextFromResult(page);

  // --- rounds 4-5
  for (let n = 4; n <= 5; n++) {
    await waitForRound(page);
    await expect(page.locator('.g2-hud-round')).toHaveText(`Round ${n}/5`);
    await guessViaUi(page);
    await nextFromResult(page);
  }

  // --- summary
  await expect(page.locator('.g2-summary')).toBeVisible();
  game = await storedGame(p);
  expect(game.finished).toBe(true);
  expect(game.results).toHaveLength(5);
  const link = await page.locator('.g2-share-link input').inputValue();
  expect(link).toMatch(new RegExp(`/c/${game.challengeCode}$`));
  await expect(page.locator('.g2-rounds-table tbody tr')).toHaveCount(5);
  await expect(page.locator('.g2-lb-me')).toHaveCount(1);
  const total = (await page.locator('.g2-summary .g2-total .g2-accent').textContent())?.trim();
  await expect(page.locator('.g2-lb-me .g2-lb-total')).toHaveText(total ?? '');
  // A solo game offers Play again (a new game with the same settings) next to Main menu.
  await expect(page.locator('.g2-summary-again')).toContainText('Play again');
  await expect(page.locator('.g2-summary-menu')).toContainText('Main menu');
  // A reload keeps the summary.
  await page.reload();
  await expect(page.locator('.g2-summary .g2-total .g2-accent')).toHaveText(total ?? '');
});
