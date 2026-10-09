/**
 * Daily page footer row (owner's report: "Next challenge in 18:12:03 · Earlier days …" jumped and sometimes wrapped):
 * in every language at 1280×720 and 1920×1080 the countdown and the past-days picker share one line, nothing on
 * that line moves while the clock ticks, no label is cut off and nothing overflows. Sampled over 2.5 s.
 */
import type { Page } from '@playwright/test';
import type { Lang } from '../../shared/api';
import { expect, horizontalOverflow, test } from '../fixtures';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Sample {
  text: string;
  /** Boxes relative to the row (the card may still settle around it). */
  boxes: Record<string, Box | null>;
  rowW: number;
  rowH: number;
  clipped: string[];
}

const PARTS = ['.g2-daily-next', '.g2-daily-next-label', '.g2-daily-countdown', '.g2-daily-picker', '.g2-daily-picker label', '.g2-daily-date', '.g2-daily-picker button'];

async function sample(page: Page): Promise<Sample> {
  return page.evaluate((parts) => {
    const row = document.querySelector<HTMLElement>('.g2-daily-foot')!;
    const r = row.getBoundingClientRect();
    const round = (v: number): number => Math.round(v * 10) / 10;
    const boxes: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
    const clipped: string[] = [];
    for (const sel of parts) {
      const e = document.querySelector<HTMLElement>(sel);
      if (!e) {
        boxes[sel] = null;
        continue;
      }
      const b = e.getBoundingClientRect();
      boxes[sel] = { x: round(b.x - r.x), y: round(b.y - r.y), w: round(b.width), h: round(b.height) };
      if (e.scrollWidth > e.clientWidth + 1) clipped.push(sel);
    }
    if (row.scrollWidth > row.clientWidth + 1) clipped.push('.g2-daily-foot');
    return { text: document.querySelector('.g2-daily-countdown')?.textContent ?? '', boxes, rowW: round(r.width), rowH: round(r.height), clipped };
  }, PARTS);
}

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
];

for (const lang of ['en', 'de', 'pl', 'ru'] as const satisfies readonly Lang[]) {
  test(`daily footer row stays on one line and still while ticking (${lang})`, async ({ players }) => {
    const p = await players.create({ name: `daily-layout-${lang}`, lang });
    const page = p.page;
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.goto('/daily');
      await expect(page.locator('.g2-daily-countdown')).toHaveText(/^\d\d:\d\d:\d\d$/);
      await expect(page.locator('.g2-lb')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      // Let anything that mounts after the data (side panels, fitted leaderboard) settle.
      await page.waitForTimeout(500);
      const samples: Sample[] = [];
      for (let i = 0; i < 11; i++) {
        samples.push(await sample(page));
        await page.waitForTimeout(250);
      }
      const where = `${lang} ${size.width}x${size.height}`;
      expect(new Set(samples.map((s) => s.text)).size, `${where}: the clock ticked`).toBeGreaterThan(1);
      const first = samples[0]!;
      for (const s of samples) {
        expect(s.boxes, `${where}: row parts moved at ${s.text}`).toEqual(first.boxes);
        expect([s.rowW, s.rowH], `${where}: row size changed at ${s.text}`).toEqual([first.rowW, first.rowH]);
        expect(s.clipped, `${where}: clipped at ${s.text}`).toEqual([]);
      }
      // One line: the countdown and the picker share a vertical centre.
      const next = first.boxes['.g2-daily-next']!;
      const picker = first.boxes['.g2-daily-picker']!;
      expect(Math.abs(next.y + next.h / 2 - (picker.y + picker.h / 2)), `${where}: one line`).toBeLessThan(4);
      expect(first.rowH, `${where}: one line`).toBeLessThanOrEqual(picker.h + 1);
      expect(await horizontalOverflow(page), `${where}: horizontal scroll`).toBeLessThanOrEqual(0);
    }
  });
}
