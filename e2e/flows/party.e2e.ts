/**
 * Party room (SPEC §10.6, §10.7) with three browser contexts: A creates the party from the menu and sets 3 rounds,
 * B joins by link, C by typing the code (lower case) in the menu. Round 1 everyone guesses ("X guessed" ticks, the
 * round table with three rows). Round 2: C closes the tab before guessing, the round closes as soon as A and B
 * guessed, C scores 0. C comes back with the same token and is put back into the running game; round 3 everyone
 * plays, nobody presses Next and the room's own 15 s timer moves on to the final standings (all three, challenge
 * link); back to the lobby.
 */
import type { RoomView } from '../../shared/api';
import type { Player } from '../fixtures';
import { expect, horizontalOverflow, overflowingControls, placeGuess, rawKeys, test, waitForRound } from '../fixtures';

async function room(p: Player, code: string): Promise<RoomView> {
  const res = await p.api<RoomView>('GET', `/rooms/${code}`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Host: press Next on the result card (party: "Next round" / "Show standings"). */
/** No raw i18n keys, no overflowing button and no horizontal scroll on the player's current screen. */
async function checkLanguage(p: Player, where: string, selector?: string): Promise<void> {
  expect(await rawKeys(p.page), `${p.name} ${where}: raw keys`).toEqual([]);
  expect(await overflowingControls(p.page, selector), `${p.name} ${where}: overflow`).toEqual([]);
  expect(await horizontalOverflow(p.page), `${p.name} ${where}: horizontal scroll`).toBeLessThanOrEqual(0);
}

async function hostNext(host: Player): Promise<void> {
  await host.page.locator('.g2-result .g2-btn-primary').click();
}

test('party with 3 contexts: lobby, rounds, a disconnect and return, standings', async ({ players }) => {
  const a = await players.create({ name: 'party-a' });
  const b = await players.create({ name: 'party-b', lang: 'de' });
  const c = await players.create({ name: 'party-c', lang: 'ru' });

  // --- A creates the party from the menu
  await a.page.goto('/');
  await a.page.locator('.g2-menu-friends').click();
  await a.page.locator('.g2-friends-create button').first().click();
  await expect(a.page).toHaveURL(/\/r\/[A-Z]{5}$/);
  const code = a.page.url().split('/').pop()!;
  await expect(a.page.locator('.g2-room-lobby')).toBeVisible();
  await expect(a.page.locator('.g2-room-code-value')).toHaveText(code);
  await a.page.locator('.g2-pill:has(input[data-focus="rounds:3"])').click();
  await a.page.locator('.g2-pill:has(input[data-focus="time:60"])').click();
  await expect.poll(async () => (await room(a, code)).settings).toMatchObject({ rounds: 3, timeLimit: 60 });

  // --- B by link, C by code typed in the menu
  await b.page.goto(`/r/${code}`);
  await expect(b.page.locator('.g2-room-lobby')).toBeVisible();
  await c.page.goto('/');
  await c.page.locator('.g2-menu-friends').click();
  await c.page.locator('.g2-join-code').fill(code.toLowerCase());
  await c.page.locator('.g2-join button[type=submit]').click();
  await expect(c.page).toHaveURL(new RegExp(`/r/${code}$`));
  await expect(a.page.locator('.g2-room-player')).toHaveCount(3);
  await expect(b.page.locator('.g2-room-player')).toHaveCount(3);
  // Only the host gets Kick buttons and Start.
  await expect(a.page.locator('.g2-room-kick')).toHaveCount(2);
  await expect(b.page.locator('.g2-room-kick')).toHaveCount(0);
  await expect(b.page.locator('.g2-room-start')).toHaveCount(0);
  await expect(b.page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(c.page.locator('html')).toHaveAttribute('lang', 'ru');
  for (const p of [a, b, c]) await checkLanguage(p, 'lobby');
  const ids = (await room(a, code)).players.map((p) => p.id);
  const [idA, idB, idC] = ids as [string, string, string];

  await a.page.locator('.g2-room-start').click();

  // --- round 1: everyone guesses
  for (const p of [a, b, c]) await waitForRound(p.page);
  await expect(a.page.locator('.g2-hud-round')).toHaveText('Round 1/3');
  const view = await room(a, code);
  expect(view.phase).toBe('round');
  expect(view.myGameId).toBeTruthy();
  await placeAndGuess(a);
  await expect(b.page.locator('.g2-room-tick-done')).toHaveCount(1);
  await placeAndGuess(b);
  await placeAndGuess(c);
  for (const p of [a, b, c]) {
    await expect(p.page.locator('.g2-result')).toBeVisible();
    await expect(p.page.locator('.g2-result .g2-room-table tbody tr')).toHaveCount(3);
  }
  await expect(b.page.locator('.g2-result .g2-btn-primary')).toHaveCount(0);
  for (const p of [a, b, c]) await checkLanguage(p, 'round result', '.g2-result button, .g2-result .gm-tab');
  await hostNext(a);

  // --- round 2: C leaves before guessing
  for (const p of [a, b, c]) await waitForRound(p.page);
  await expect(a.page.locator('.g2-hud-round')).toHaveText('Round 2/3');
  await c.page.close();
  await expect.poll(async () => (await room(a, code)).players.find((p) => p.id === idC)?.connected).toBe(false);
  await placeAndGuess(a);
  await placeAndGuess(b);
  await expect(a.page.locator('.g2-result')).toBeVisible();
  await expect(b.page.locator('.g2-result')).toBeVisible();
  const r2 = await room(a, code);
  expect(r2.phase).toBe('result');
  expect(r2.round).toBe(2);

  // --- C comes back (same token) and is put back into the game
  const cPage = await c.reopen();
  await cPage.goto(`/r/${code}`);
  await expect(cPage.locator('.g2-result')).toBeVisible();
  await expect.poll(async () => (await room(a, code)).players.find((p) => p.id === idC)?.connected).toBe(true);
  await hostNext(a);

  // --- round 3: everyone
  for (const p of [a, b, c]) await waitForRound(p.page);
  await expect(cPage.locator('.g2-hud-round')).toContainText('3/3');
  for (const p of [a, b, c]) await placeAndGuess(p);
  for (const p of [a, b, c]) await expect(p.page.locator('.g2-result')).toBeVisible();
  // Nobody presses Next: the room advances to the standings by itself 15 s later (real server timer).
  await expect(a.page.locator('.g2-room-next')).toContainText(/\d/);
  await expect(a.page.locator('.g2-room-over')).toBeVisible({ timeout: 25_000 });

  // --- final standings
  for (const p of [a, b, c]) {
    await expect(p.page.locator('.g2-room-over')).toBeVisible();
    await expect(p.page.locator('.g2-room-standings tbody tr')).toHaveCount(3);
    await expect(p.page.locator('.g2-room-over .g2-share-link input')).toHaveValue(/\/c\/[^/]+$/);
    await checkLanguage(p, 'standings');
  }
  const over = await room(a, code);
  expect(over.phase).toBe('over');
  const lb = await a.api<{ entries: { playerId: string; rounds: number[] }[] }>('GET', `/challenges/${over.challengeCode}/leaderboard`);
  expect(lb.body.entries.map((e) => e.playerId).sort()).toEqual([idA, idB, idC].sort());
  const cEntry = lb.body.entries.find((e) => e.playerId === idC)!;
  expect(cEntry.rounds[1]).toBe(0);

  // A friend who was not in the room plays the same 3 rounds through the challenge link and joins the board.
  const d = await players.create({ name: 'party-d' });
  await d.page.goto(`/c/${over.challengeCode}`);
  await d.page.locator('.g2-challenge-play').click();
  for (let n = 1; n <= 3; n++) {
    await waitForRound(d.page);
    await expect(d.page.locator('.g2-hud-round')).toHaveText(`Round ${n}/3`);
    await placeGuess(d.page);
    await d.page.locator('.g2-guess').click();
    await expect(d.page.locator('.g2-result')).toBeVisible();
    await d.page.locator('.g2-result .g2-btn-primary').click();
  }
  await expect(d.page.locator('.g2-summary')).toBeVisible();
  await expect(d.page.locator('.g2-lb-table tbody tr')).toHaveCount(4);
  await expect(d.page.locator('.g2-lb-me')).toHaveCount(1);

  // Back to the lobby: same code, same players, the host can start again.
  await a.page.locator('.g2-room-back').click();
  await expect(a.page.locator('.g2-room-lobby')).toBeVisible();
  await expect(a.page.locator('.g2-room-player')).toHaveCount(3);
  await expect(a.page.locator('.g2-room-start')).toBeEnabled();
});

/** Guess in a room round; the result card comes only when the room closes the round. */
async function placeAndGuess(p: Player): Promise<void> {
  await placeGuess(p.page);
  await p.page.locator('.g2-guess').click();
  await expect(p.page.locator('.g2-guess')).toBeDisabled();
}
