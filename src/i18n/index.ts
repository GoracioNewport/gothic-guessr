/**
 * Client internationalisation (SPEC §10.1 "Languages", §10.8).
 *
 * - `t(key, params?)` looks a message up in the active dictionary and fills `{name}` placeholders.
 *   Plural messages (objects of `Intl.PluralRules` categories) pick their form by `params.count`;
 *   `tp(key, count, params?)` is the shorthand. A plural `{count}` placeholder is formatted with
 *   `formatNumber` unless `params.count` is already a string.
 * - `formatNumber`, `formatDistance`, `formatDuration`, `formatDate` use `Intl` with the active locale.
 * - `detectLanguage()`: a stored choice (`localStorage['gothic2guessr.lang']`) wins, else the first of
 *   `navigator.languages` whose primary subtag is supported, else English.
 * - `initLanguage()` applies the detected language at boot (no notification); `setLanguage(lang)`
 *   persists the choice, updates `<html lang>` and notifies `onLanguageChange` subscribers, which
 *   re-render the current screen.
 *
 * The active language starts as English, so modules and tests that never call `initLanguage` /
 * `setLanguage` see English text. Format details and how to add keys: docs/I18N.md.
 */
import { LANGS } from '../../shared/api';
import type { Lang } from '../../shared/api';
import { de } from './de';
import { en } from './en';
import { pl } from './pl';
import { ru } from './ru';
import type { Dictionary, MessageKey, MessageParams, PluralForms, PluralKey } from './types';

export type { Lang } from '../../shared/api';
export { LANGS } from '../../shared/api';
export type { Dictionary, MessageKey, MessageParams, PluralForms, PluralKey, StringKey } from './types';

/** localStorage key of the player's explicit language choice. */
export const LANG_STORAGE_KEY = 'gothic2guessr.lang';
export const DEFAULT_LANG: Lang = 'en';

/** Every dictionary by language (exported for tests and tooling). */
export const DICTIONARIES: Readonly<Record<Lang, Dictionary>> = { en, de, pl, ru };

/** BCP 47 locale used for `Intl` formatting per language. */
const LOCALES: Readonly<Record<Lang, string>> = { en: 'en', de: 'de', pl: 'pl', ru: 'ru' };

let current: Lang = DEFAULT_LANG;
const listeners = new Set<(lang: Lang) => void>();
const pluralRules = new Map<Lang, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

// ---------------------------------------------------------------------------------------------
// Language state
// ---------------------------------------------------------------------------------------------

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** The active language. */
export function getLanguage(): Lang {
  return current;
}

/** The `Intl` locale of the active language. */
export function getLocale(): string {
  return LOCALES[current];
}

