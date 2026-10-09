/**
 * Randomness and hashing on top of Web Crypto (`globalThis.crypto`), which exists in Node ≥ 19 and in Workers, so this
 * module stays free of `node:*` imports. Also: challenge/room codes, ids, tokens, the daily seed (SPEC §10.5).
 */
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../shared/api';

/** Unambiguous lowercase alphabet for challenge codes and ids (no 0/o, 1/l/i). */
export const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
/** Room codes: 5 uppercase letters without I and O (SPEC §10.6); shared with the client's join box. */
export const ROOM_ALPHABET = ROOM_CODE_ALPHABET;
export const CHALLENGE_CODE_LENGTH = 8;
export { ROOM_CODE_LENGTH };

/** Uniform random string over `alphabet` (rejection sampling, no modulo bias). */
export function randomString(alphabet: string, length: number): string {
  const n = alphabet.length;
  if (n < 2 || n > 256) throw new Error('random: alphabet size must be 2..256');
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b >= limit) continue;
      out += alphabet[b % n];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Random challenge code, e.g. `k7m2xq9d` (share link `/c/<code>`). */
export function challengeCode(): string {
  return randomString(CODE_ALPHABET, CHALLENGE_CODE_LENGTH);
}

/** Random room code, e.g. `QWHTR` (share link `/r/<CODE>`). */
export function roomCode(): string {
  return randomString(ROOM_ALPHABET, ROOM_CODE_LENGTH);
}

/** Random id for players and games (12 chars, ~59 bits). */
export function randomId(): string {
  return randomString(CODE_ALPHABET, 12);
}

/** Random device token (32 bytes, base64url). Stored only as its SHA-256 hash. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Random 32-bit unsigned seed in [1, 2^32 − 1]. */
export function randomSeed(): number {
  const v = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return v === 0 ? 1 : v;
}

/** Random integer in [0, n). */
export function randomInt(n: number): number {
  const v = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return Math.floor((v / 0x100000000) * n);
}

/** Hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

/** Raw HMAC-SHA256 of `message` with `secret` (both UTF-8). */
export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/**
 * The daily seed (SPEC §10.5): `HMAC(SERVER_SECRET, 'daily:' + date)` truncated to its first 32 bits (big-endian).
 * A zero result is mapped to 1 so every seed is a valid {@link randomSeed}-style value.
 */
export async function dailySeed(secret: string, date: string): Promise<number> {
  const mac = await hmacSha256(secret, `daily:${date}`);
  const v = ((mac[0]! << 24) | (mac[1]! << 16) | (mac[2]! << 8) | mac[3]!) >>> 0;
  return v === 0 ? 1 : v;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
