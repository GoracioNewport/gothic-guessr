/**
 * Anonymous players (SPEC §10.1): a random device token (stored only as SHA-256) plus a nickname. Pure over the
 * {@link Repository}. The rooms module authenticates WebSocket tokens with {@link PlayerService.authenticate}.
 */
import type { Lang, PlayerView } from '../../shared/api';
import { ApiFailure } from './errors';
import { checkNickname, defaultNickname } from './nickname';
import { randomId, randomInt, randomToken, sha256Hex } from './random';
import type { PlayerRecord, Repository } from './repository';

/** `lastSeenAt` is written at most this often per player. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export class PlayerService {
  constructor(
    private readonly repo: Repository,
    private readonly clock: () => number,
  ) {}

  async create(lang?: Lang): Promise<{ token: string; player: PlayerRecord }> {
    const token = randomToken();
    const now = this.clock();
    const player: PlayerRecord = {
      id: randomId(),
      tokenHash: await sha256Hex(token),
      nickname: defaultNickname(randomInt, lang),
      banned: false,
      createdAt: now,
      lastSeenAt: now,
    };
    await this.repo.insertPlayer(player);
    return { token, player };
  }

  /** Player of a device token, or null for an unknown/malformed one. Updates `lastSeenAt` (throttled). */
  async authenticate(token: string | null | undefined): Promise<PlayerRecord | null> {
    if (!token || token.length < 16 || token.length > 128) return null;
    const player = await this.repo.getPlayerByTokenHash(await sha256Hex(token));
    if (!player) return null;
    const now = this.clock();
    if (now - player.lastSeenAt >= TOUCH_INTERVAL_MS) {
      await this.repo.touchPlayer(player.id, now);
      player.lastSeenAt = now;
    }
    return player;
  }

  /** Change the nickname: `bad_request` for length/charset, `nickname_rejected` for the filter (incl. blocklist). */
  async rename(player: PlayerRecord, raw: unknown): Promise<PlayerRecord> {
    const check = checkNickname(raw, await this.repo.listBlockedWords());
    if (!check.ok) {
      throw new ApiFailure(check.reason === 'blocked' ? 'nickname_rejected' : 'bad_request', `nickname: ${check.reason}`);
    }
    if (check.nickname !== player.nickname) await this.repo.updateNickname(player.id, check.nickname);
    return { ...player, nickname: check.nickname };
  }

  /** Admin: reset to a fresh default nickname. */
  async resetNickname(playerId: string): Promise<string> {
    const nickname = defaultNickname(randomInt);
    await this.repo.updateNickname(playerId, nickname);
    return nickname;
  }
}

export function playerView(p: PlayerRecord): PlayerView {
  return { id: p.id, nickname: p.nickname, banned: p.banned, createdAt: p.createdAt };
}
