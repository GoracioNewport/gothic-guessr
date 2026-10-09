/**
 * Duel to KO (SPEC §10.1, §10.6): A creates a room from the menu and turns it into a duel in the lobby, B joins by
 * link (Polish UI), A starts. Each round
 * A makes a perfect guess (the test knows the answer from the private manifest and sends it over REST with A's own
 * game, as the client would), B then gets the 15 s countdown: in round 1 B guesses on a wrong world through the map
 * (0 points), in round 2 B lets the countdown run out (0 points, real timers on both sides). Damage 5000 × 1 per
 * round: 6000 → 1000 → 0, KO in round 2. A sees Victory, B Defeat with the KO reason.
 */
import type { GameView, RoomView, RoundResultView } from '../../shared/api';
import type { Player } from '../fixtures';
import { answerOf, expect, horizontalOverflow, overflowingControls, placeGuess, rawKeys, test, waitForRound, WORLDS } from '../fixtures';

async function room(p: Player, code: string): Promise<RoomView> {
  const res = await p.api<RoomView>('GET', `/rooms/${code}`);
  expect(res.status).toBe(200);
  return res.body;
}

/** A's perfect guess of the open round over REST; returns the answer's world. */
async function perfectGuess(p: Player, code: string): Promise<string> {
  const gameId = (await room(p, code)).myGameId!;
  const game = await p.api<GameView>('GET', `/games/${gameId}`);
  const start = game.body.current!.start.key;
  const answer = answerOf(start);
  const res = await p.api<RoundResultView>('POST', `/games/${gameId}/guess`, { guess: answer });
  expect(res.status).toBe(200);
  // The opponent still has the round open: the server withholds answer, distance and score until the room's
  // roundResult (the HP bars show the 5000 later).
  expect(res.body.pending).toBe(true);
  expect(res.body.answer).toBeUndefined();
  return answer.world;
}

/** No raw i18n keys, no overflowing button and no horizontal scroll on the player's current screen. */
async function checkLanguage(p: Player, where: string, selector?: string): Promise<void> {
  expect(await rawKeys(p.page), `${p.name} ${where}: raw keys`).toEqual([]);
  expect(await overflowingControls(p.page, selector), `${p.name} ${where}: overflow`).toEqual([]);
  expect(await horizontalOverflow(p.page), `${p.name} ${where}: horizontal scroll`).toBeLessThanOrEqual(0);
}

test('duel to KO', async ({ players }) => {
  const a = await players.create({ name: 'duel-a' });
  const b = await players.create({ name: 'duel-b', lang: 'pl' });

  await a.page.goto('/');
  await a.page.locator('.g2-menu-friends').click();
  await a.page.locator('.g2-friends-create button').first().click();
  await expect(a.page).toHaveURL(/\/r\/[A-Z]{5}$/);
  const code = a.page.url().split('/').pop()!;
  await expect(a.page.locator('.g2-room-lobby')).toBeVisible();
  // A new room is a normal one; the host picks the duel in the lobby and the rules block follows.
  expect((await room(a, code)).type).toBe('party');
  await a.page.locator('.g2-pill:has(input[data-focus="type:duel"])').click();
  await expect.poll(async () => (await room(a, code)).type).toBe('duel');
  await expect(a.page.locator('.g2-room-rules')).toContainText('6,000');
  // A duel needs exactly two players.
  await expect(a.page.locator('.g2-room-start')).toBeDisabled();
  await b.page.goto(`/r/${code}`);
  await expect(a.page.locator('.g2-room-player')).toHaveCount(2);
  await expect(a.page.locator('.g2-room-start')).toBeEnabled();
  for (const p of [a, b]) await checkLanguage(p, 'lobby');
  const lobby = await room(a, code);
  expect(lobby.type).toBe('duel');
  expect(lobby.capacity).toBe(2);
  const idB = lobby.players.find((p) => !p.host)!.id;
  await a.page.locator('.g2-room-start').click();

  for (let n = 1; n <= 2; n++) {
    await waitForRound(a.page);
    await waitForRound(b.page);
    await expect(a.page.locator('.g2-hud-slot .g2-duel')).toBeVisible();
    await expect(b.page.locator('.g2-hud-slot .g2-hp-bar')).toHaveCount(2);
    if (n === 1) await checkLanguage(b, 'duel round', '.g2-hud button, .g2-guess, .g2-countdown, .g2-duel');
    // No base limit: the round runs against the 5 min hard cap until the first guess.
    await expect(b.page.locator('.g2-countdown-value')).toHaveText(/^[45]:\d\d$/);
    const world = await perfectGuess(a, code);
    // B now has 15 s.
    await expect(b.page.locator('.g2-countdown-value')).toHaveText(/^0:(0\d|1[0-5])$/);
    if (n === 1) {
      await placeGuess(b.page, { world: WORLDS.find((w) => w !== world)! });
      await b.page.locator('.g2-guess').click();
    } else {
      // Round 2: B does not guess; the 15 s run out (client sends no guess, server closes after the grace).
      await expect(b.page.locator('.g2-countdown')).toHaveAttribute('data-level', 'urgent', { timeout: 15_000 });
    }
    for (const p of [a, b]) await expect(p.page.locator('.g2-result')).toBeVisible({ timeout: 25_000 });
    if (n === 2) await expect(b.page.locator('.g2-result .g2-wrong-world')).toHaveText('Koniec czasu');
    const after = await room(a, code);
    expect(after.players.find((p) => p.id === idB)!.hp).toBe(n === 1 ? 1000 : 0);
    await expect(b.page.locator('.g2-result .g2-duel-damage').first()).toBeVisible();
    await a.page.locator('.g2-result .g2-btn-primary').click();
  }

  await expect(a.page.locator('.g2-duel-banner-win')).toBeVisible();
  await expect(a.page.locator('.g2-duel-banner-reason')).toContainText('Knocked out!');
  await expect(b.page.locator('.g2-duel-banner-lose')).toBeVisible();
  await expect(b.page.locator('.g2-room-standings tbody tr')).toHaveCount(2);
  await expect(b.page.locator('.g2-duel-banner-title')).toHaveText('Porażka');
  for (const p of [a, b]) await checkLanguage(p, 'duel standings');
  const over = await room(a, code);
  expect(over.phase).toBe('over');
  // The challenge is cut to the 2 rounds played.
  const ch = await a.api<{ settings: { rounds: number } }>('GET', `/challenges/${over.challengeCode}`);
  expect(ch.status).toBe(200);
  expect(ch.body.settings.rounds).toBe(2);
});
