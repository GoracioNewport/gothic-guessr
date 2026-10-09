/**
 * Language selector (SPEC §10.1, §10.8): a small radio group of the four languages, each shown by its
 * own name ("English", "Deutsch", "Polski", "Русский") with a `lang` attribute, so `:lang(ru)` /
 * `:lang(pl)` in style.css render that name in the fallback font even inside an English or German UI.
 *
 * Picking a language calls `setLanguage`, which persists the choice and notifies `onLanguageChange`
 * subscribers (the screens re-render). The component also follows changes made elsewhere (checked
 * radio, group label). Call `destroy()` when the element is discarded to drop that subscription.
 *
 * Usage: `const sel = createLangSelect(); parent.appendChild(sel.root); … sel.destroy();`
 * Pass `{ corner: true }` to pin it to the top-right corner of a positioned ancestor.
 */
import type { Lang } from '../i18n';
import { LANGS, getLanguage, onLanguageChange, setLanguage, t, translate } from '../i18n';

export interface LangSelectOptions {
  /** Pin to the top-right corner of the nearest positioned ancestor (the stage-2 start screen). */
  corner?: boolean;
  /** Extra class names for the root. */
  className?: string;
  /** Called after the player picks a language (after `setLanguage`). */
  onChange?: (lang: Lang) => void;
}

export interface LangSelect {
  root: HTMLElement;
  /** Re-sync the checked radio and the labels with the active language. */
  update(): void;
  destroy(): void;
}

const STYLE_ID = 'g2-lang-style';
const STYLES = `
.g2-lang { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 2px;
  background: var(--g2-row, rgba(0,0,0,.38)); border: 1px solid var(--g2-gold-faint, rgba(201,164,76,.18)); }
.g2-lang-corner { position: absolute; top: 10px; right: 12px; z-index: 5; }
.g2-lang-option { position: relative; display: inline-flex; align-items: center; padding: 1px 8px;
  font-family: var(--g2-font-display, serif); font-size: var(--g2-size-small, 15px); line-height: 1.3;
  color: var(--g2-gold-dim, #8a7140); text-shadow: var(--g2-text-shadow, none); cursor: pointer;
  user-select: none; border: 1px solid transparent; transition: color .12s; }
.g2-lang-option:hover { color: var(--g2-gold, #c9a44c); }
.g2-lang-option.g2-lang-active { color: var(--g2-gold-bright, #f3d68a); border-color: var(--g2-gold-line, rgba(201,164,76,.45));
  text-shadow: var(--g2-text-shadow, none), var(--g2-glow, none); }
.g2-lang-input { position: absolute; width: 1px; height: 1px; margin: 0; padding: 0; opacity: 0; pointer-events: none; }
.g2-lang-option:has(.g2-lang-input:focus-visible) { outline: 1px solid var(--g2-gold-bright, #f3d68a); outline-offset: 1px; }
`;

function injectStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

let instances = 0;

export function createLangSelect(options: LangSelectOptions = {}): LangSelect {
  injectStyles();
  const name = `g2-lang-${++instances}`;
  const root = document.createElement('div');
  root.className = ['g2-lang', options.corner ? 'g2-lang-corner' : '', options.className ?? ''].filter(Boolean).join(' ');
  root.setAttribute('role', 'radiogroup');

  const inputs = new Map<Lang, { label: HTMLLabelElement; input: HTMLInputElement }>();
  for (const lang of LANGS) {
    const label = document.createElement('label');
    label.className = 'g2-lang-option';
    label.lang = lang;
    label.dataset.lang = lang;
    const input = document.createElement('input');
    input.className = 'g2-lang-input';
    input.type = 'radio';
    input.name = name;
    input.value = lang;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      setLanguage(lang);
      options.onChange?.(lang);
    });
    const text = document.createElement('span');
    // Each language by its own name, whatever the UI language is.
    text.textContent = translate(lang, `lang.${lang}`);
    label.append(input, text);
    root.appendChild(label);
    inputs.set(lang, { label, input });
  }

  const update = (): void => {
    const active = getLanguage();
    root.setAttribute('aria-label', t('lang.label'));
    root.title = t('lang.label');
    for (const [lang, { label, input }] of inputs) {
      input.checked = lang === active;
      label.classList.toggle('g2-lang-active', lang === active);
    }
  };
  update();
  const unsubscribe = onLanguageChange(update);

  return {
    root,
    update,
    destroy(): void {
      unsubscribe();
    },
  };
}
