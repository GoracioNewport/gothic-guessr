/**
 * Nickname rules (SPEC §10.1, §10.9). Pure.
 *
 * 2–24 characters (code points, after normalisation): letters of any script, digits, space, `_`, `-`, `.`; trimmed,
 * inner whitespace collapsed to one space, NFC. Offensive names are rejected by {@link findProfanity}.
 *
 * Refused as `format` too: default-ignorable code points (Hangul fillers U+115F/U+1160/U+3164/U+FFA0 are letters by
 * category but render blank, and would make a name look empty or split a word past the filter; also joiners and
 * variation selectors), and more than {@link MAX_MARK_RUN} combining marks on one base (zalgo text).
 */
import type { Lang } from '../../shared/api';
import { findProfanity } from './profanity';

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 24;

const ALLOWED = /^[\p{L}\p{M}\p{Nd} _.\-]+$/u;
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
/** Combining marks allowed in a row after NFC (Vietnamese and Indic names need two or three). */
export const MAX_MARK_RUN = 3;
const MARK_RUN = new RegExp(`\\p{M}{${MAX_MARK_RUN + 1},}`, 'u');

export type NicknameCheck =
  | { ok: true; nickname: string }
  /** `format`: length/charset (→ `bad_request`); `blocked`: profanity filter (→ `nickname_rejected`). */
  | { ok: false; reason: 'format' | 'blocked' };

/** Trim, collapse inner whitespace, NFC. */
export function normaliseNickname(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** Validate and normalise a nickname typed by a player; `blocklist` = the admin's extra words. */
export function checkNickname(raw: unknown, blocklist: readonly string[] = []): NicknameCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'format' };
  const nickname = normaliseNickname(raw);
  const length = [...nickname].length;
  if (length < NICKNAME_MIN || length > NICKNAME_MAX || !ALLOWED.test(nickname)) return { ok: false, reason: 'format' };
  if (INVISIBLE.test(nickname) || MARK_RUN.test(nickname)) return { ok: false, reason: 'format' };
  if (!/[\p{L}\p{Nd}]/u.test(nickname)) return { ok: false, reason: 'format' };
  if (findProfanity(nickname, blocklist) !== null) return { ok: false, reason: 'blocked' };
  return { ok: true, nickname };
}

/** The game's hero has no name: the default nickname is his title in the player's language. */
export const DEFAULT_NICKNAME_BASE: Readonly<Record<Lang, string>> = {
  en: 'Nameless Hero',
  de: 'Namenloser Held',
  pl: 'Bezimienny',
  ru: 'Безымянный герой',
};

/** Default nickname of a new player: the hero's title + 4 digits (`Nameless Hero 0427`); unknown language = English. */
export function defaultNickname(random: (n: number) => number, lang: Lang = 'en'): string {
  const base = DEFAULT_NICKNAME_BASE[lang] ?? DEFAULT_NICKNAME_BASE.en;
  return `${base} ${String(random(10_000)).padStart(4, '0')}`;
}