/** The stored explicit choice, or null (absent, invalid, or storage unavailable). */
export function readStoredLanguage(): Lang | null {
  try {
    const raw = globalThis.localStorage?.getItem(LANG_STORAGE_KEY);
    return isLang(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** First supported primary subtag of `languages` ("ru-RU" → ru, "pt-BR" skipped), or null. */
export function languageFromList(languages: readonly string[]): Lang | null {
  for (const tag of languages) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLang(primary)) return primary;
  }
  return null;
}

/** The browser's preferred languages (`navigator.languages`, else `navigator.language`), guarded. */
function browserLanguages(): readonly string[] {
  try {
    const nav = globalThis.navigator;
    if (!nav) return [];
    if (Array.isArray(nav.languages) && nav.languages.length > 0) return nav.languages;
    return nav.language ? [nav.language] : [];
  } catch {
    return [];
  }
}

/**
 * The language to use (SPEC §10.1): the stored choice, else the first of `navigator.languages`
 * whose primary subtag is supported, else English. `env` overrides the sources (tests).
 */
export function detectLanguage(env: { stored?: string | null; languages?: readonly string[] } = {}): Lang {
  const stored = 'stored' in env ? (isLang(env.stored) ? env.stored : null) : readStoredLanguage();
  if (stored) return stored;
  return languageFromList(env.languages ?? browserLanguages()) ?? DEFAULT_LANG;
}

/** Point `<html lang>` at `lang` (CSS `:lang()` switches the font for pl/ru). */
function applyDocumentLang(lang: Lang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/** Boot: apply the detected language without notifying anyone (nothing is rendered yet). */
export function initLanguage(): Lang {
  current = detectLanguage();
  applyDocumentLang(current);
  return current;
}

/**
 * Switch to `lang`: remember it (localStorage, guarded), update `<html lang>` and notify the
 * subscribers so the current screen re-renders. `persist: false` skips storage (tests, previews).
 */
export function setLanguage(lang: Lang, options: { persist?: boolean } = {}): void {
  if (!isLang(lang)) return;
  if (options.persist !== false) {
    try {
      globalThis.localStorage?.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      /* private mode or quota: the choice lasts for this page only */
    }
  }
  const changed = lang !== current;
  current = lang;
  applyDocumentLang(lang);
  if (!changed) return;
  for (const fn of [...listeners]) {
    try {
      fn(lang);
    } catch (err) {
      console.error(err);
    }
  }
}

/** Subscribe to language switches; returns the unsubscribe function. */
export function onLanguageChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

function rulesFor(lang: Lang): Intl.PluralRules {
  let rules = pluralRules.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(LOCALES[lang]);
    pluralRules.set(lang, rules);
  }
  return rules;
}

/** The plural category of `count` in `lang` (default: the active language). */
export function pluralCategory(count: number, lang: Lang = current): Intl.LDMLPluralRule {
  return rulesFor(lang).select(count);
}

/** Pick the form of `forms` for `count` in `lang`, falling back to `other`. */
export function selectPlural(forms: PluralForms, count: number, lang: Lang = current): string {
  return forms[pluralCategory(count, lang)] ?? forms.other;
}

/** Replace `{name}` placeholders; unknown placeholders stay as they are (visible in QA). */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Resolve a message in a specific language (the selector shows each language's own name). */
export function translate(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const entry: string | PluralForms | undefined = DICTIONARIES[lang][key] ?? DICTIONARIES.en[key];
  if (entry === undefined) return key;
  if (typeof entry === 'string') return interpolate(entry, params);
  const raw = params?.count;
  const count = typeof raw === 'number' ? raw : Number(raw ?? 0);
  const filled: MessageParams =
    typeof raw === 'string' ? params ?? {} : { ...params, count: formatNumberIn(lang, Number.isFinite(count) ? count : 0) };
  return interpolate(selectPlural(entry, Number.isFinite(count) ? count : 0, lang), filled);
}

/** The message `key` in the active language with `params` filled in. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

/** A plural message for `count` (shorthand for `t(key, { ...params, count })`). */
export function tp(key: PluralKey, count: number, params?: MessageParams): string {
  return translate(current, key, { ...params, count });
}

/** True when `key` is a message key (for keys built at run time, e.g. `world.<slug>`). */
export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(DICTIONARIES.en, key);
}

/** Localized world name for `slug`, else `fallback` (the name from worlds.json), else the slug. */
export function worldName(slug: string, fallback?: string): string {
  const key = `world.${slug}`;
  return hasMessage(key) ? t(key) : fallback ?? slug;
}

/** Localized world description for `slug`, else `fallback`. */
export function worldDescription(slug: string, fallback?: string): string | undefined {
  const key = `world.${slug}.desc`;
  return hasMessage(key) ? t(key) : fallback;
}

/** Localized text of a server error code (`error.<code>`), or the generic message for unknown codes. */
export function errorMessage(code: string): string {
  const key = `error.${code}`;
  return hasMessage(key) ? t(key) : t('error.unknown');
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const id = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(id);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(id, format);
  }
  return format;
}

function formatNumberIn(lang: Lang, n: number, options: Intl.NumberFormatOptions = {}): string {
  return numberFormat(LOCALES[lang], options).format(n);
}

/** A number with the active locale's grouping and decimal separator ("18,450", "18.450", "18 450"). */
export function formatNumber(n: number, options: Intl.NumberFormatOptions = {}): string {
  return formatNumberIn(current, n, options);
}

/** A distance in metres with one decimal ("12.3 m", "12,3 m", "12,3 м"). */
export function formatDistance(metres: number): string {
  return formatNumber(metres, {
    style: 'unit',
    unit: 'meter',
    unitDisplay: 'short',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** A duration as `m:ss` (or `h:mm:ss`), for countdowns and leaderboard times; digits are locale-neutral. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A per-round time limit option: "No limit", "30 s", "2 min". */
export function formatTimeLimit(seconds: number): string {
  if (seconds <= 0) return t('time.off');
  if (seconds % 60 === 0) return t('time.minutesShort', { count: formatNumber(seconds / 60) });
  return t('time.secondsShort', { count: formatNumber(seconds) });
}

/** A calendar date (e.g. the daily's `YYYY-MM-DD`, read as UTC) in the active locale. */
export function formatDate(date: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: 'long' }): string {
  const value =
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : new Date(date);
  const opts = typeof date === 'string' ? { timeZone: 'UTC', ...options } : options;
  return new Intl.DateTimeFormat(getLocale(), opts).format(value);
}
