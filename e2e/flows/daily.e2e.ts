/**
 * Daily (SPEC §10.1, §10.5): the day's 5 rounds with the default settings (all worlds, Mixed, 2 min), the
 * Wordle-style share text (copy button), the menu status, and a second attempt refused (`already_played`).
 */
import type { ChallengeView, GameView } from '../../shared/api';
import { expect, guessViaUi, nextFromResult, storedGame, test, waitForRound } from '../fixtures';

const SQUARES = /^[🟩🟨🟧🟥⬛]{5}$/u;

test('daily: played once with share text, second attempt refused', async ({ players, baseURL }) => {
  const p = await players.create({ name: 'daily', clipboard: true });
  const page = p.page;
  await page.goto('/');
  await expect(page.locator('.g2-menu-daily .g2-menu-entry-hint')).toHaveText('Not played yet');
  await page.locator('.g2-menu-daily').click();
  await expect(page).toHaveURL(/\/daily$/);
  await page.locator('.g2-daily-play').click();

  let game: GameView | null = null;
  for (let n = 1; n <= 5; n++) {
    await waitForRound(page);
    await expect(page.locator('.g2-hud-round')).toHaveText(`Round ${n}/5`);
    if (n === 1) {
      game = await storedGame(p);
      expect(game.kind).toBe('daily');
      expect(game.settings).toMatchObject({ mode: 'mixed', noMove: false, noLook: false, timeLimit: 120, rounds: 5 });
      expect(game.settings.worlds).toEqual(['khorinis', 'valley', 'jharkendar']);
      await expect(page.locator('.g2-countdown')).toBeVisible();
    }
    // Spread the guesses over the worlds so the squares vary.
    await guessViaUi(page, { world: ['khorinis', 'valley', 'jharkendar'][n % 3] });
    await nextFromResult(page);
  }

  await expect(page.locator('.g2-summary')).toBeVisible();
  // One attempt a day: no Play again, Main menu is the primary (Enter) button.
  await expect(page.locator('.g2-summary-again')).toHaveCount(0);
  await expect(page.locator('.g2-summary-menu')).toHaveClass(/g2-btn-primary/);
  await expect(page.locator('.g2-summary-menu')).toContainText('Main menu');
  game = await storedGame(p);
  expect(game.finished).toBe(true);
  const date = game.date!;
  expect(date).toBe(new Date().toISOString().slice(0, 10));
  const share = await page.locator('.g2-share-daily textarea').inputValue();
  const lines = share.split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe(`Gothic Guessr — Daily ${date}`);
  const grouped = String(game.total).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  expect(lines[1]).toBe(`${grouped} / 25 000`);
  expect(lines[2]).toMatch(SQUARES);
  const expected = game.results
    .map((r) => (r.timedOut || r.distanceM === null ? '⬛' : r.score >= 4000 ? '🟩' : r.score >= 2000 ? '🟨' : r.score >= 500 ? '🟧' : '🟥'))
    .join('');
  expect(lines[2]).toBe(expected);
  expect(lines[3]).toBe(`${baseURL}/daily`);
  await page.locator('.g2-share-daily button').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(share);

  // The daily page now shows the result with the same share text and no Play button.
  await page.goto('/daily');
  await expect(page.locator('.g2-daily-status .g2-share-daily textarea')).toHaveValue(share);
  await expect(page.locator('.g2-daily-play')).toHaveCount(0);
  await expect(page.locator('.g2-lb-me')).toHaveCount(1);
  // Played: the nickname with Change sits on the leaderboard's heading line; the countdown is HH:MM:SS.
  await expect(page.locator('.g2-lb-head .g2-nick-inline .g2-nick-edit')).toBeVisible();
  await expect(page.locator('.g2-daily-countdown')).toHaveText(/^\d\d:\d\d:\d\d$/);

  // The menu shows today's score.
  await page.goto('/');
  const enTotal = game.total.toLocaleString('en-US');
  await expect(page.locator('.g2-menu-daily .g2-menu-entry-hint')).toHaveText(`Today: ${enTotal} points`);

  // A past day without a daily says so.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await page.goto(`/daily/${yesterday}`);
  await expect(page.locator('.g2-daily .g2-muted').first()).toHaveText('Nobody played a daily challenge on this day.');

  // A second attempt is refused by the server.
  const again = await p.api<{ error: string }>('POST', '/games', { kind: 'daily' });
  expect(again.status).toBe(409);
  expect(again.body.error).toBe('already_played');
  const view = await p.api<ChallengeView>('GET', '/daily');
  expect(view.body.myGame).toMatchObject({ id: game.id, finished: true, total: game.total });
});
