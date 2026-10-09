/**
 * Small DOM helpers shared by the screens and pages (plain DOM, Gothic look of SPEC §9.6; styles in style.css).
 */
import type { PublicSettings } from '../../shared/api';
import { formatNumber, formatTimeLimit, getLanguage, t, tp, worldName } from '../i18n';
import type { Lang } from '../i18n';

/** Best possible score of one round (SPEC §5); score bars are scaled to rounds × this. */
export const ROUND_MAX_SCORE = 5000;

/** Create an element with optional class names and text content. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Characters of a nickname the active language's game fonts draw (docs/FONTS.md), as a regex character class body.
 * The English and German UI use the Latin-1 atlases. The Polish ones are cp1250 (ĄĆĘŁŃŚŹŻ ąćęłńśźż, Šš Žž) and
 * redraw Latin-1 in the same design, so the few Latin-1 letters cp1250 lacks (Ñ, Æ, …) come from the English font
 * behind them in the CSS stack without a visible seam. The Russian ones are cp1251 in a heavier design of their
 * own: ASCII and Cyrillic only, so "José" goes to the fallback instead of mixing two designs.
 */
const GAME_FONT_CHARS: Record<Lang, string> = {
  en: '\u0000-\u00ff',
  de: '\u0000-\u00ff',
  pl: '\u0000-\u00ff\u0104-\u0107\u0118\u0119\u0141-\u0144\u015a\u015b\u0160\u0161\u0179-\u017e',
  ru: '\u0000-\u007f\u0401\u0410-\u044f\u0451',
};

/**
 * Prepare an element holding a player's nickname (user text in any script): `dir=auto`, and a nickname with
 * letters the active language's game fonts lack (Ł or Ж in an English UI, Ł in a Russian one, Ж in a Polish one)
 * is set wholly in the fallback font (`.g2-ext-script`), so a word never mixes two fonts (SPEC §10.8). Screens
 * are rebuilt on a language change, so the check follows the language.
 */
export function nicknameEl<T extends HTMLElement>(node: T): T {
  node.dir = 'auto';
  if (new RegExp(`[^${GAME_FONT_CHARS[getLanguage()]}]`).test(node.textContent ?? '')) node.classList.add('g2-ext-script');
  return node;
}

/** Visible name of a shortcut key; `aria-keyshortcuts` keeps the standard name. */
export function keyLabel(key: string): string {
  if (key === 'Enter') return t('key.enter');
  if (key === 'Space') return t('key.space');
  return key;
}

/** A button whose label is followed by a small keyboard hint, e.g. "Guess  [Space]". */
export function keyButton(className: string, label: string, key?: string): HTMLButtonElement {
  const btn = el('button', className);
  btn.type = 'button';
  btn.appendChild(el('span', undefined, label));
  btn.setAttribute('aria-label', label);
  if (key) {
    btn.appendChild(el('kbd', 'g2-kbd', keyLabel(key)));
    btn.setAttribute('aria-keyshortcuts', key);
  }
  return btn;
}

/** A plain Gothic button. */
export function button(label: string, className = 'g2-btn g2-btn-secondary', onClick?: () => void): HTMLButtonElement {
  const btn = el('button', className, label);
  btn.type = 'button';
  if (onClick) {
    btn.addEventListener('click', () => {
      btn.blur();
      onClick();
    });
  }
  return btn;
}

export const formatScore = (n: number): string => formatNumber(n);

/** A Gothic HUD bar (BAR_BACK frame, BAR_MISC fill) showing `score / max`. */
export function scoreBar(max: number, score: number): { root: HTMLElement; set(score: number): void } {
  const root = el('div', 'g2-bar');
  root.setAttribute('role', 'meter');
  root.setAttribute('aria-label', t('round.score'));
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', String(max));
  const fill = el('div', 'g2-bar-fill');
  root.appendChild(fill);
  const set = (value: number): void => {
    const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    root.setAttribute('aria-valuenow', String(value));
  };
  set(score);
  return { root, set };
}

/** True when the key event comes from an editable text field, where shortcuts must not fire. */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) {
    if (['checkbox', 'radio', 'button', 'submit'].includes(target.type)) return false;
    return !target.readOnly;
  }
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  return target.isContentEditable;
}

export function hasModifier(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}

export const isConfirmKey = (e: KeyboardEvent): boolean => e.code === 'Space' || e.key === 'Enter';

/** True when the event targets a control that uses Space itself (checkbox, radio, button, language selector). */
export function isOwnSpaceTarget(e: KeyboardEvent): boolean {
  const target = e.target;
  if (!(target instanceof Element)) return false;
  if (target.closest('.g2-lang')) return true;
  if (target instanceof HTMLInputElement) return target.type === 'checkbox' || target.type === 'radio';
  return target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || target.tagName === 'SUMMARY';
}

