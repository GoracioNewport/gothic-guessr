/**
 * Challenge link (SPEC §10.1, §10.4): A plays a solo game, B opens its link in another browser context (German UI),
 * plays the same rounds, and both appear on the challenge leaderboard with each one's own row highlighted. A second
 * attempt is refused for both.
 */
import type { ChallengeView, GameView, LeaderboardView } from '../../shared/api';
import { de } from '../../src/i18n/de';
import type { Player } from '../fixtures';
import { expect, guessViaUi, horizontalOverflow, nextFromResult, overflowingControls, rawKeys, storedGame, test, waitForRound } from '../fixtures';

async function playFive(p: Player): Promise<GameView> {
  const page = p.page;
  let first: GameView | null = null;
  for (let n = 1; n <= 5; n++) {
    await waitForRound(page);
    if (n === 1) first = await storedGame(p);
    await guessViaUi(page, { world: n % 2 ? 'khorinis' : 'valley' });
    await nextFromResult(page);
  }
  await expect(page.locator('.g2-summary')).toBeVisible();
  const done = await storedGame(p);
  expect(done.id).toBe(first!.id);
  expect(done.finished).toBe(true);
  return done;
}

test('challenge link played by a second player; both on its leaderboard', async ({ players, baseURL }) => {
  const a = await players.create({ name: 'challenge-a' });
  await a.page.goto('/play');
  await a.page.locator('.g2-pill[data-mode="classic"]').click();
  await a.page.locator('.g2-start-btn').click();
  const gameA = await playFive(a);
  const link = await a.page.locator('.g2-share-link input').inputValue();
  expect(link).toBe(`${baseURL}/c/${gameA.challengeCode}`);
  const nickA = (await a.api<{ nickname: string }>('GET', '/me')).body.nickname;

  const b = await players.create({ name: 'challenge-b', lang: 'de' });
  await b.page.goto(link);
  await expect(b.page.locator('.g2-challenge-by')).toContainText(nickA);
  await expect(b.page.locator('.g2-lb-table tbody tr')).toHaveCount(1);
  expect(await rawKeys(b.page), 'de challenge page: raw keys').toEqual([]);
  expect(await overflowingControls(b.page), 'de challenge page: overflow').toEqual([]);
  await b.page.locator('.g2-challenge-play').click();
  // Same rounds: B's first start node is A's first start node.
  await waitForRound(b.page);
  const firstB = await storedGame(b);
  expect(firstB.kind).toBe('challenge');
  expect(firstB.challengeCode).toBe(gameA.challengeCode);
  expect(firstB.settings).toEqual(gameA.settings);
  const aRounds = await a.api<GameView>('GET', `/games/${gameA.id}`);
  expect(aRounds.body.results).toHaveLength(5);
  await b.page.reload();
  const gameB = await playFive(b);
  expect(gameB.results.map((r) => r.answer)).toEqual(gameA.results.map((r) => r.answer));

  // B's summary: two rows, B's highlighted (German UI).
  await expect(b.page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(b.page.locator('.g2-lb-table tbody tr')).toHaveCount(2);
  await expect(b.page.locator('.g2-lb-me')).toHaveCount(1);
  let nickB = (await b.api<{ nickname: string }>('GET', '/me')).body.nickname;
  expect(await rawKeys(b.page), 'de summary: raw keys').toEqual([]);
  expect(await overflowingControls(b.page), 'de summary: overflow').toEqual([]);
  expect(await horizontalOverflow(b.page)).toBeLessThanOrEqual(0);
  await expect(b.page.locator('.g2-lb-me .g2-lb-nick')).toHaveText(nickB);

  // A challenge's replay is a new solo game ("New game"), not "Play again" (one attempt per player).
  await expect(b.page.locator('.g2-summary-again')).toContainText(de['summary.newGame']);
  // B renames on the summary: a rejected name keeps the field open with the localized reason; an accepted one
  // (normalised by the server) shows on the leaderboard's heading line and, refetched, in its row.
  const lbHead = b.page.locator('.g2-lb-head');
  await lbHead.locator('.g2-nick-edit').click();
  await expect(lbHead.locator('.g2-nick-input')).toBeFocused();
  await lbHead.locator('.g2-nick-input').fill('Kurw4 Mać');
  await lbHead.locator('.g2-nick-input').press('Enter');
  await expect(lbHead.locator('.g2-nick-error')).toHaveText(de['error.nickname_rejected']);
  await expect(lbHead.locator('.g2-nick-input')).toHaveValue('Kurw4 Mać');
  await lbHead.locator('.g2-nick-input').fill('  Lord   Hagen ');
  await lbHead.locator('.g2-nick-input').press('Enter');
  await expect(lbHead.locator('.g2-nick-name')).toHaveText('Lord Hagen');
  await expect(b.page.locator('.g2-lb-me .g2-lb-nick')).toHaveText('Lord Hagen');
  nickB = (await b.api<{ nickname: string }>('GET', '/me')).body.nickname;
  expect(nickB).toBe('Lord Hagen');
  expect(await overflowingControls(b.page), 'de summary after rename: overflow').toEqual([]);

  // A sees both on the challenge page, A's own row highlighted, and cannot play again.
  await a.page.goto(`/c/${gameA.challengeCode}`);
  await expect(a.page.locator('.g2-lb-table tbody tr')).toHaveCount(2);
  await expect(a.page.locator('.g2-lb-me .g2-lb-nick')).toHaveText(nickA);
  await expect(a.page.locator('.g2-challenge-play')).toHaveCount(0);
  await expect(a.page.locator('.g2-lb-head .g2-nick-inline .g2-nick-name')).toHaveText(nickA);
  const names = await a.page.locator('.g2-lb-table .g2-lb-nick').allTextContents();
  expect(names.sort()).toEqual([nickA, nickB].sort());

  const board = await a.api<LeaderboardView>('GET', `/challenges/${gameA.challengeCode}/leaderboard`);
  expect(board.body.entries.map((e) => e.total).sort()).toEqual([gameA.total, gameB.total].sort());
  const view = await b.api<ChallengeView>('GET', `/challenges/${gameA.challengeCode}`);
  expect(view.body.players).toBe(2);
  for (const p of [a, b]) {
    const again = await p.api<{ error: string }>('POST', '/games', { kind: 'challenge', code: gameA.challengeCode });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_played');
  }
});
