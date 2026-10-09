/**
 * Languages (SPEC §10.8, §10.11): switching the main menu to German, Polish and Russian with the selector, then a
 * solo round and its result in that language. On every screen: no untranslated keys, the dictionary's own words on
 * the main controls, no key button or pill overflowing its box or the 1280×720 viewport, no horizontal scroll,
 * `<html lang>` following the language, and the localised game fonts for pl/ru (docs/FONTS.md). The choice survives a
 * reload.
 */
import type { Page } from '@playwright/test';
import type { Lang } from '../../shared/api';
import { de } from '../../src/i18n/de';
import { pl } from '../../src/i18n/pl';
import { ru } from '../../src/i18n/ru';
import type { Dictionary } from '../../src/i18n/types';
import { expect, guessViaUi, horizontalOverflow, overflowingControls, rawKeys, test, waitForRound } from '../fixtures';

const DICTS: Record<Exclude<Lang, 'en'>, Dictionary> = { de, pl, ru };
/** First family of the display font stack per language (src/style.css). */
const GAME_FONT: Record<Exclude<Lang, 'en'>, string> = { de: 'Gothic Old', pl: 'Gothic Old PL', ru: 'Gothic Old RU' };

/** Plain-string entry of a dictionary. */
function word(dict: Dictionary, key: string): string {
  const v = (dict as Record<string, unknown>)[key];
  if (typeof v !== 'string') throw new Error(`${key} is not a plain string`);
  return v;
}

async function checkScreen(page: Page, lang: Lang, where: string, selector?: string): Promise<void> {
  expect(await rawKeys(page), `${lang} ${where}: raw i18n keys`).toEqual([]);
  expect(await overflowingControls(page, selector), `${lang} ${where}: overflowing controls`).toEqual([]);
  expect(await horizontalOverflow(page), `${lang} ${where}: horizontal scroll`).toBeLessThanOrEqual(0);
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
}

async function fontOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((e) => getComputedStyle(e).fontFamily);
}

for (const lang of ['de', 'pl', 'ru'] as const) {
  test(`language ${lang}: main menu, setup, round and result screens`, async ({ players }) => {
    const dict = DICTS[lang];
    const p = await players.create({ name: `i18n-${lang}` });
    const page = p.page;
    await page.goto('/');
    await expect(page.locator('.g2-menu-play .g2-menu-entry-label')).toHaveText('Quick play');
    await page.locator(`.g2-lang-option[data-lang="${lang}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);

    // --- main menu (with the friends panel open: its buttons and the code field must fit too)
    await expect(page.locator('.g2-menu-play .g2-menu-entry-label')).toHaveText(word(dict, 'menu.play'));
    await expect(page.locator('.g2-menu-daily .g2-menu-entry-label')).toHaveText(word(dict, 'menu.daily'));
    await expect(page.locator(`.g2-lang-option[data-lang="${lang}"]`)).toHaveClass(/g2-lang-active/);
    await checkScreen(page, lang, 'menu');
    await page.locator('.g2-menu-friends').click();
    await expect(page.locator('.g2-friends-create button').first()).toHaveText(word(dict, 'menu.createRoom'));
    await checkScreen(page, lang, 'menu with friends panel');
    const font = await fontOf(page, '.g2-menu-play .g2-menu-entry-label');
    // The primary family: the Gothic fonts for German (Latin-1), the Polish / Russian releases' own atlases for pl / ru.
    const family = GAME_FONT[lang];
    expect(font).toMatch(new RegExp(`^"?${family}"?,`));
    expect(await page.evaluate((f) => document.fonts.check(`16px "${f}"`), family)).toBe(true);

    // The choice is stored and survives a reload.
    expect(await page.evaluate(() => localStorage.getItem('gothic2guessr.lang'))).toBe(lang);
    await page.reload();
    await expect(page.locator('.g2-menu-play .g2-menu-entry-label')).toHaveText(word(dict, 'menu.play'));

    // --- daily page (today's leaderboard of the daily flow)
    await page.goto('/daily');
    await expect(page.locator('.g2-daily h1')).toHaveText(word(dict, 'daily.heading'));
    await expect(page.locator('.g2-lb-heading, .g2-lb-empty').first()).toBeVisible();
    await checkScreen(page, lang, 'daily page');
    await page.goto('/');

    // --- solo setup
    await page.locator('.g2-menu-play').click();
    await expect(page.locator('.g2-start-btn')).toContainText(word(dict, 'start.startGame'));
    await checkScreen(page, lang, 'setup');

    // --- round screen
    await page.locator('.g2-pill[data-time="300"]').click();
    await page.locator('.g2-start-btn').click();
    await waitForRound(page);
    await expect(page.locator('.g2-guess')).toContainText(word(dict, 'round.guess'));
    await expect(page.locator('.g2-hud-return')).toContainText(word(dict, 'round.return'));
    await expect(page.locator('.g2-countdown')).toBeVisible();
    const hudButtons = '.g2-hud button, .g2-guess, .g2-hud-return, .g2-pin, .g2-countdown';
    await checkScreen(page, lang, 'round', hudButtons);
    // Expanded map: the world tabs and the Guess button.
    await page.locator('.g2-map-widget').hover();
    await expect(page.locator('.g2-map-widget')).toHaveClass(/g2-expanded/);
    await page.waitForTimeout(400);
    await checkScreen(page, lang, 'round, map expanded', `${hudButtons}, .gm-tab`);
    expect(await fontOf(page, '.g2-guess')).toMatch(new RegExp(`^"?${GAME_FONT[lang]}"?,`));

    // --- result screen
    await guessViaUi(page);
    await expect(page.locator('.g2-result .g2-btn-primary')).toContainText(word(dict, 'result.next'));
    await checkScreen(page, lang, 'result', '.g2-result button, .g2-result .gm-tab');
  });
}