/** Copy `text` to the clipboard; falls back to selecting `fallback` and `execCommand('copy')`. */
export async function copyText(text: string, fallback?: HTMLInputElement | HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!fallback) return false;
    fallback.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      fallback.blur();
    }
  }
}

/** A copy button for `source` that flashes "Copied" / "Copy failed". */
export function copyButton(label: string, source: () => string, fallback?: HTMLInputElement | HTMLTextAreaElement): HTMLButtonElement {
  const btn = button(label);
  btn.classList.add('g2-copy');
  btn.addEventListener('click', () => {
    void copyText(source(), fallback).then((ok) => {
      btn.textContent = ok ? t('share.copied') : t('share.copyFailed');
      window.setTimeout(() => (btn.textContent = label), 1500);
    });
  });
  return btn;
}

/** A read-only text field (link or share text) with a copy button, as one row. */
export function copyField(value: string, opts: { label: string; multiline?: boolean; className?: string }): HTMLElement {
  const row = el('div', `g2-copy-row${opts.className ? ` ${opts.className}` : ''}`);
  const field = opts.multiline ? el('textarea', 'g2-input g2-share-text') : el('input', 'g2-input g2-link');
  if (field instanceof HTMLInputElement) field.type = 'text';
  else field.rows = Math.max(2, value.split('\n').length);
  field.readOnly = true;
  field.value = value;
  field.spellcheck = false;
  field.addEventListener('focus', () => field.select());
  row.append(field, copyButton(opts.label, () => field.value, field));
  return row;
}

/** A transient message at the bottom of the screen (errors that do not replace the screen). */
export function toast(message: string, kind: 'error' | 'info' = 'error', ms = 3500): void {
  const host = document.querySelector('.g2-root') ?? document.body;
  host.querySelector('.g2-toast')?.remove();
  const box = el('div', `g2-toast g2-toast-${kind}`, message);
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  host.appendChild(box);
  window.setTimeout(() => box.remove(), ms);
}

/** "Khorinis, Valley of Mines" or "All worlds". */
export function worldsLabel(worlds: readonly string[], allSlugs: readonly string[]): string {
  if (allSlugs.length > 1 && allSlugs.every((s) => worlds.includes(s))) return t('settings.allWorlds');
  return worlds.map((slug) => worldName(slug)).join(', ');
}

/** A definition list of a game's settings (challenge and daily pages). */
export function settingsList(settings: PublicSettings, allSlugs: readonly string[]): HTMLElement {
  const dl = el('dl', 'g2-settings');
  const row = (label: string, value: string): void => {
    dl.append(el('dt', undefined, label), el('dd', undefined, value));
  };
  row(t('settings.worlds'), worldsLabel(settings.worlds, allSlugs));
  row(t('settings.mode'), t(`mode.${settings.mode}`));
  const restrictions = [settings.noMove ? t('start.noMove') : '', settings.noLook ? t('start.noLook') : ''].filter(Boolean);
  row(t('settings.restrictions'), restrictions.length ? restrictions.join(', ') : t('settings.none'));
  row(t('settings.timeLimit'), formatTimeLimit(settings.timeLimit));
  row(t('settings.rounds'), tp('settings.roundsCount', settings.rounds));
  return dl;
}

/**
 * The same settings on one line (daily and challenge pages, which must fit 1280×720 with a leaderboard):
 * "All worlds · Mixed · No move · Time limit 2 min · 5 rounds". Self-explaining values go without their label;
 * no restrictions → left out. `extra` items (e.g. the player count) are appended.
 */
export function settingsLine(settings: PublicSettings, allSlugs: readonly string[], extra: readonly string[] = []): HTMLElement {
  const items = [worldsLabel(settings.worlds, allSlugs), t(`mode.${settings.mode}`)];
  if (settings.noMove) items.push(t('start.noMove'));
  if (settings.noLook) items.push(t('start.noLook'));
  items.push(`${t('settings.timeLimit')}: ${formatTimeLimit(settings.timeLimit)}`);
  items.push(tp('settings.roundsCount', settings.rounds));
  const line = el('p', 'g2-settings-line');
  [...items, ...extra].forEach((text, i) => {
    if (i > 0) line.appendChild(el('span', 'g2-settings-sep', ' · '));
    line.appendChild(el('span', 'g2-settings-item', text));
  });
  return line;
}

/** Painted in-game maps (SPEC §9.6) used as world thumbnails. */
const UI_BASE = '/ui/gothic';
export const WORLD_MAP_ART: Record<string, string> = {
  khorinis: `${UI_BASE}/MAP_NEWWORLD_THUMB.webp`,
  valley: `${UI_BASE}/MAP_OLDWORLD_THUMB.webp`,
  jharkendar: `${UI_BASE}/MAP_ADDONWORLD_THUMB.webp`,
};

/** The Gothic logo block. */
export function logo(): HTMLElement {
  const node = el('div', 'g2-logo');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', t('app.logoAlt'));
  return node;
}
