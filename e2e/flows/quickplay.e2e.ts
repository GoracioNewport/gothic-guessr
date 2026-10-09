/**
 * Quick play and the menu dressing (owner requests of 2026-10-08): the start-screen backdrop and the Gothic II logo,
 * the renamed menu entries, 3/5/10 rounds with a live rules panel, a 3-round game end to end (HUD "Round n/3",
 * a 3-row summary), the daily page's rules, and the Legal notice (modal, focus trap, Esc, page keys kept out).
 */
import { expect, guessViaUi, nextFromResult, storedGame, test, waitForRound } from '../fixtures';

test('quick play: backdrop, logo, 3 rounds with the rules panel, daily rules, legal notice', async ({ players }) => {
  const p = await players.create({ name: 'quickplay' });
  const page = p.page;
  await page.goto('/');

  // --- menu: backdrop + logo + renamed entries
  await expect(page.locator('.g2-menu-card')).toBeVisible();
  // The menu re-renders when the player and the daily status arrive: read the live nodes each time.
  const bg = (selector: string): Promise<string> =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      return node ? getComputedStyle(node).backgroundImage : '';
    }, selector);
  await expect.poll(() => bg('.g2-menu')).toContain('MENU_BACK_ADDON.webp');
  await expect.poll(() => bg('.g2-logo')).toContain('MENU_GOTHIC_G2.png');
  for (const file of ['MENU_BACK_ADDON.webp', 'MENU_GOTHIC_G2.png']) {
    const res = await page.request.get(`/ui/gothic/${file}`);
    expect(res.status(), file).toBe(200);
  }
  await expect(page.locator('.g2-menu-play .g2-menu-entry-label')).toHaveText('Quick play');
  await expect(page.locator('.g2-menu-friends .g2-menu-entry-label')).toHaveText('Multiplayer');

  // --- legal notice: opens, traps focus, Esc closes and gives focus back to the link
  const link = page.locator('.g2-legal-link');
  await expect(link).toHaveText('Legal');
  await link.click();
  const dialog = page.locator('dialog.g2-legal');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.g2-legal-title')).toHaveText('Legal notice');
  await expect(dialog).toContainText('THQ Nordic GmbH');
  await expect(dialog).toContainText('non-commercial fan project');
  await expect(dialog.locator('.g2-legal-close')).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog.g2-legal'))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog.g2-legal'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(link).toBeFocused();

  // --- setup: rounds pills and the rules panel
  await page.locator('.g2-menu-play').click();
  await expect(page).toHaveURL(/\/play$/);
  await expect(page.locator('.g2-start h1')).toHaveText('Quick play');
  const rules = page.locator('.g2-start .g2-rules');
  await expect(rules).toBeVisible();
  await expect(rules.locator('[data-rule="rounds"]')).toHaveText('5 rounds will be played');
  await expect(rules.locator('[data-rule="time"]')).toHaveText('No time limit');
  await expect(page.locator('.g2-rounds .g2-pill-active')).toHaveText('5');
  // The panel sits to the right of the card at 1280×720.
  const cardBox = (await page.locator('.g2-start .g2-card').boundingBox())!;
  const rulesBox = (await rules.boundingBox())!;
  expect(rulesBox.x).toBeGreaterThan(cardBox.x + cardBox.width - 1);

  await page.locator('.g2-rounds .g2-pill[data-rounds="3"]').click();
  await expect(rules.locator('[data-rule="rounds"]')).toHaveText('3 rounds will be played');
  await page.locator('.g2-pill[data-time="300"]').click();
  await expect(rules.locator('[data-rule="time"]')).toHaveText('Each round lasts 5 minutes');
  await page.locator('.g2-toggle:has([data-toggle="nomove"])').click();
  await expect(rules.locator('[data-rule="movement"]')).toHaveText('Movement is off: you can only look around');
  await page.locator('.g2-toggle:has([data-toggle="nomove"])').click();
  await expect(rules.locator('[data-rule="movement"]')).toHaveText('You can walk along the paths and look around');

  // Enter inside the legal notice must not start the game behind it.
  await page.locator('.g2-legal-link').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('.g2-legal-body').focus();
  await page.keyboard.press('Enter');
  await dialog.locator('.g2-legal-close').click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/play$/);
  await expect(page.locator('.g2-round')).toHaveCount(0);

  // --- a 3-round game
  await page.locator('.g2-start-btn').click();
  for (let n = 1; n <= 3; n++) {
    await waitForRound(page);
    await expect(page.locator('.g2-hud-round')).toHaveText(`Round ${n}/3`);
    if (n === 1) {
      const game = await storedGame(p);
      expect(game.totalRounds).toBe(3);
      expect(game.settings.rounds).toBe(3);
    }
    await guessViaUi(page);
    await nextFromResult(page);
  }
  await expect(page.locator('.g2-summary')).toBeVisible();
  await expect(page.locator('.g2-rounds-table tbody tr')).toHaveCount(3);
  const done = await storedGame(p);
  expect(done.finished).toBe(true);
  expect(done.results).toHaveLength(3);

  // The setup remembers 3 rounds.
  await page.goto('/play');
  await expect(page.locator('.g2-rounds .g2-pill-active')).toHaveText('3');

  // --- daily: its rules
  await page.goto('/daily');
  const dailyRules = page.locator('.g2-daily .g2-rules');
  await expect(dailyRules).toBeVisible();
  await expect(dailyRules.locator('[data-rule="daily.once"]')).toHaveText('One attempt per day');
  await expect(dailyRules.locator('[data-rule="daily.same"]')).toHaveText('The same rounds for everyone');
  await expect(dailyRules.locator('[data-rule="rounds"]')).toHaveText('5 rounds will be played');
  await expect(page.locator('.g2-daily .g2-legal-link')).toBeVisible();
});
