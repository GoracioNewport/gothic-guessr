/**
 * Problem reports: the corner link on the menu (a translation report: text required, sent, thank-you toast), the
 * round HUD flag (a place report with a category), and the admin page: the
 * place resolved to the waypoint the player stands on, its panorama preview, Resolve, and the nav count.
 */
import { expect, privateNodes, storedGame, test, waitForRound } from '../fixtures';

const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const ADMIN = `/${process.env.E2E_ADMIN_PATH ?? ''}`;

test('reports: menu link, HUD flag, admin list with the resolved place', async ({ players }) => {
  const p = await players.create({ name: 'reporter' });
  const page = p.page;
  await page.goto('/');
  await expect(page.locator('.g2-menu-card')).toBeVisible();

  // --- corner link: a translation report
  const link = page.locator('.g2-report-link');
  await expect(link).toBeVisible();
  await link.click();
  const dialog = page.locator('.g2-report[role=dialog]');
  await expect(dialog).toBeVisible();
  // No game on this page: no place to attach, so "Something does not work" is preselected.
  await expect(dialog.locator('input[name=g2-report-type][value=bug]')).toBeChecked();
  await dialog.locator('label.g2-report-type', { hasText: 'Translation' }).click();
  await expect(dialog.locator('.g2-report-place')).toBeHidden();
  await dialog.locator('.g2-btn-primary').click();
  await expect(dialog.locator('.g2-report-error')).toHaveText('Please describe the problem.');
  await dialog.locator('textarea').fill('The daily page says "Daily challange".');
  await expect(dialog.locator('.g2-report-counter')).toHaveText('38/1000');
  const sent = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/reports' && r.request().method() === 'POST');
  await dialog.locator('.g2-btn-primary').click();
  expect((await sent).status()).toBe(204);
  await expect(dialog).toBeHidden();
  await expect(page.locator('.g2-toast')).toHaveText('Thank you! Your report has been sent.');

  // --- a solo round: the HUD flag reports the place
  await page.locator('.g2-menu-play').click();
  await expect(page).toHaveURL(/\/play$/);
  await page.locator('.g2-start-btn').click();
  await waitForRound(page);
  await expect(link).toBeHidden(); // the round screen has its own flag
  const flag = page.locator('.g2-hud .g2-report-flag');
  await expect(flag).toBeVisible();
  await flag.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[name=g2-report-type][value=location]')).toBeChecked();
  await expect(dialog.locator('.g2-report-sublegend', { hasText: 'Details (optional)' })).toBeVisible();
  await dialog.locator('.g2-report-chip', { hasText: 'Floating in the air' }).click();
  await dialog.locator('textarea').fill('Hanging over the water');
  await dialog.locator('.g2-btn-primary').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.g2-toast')).toHaveText('Thank you! Your report has been sent.');
  const game = await storedGame(p);
  const key = game.currentKey ?? game.current!.start.key;
  const node = privateNodes().get(key)!;

  // --- admin: both reports, the place resolved on the server
  const admin = await players.create({ name: 'report-admin' });
  const ap = admin.page;
  await ap.goto(ADMIN);
  await ap.locator('input[type=password]').fill(PASSWORD);
  await ap.locator('button[type=submit]').click();
  const navLink = ap.locator(`.nav a[href="${ADMIN}/reports"]`);
  await expect(navLink.locator('.nav-count')).toHaveText(/^\d+$/);
  const openBefore = Number(await navLink.locator('.nav-count').textContent());
  expect(openBefore).toBeGreaterThanOrEqual(2);
  await navLink.click();
  const rows = ap.locator('.reports-grid tbody tr');
  await expect(rows.first()).toBeVisible();
  const placeRow = rows.filter({ hasText: node.wp }).first();
  await expect(placeRow).toBeVisible();
  await expect(placeRow).toContainText('floating');
  await expect(rows.filter({ hasText: 'Daily challange' })).toHaveCount(1);

  await placeRow.locator('td').first().click();
  const drawer = ap.locator('.drawer');
  await expect(drawer).toBeVisible();
  await expect(ap).toHaveURL(new RegExp(`${ADMIN}/reports/\\d+`));
  await expect(drawer).toContainText(node.wp);
  await expect(drawer).toContainText(key);
  await expect(drawer).toContainText('Hanging over the water');
  const img = drawer.locator('.pano-face img').first();
  await expect(img).toHaveAttribute('src', `/data/panos/${key}/base_front.webp`);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await drawer.locator('button', { hasText: 'Resolve' }).click();
  await expect(drawer.locator('.drawer-badges')).toContainText('resolved');
  await expect.poll(async () => Number((await navLink.locator('.nav-count').textContent()) ?? 0)).toBe(openBefore - 1);
});
