/**
 * Dev page: compare stroke weights of the text font (Gothic Default / RU / PL) side by side, with the real UI strings.
 * Variants are built by `tools/build_webfont.py --level N --out-dir public/ui/gothic/fonts-cmp/lN` (docs/FONTS.md
 * "Stroke weight of the text fonts"). Open http://localhost:5173/dev/fontweight.html with `npm run dev`.
 */
import { de } from '../src/i18n/de';
import { en } from '../src/i18n/en';
import { pl } from '../src/i18n/pl';
import { ru } from '../src/i18n/ru';

type Lang = 'en' | 'de' | 'pl' | 'ru';
const DICTS = { en, de, pl, ru } as Record<Lang, Record<string, string>>;
const LEVELS = [127, 159, 191, 223, 255, 287];
/** What tools/build_webfont.py ships now (TEXT_LEVEL / TEXT_LEVEL_LANG). */
const CURRENT: Record<Lang, number> = { en: 255, de: 255, pl: 255, ru: 255 };
const FILE: Record<Lang, string> = { en: 'GothicDefault', de: 'GothicDefault', pl: 'GothicDefaultPL', ru: 'GothicDefaultRU' };

const grid = document.getElementById('grid') as HTMLElement;
const langSel = document.getElementById('lang') as HTMLSelectElement;
const size = document.getElementById('size') as HTMLInputElement;
const sizeVal = document.getElementById('sizeVal') as HTMLElement;
const art = document.getElementById('art') as HTMLInputElement;

const params = new URLSearchParams(location.search);
langSel.value = (params.get('lang') as Lang) ?? 'ru';
size.value = params.get('size') ?? '15';
let picked = Number(params.get('pick')) || null;

// One @font-face per level and file, named "W<level> <file>".
const css: string[] = [];
for (const lv of LEVELS) {
  for (const file of new Set(Object.values(FILE))) {
    css.push(`@font-face{font-family:"W${lv} ${file}";src:url("/ui/gothic/fonts-cmp/l${lv}/${file}.woff2") format("woff2");font-display:block}`);
  }
}
for (const [family, file] of [['Gothic Old', 'GothicOld'], ['Gothic Old RU', 'GothicOldRU'], ['Gothic Old PL', 'GothicOldPL']]) {
  css.push(`@font-face{font-family:"${family}";src:url("/ui/gothic/fonts/${file}.woff2") format("woff2");font-display:block}`);
}
const style = document.createElement('style');
style.textContent = css.join('\n');
document.head.appendChild(style);

function fill(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function render(): void {
  const lang = langSel.value as Lang;
  const d = DICTS[lang];
  document.documentElement.lang = lang;
  sizeVal.textContent = `${size.value} px`;
  document.body.classList.toggle('art', art.checked);
  const url = new URL(location.href);
  url.searchParams.set('lang', lang);
  url.searchParams.set('size', size.value);
  if (picked) url.searchParams.set('pick', String(picked));
  history.replaceState(null, '', url);

  grid.replaceChildren();
  for (const lv of LEVELS) {
    const card = el('div', 'card');
    if (lv === CURRENT[lang]) card.classList.add('current');
    if (lv === picked) card.classList.add('picked');
    const perSide = Math.max(0, Math.floor((lv - 127) / 32));
    const meta = el('div', 'meta');
    const left = el('span');
    left.innerHTML = `level <b>${lv}</b>`;
    meta.append(left, el('span', '', perSide === 0 ? 'game pixel width' : `−${perSide}/8 px per side`));
    const body = el('div', 'sample');
    body.style.fontFamily = `"W${lv} ${FILE[lang]}", serif`;
    body.style.fontSize = `${size.value}px`;
    const btn = el('div', 'menu-btn');
    btn.append(el('div', 't', d['menu.play']), el('div', 'h', d['menu.playHint']));
    const btn2 = el('div', 'menu-btn');
    btn2.append(el('div', 't', d['menu.daily']), el('div', 'h', d['menu.dailyNotPlayed']));
    const ul = el('ul');
    for (const key of ['start.howto.look', 'start.howto.walk', 'start.howto.guess', 'start.howto.rounds', 'menu.howto.timer']) {
      ul.append(el('li', '', fill(d[key] ?? key, { rounds: '3, 5, 10', max: '5 000' })));
    }
    body.append(btn, btn2, el('h3', '', d['menu.howToPlay']), ul);
    card.append(meta, body);
    card.addEventListener('click', () => {
      picked = lv;
      render();
    });
    grid.append(card);
  }
}

for (const c of [langSel, size, art]) c.addEventListener('input', render);
render();
