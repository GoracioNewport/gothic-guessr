/**
 * Nickname profanity filter (SPEC §10.9). Pure.
 *
 * Pipeline for a nickname (and, identically, for every root word so both sides compare in the same space):
 * 1. NFKC (fullwidth/compatibility forms), lowercase, strip combining marks (ü→u, й→и, ё→е) and invisible
 *    default-ignorable characters (Hangul fillers, zero-width joiners), fold ß/ł/ø/đ/æ/œ.
 * 2. Build two "skeletons", because Latin and Cyrillic homoglyphs are mixed to dodge filters in both directions:
 *    - Latin skeleton: leetspeak `0→o 1→i 3→e 4→a 5→s 7→t @→a $→s` (plus `!|→i`, `8→b`, `9→g`), Cyrillic look-alikes
 *      → Latin (`а→a`, `с→c`, `р→p`, `х→x`, `у→y`, …), other letters become a word break, the rest is dropped;
 *    - Cyrillic skeleton: Russian-style leetspeak (`3→з`, `4→ч`, `6→б`, `0→о`, `@→а`), Latin look-alikes → Cyrillic
 *      (`a→а`, `c→с`, `p→р`, `x→х`, `y→у`, `e→е`, `o→о`, …), other letters become a word break, the rest is dropped.
 *    Dropping non-letters removes separators (`f.u_c k`).
 * 3. Substring match of the built-in roots (EN/DE/PL/RU, below) and the admin blocklist against each skeleton, both as
 *    is and with runs of the same letter collapsed (`fuuuck`). A root only matches skeletons of its own script.
 *
 * Roots are chosen to avoid the classic false positives of substring matching ("class", "Scunthorpe", "grape",
 * "команда", "оскорблять"): very short or ambiguous stems are left out on purpose.
 */

/** Built-in roots, per language. Lowercase, already in their natural script; normalised at load time. */
export const PROFANITY_ROOTS: Readonly<Record<'en' | 'de' | 'pl' | 'ru', readonly string[]>> = {
  en: [
    'fuck', 'fck', 'phuck', 'shit', 'cunt', 'bitch', 'asshole', 'arsehole', 'dickhead', 'pussy', 'whore', 'slut',
    'bastard', 'wanker', 'twat', 'nigger', 'nigga', 'faggot', 'retard', 'motherf', 'cocksuck', 'blowjob', 'handjob',
    'rapist', 'penis', 'vagina', 'porn', 'dildo', 'jizz', 'kike', 'tranny', 'hitler', 'kkk', 'heilhitler',
    'siegheil', 'whitepower', 'paedo', 'pedophil',
  ],
  de: [
    'ficken', 'ficker', 'fickt', 'scheiss', 'scheis', 'fotze', 'hure', 'wichser', 'arschloch', 'schlampe', 'missgeburt', 'hurensohn',
    'schwuchtel', 'kanake', 'neger', 'spast', 'drecksau', 'judensau', 'kinderf',
  ],
  pl: [
    'kurwa', 'kurwy', 'kurew', 'kurwi', 'chuj', 'chuja', 'pierdol', 'jebac', 'jebany', 'jebana', 'pizda', 'pizdy',
    'skurwysyn', 'skurwiel', 'dziwka', 'dziwki', 'cwel', 'szmata', 'spierdal', 'zajeb', 'wypierdal', 'kutas',
    'pedofil', 'ciota', 'ruchac',
  ],
  ru: [
    // Cyrillic
    'хуй', 'хуе', 'хуё', 'хуя', 'хуи', 'пизд', 'ебат', 'ебан', 'ебал', 'ебло', 'ебуч', 'ебну', 'уеб', 'заеб', 'выеб',
    'доеб', 'отъеб', 'бляд', 'блят', 'мудак', 'мудил', 'сука', 'суки', 'сучк', 'шлюх', 'гандон', 'гондон', 'пидор',
    'пидар', 'педик', 'залуп', 'мандавош', 'дроч', 'жопа', 'говно', 'чурка', 'чурки', 'гитлер', 'нацист',
    // common Latin transliterations
    'blyat', 'blyad', 'pizdec', 'pizdets', 'xuy', 'xyu', 'xuj', 'ebat', 'yobany', 'mudak', 'pidor', 'pidar',
    'gandon',
  ],
};

const LATIN_LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '8': 'b',
  '9': 'g',
};

/** Cyrillic letters that look like Latin ones, mapped to the Latin letter. */
const CYR_TO_LAT: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j',
  ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', г: 'r', п: 'n', и: 'u', ь: 'b',
};

const CYR_LEET: Record<string, string> = { '0': 'о', '3': 'з', '4': 'ч', '6': 'б', '@': 'а', $: 'с' };

/** Latin letters that look like Cyrillic ones, mapped to the Cyrillic letter. */
const LAT_TO_CYR: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', u: 'и', n: 'п',
  r: 'г',
};

const FOLD: Record<string, string> = { ß: 'ss', ł: 'l', ø: 'o', đ: 'd', æ: 'ae', œ: 'oe', þ: 'th', ı: 'i' };

/** Step 1: NFKC, lowercase, strip combining marks, fold a few letters without decompositions. */
export function foldText(text: string): string {
  const lowered = text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]+/gu, '');
  let out = '';
  for (const ch of lowered) out += FOLD[ch] ?? ch;
  return out;
}

/** Placeholder for a letter that has no look-alike in the target script: it breaks words, it never matches. */
const BREAK = '|';

/**
 * Map every character of folded text with `map`; keep results that are letters of the target script (`keep`), turn
 * other letters into {@link BREAK} (so `ш` between two Latin look-alikes does not glue them into a word) and drop
 * everything else (spaces, separators, unmapped digits).
 */
function skeleton(folded: string, map: (ch: string) => string | undefined, keep: RegExp): string {
  let out = '';
  for (const ch of folded) {
    const mapped = map(ch) ?? ch;
    if (keep.test(mapped)) out += mapped;
    else if (/\p{L}/u.test(mapped)) out += BREAK;
  }
  return out;
}

/** Latin skeleton of already folded text: leetspeak + Cyrillic homoglyphs → Latin, a–z kept. */
export function latinSkeleton(folded: string): string {
  return skeleton(folded, (ch) => LATIN_LEET[ch] ?? CYR_TO_LAT[ch], /^[a-z]$/);
}

/** Cyrillic skeleton of already folded text: Russian leetspeak + Latin homoglyphs → Cyrillic, а–я kept. */
export function cyrillicSkeleton(folded: string): string {
  return skeleton(folded, (ch) => CYR_LEET[ch] ?? LAT_TO_CYR[ch], /^[а-я]$/);
}

/** Collapse runs of the same character: `fuuuck` → `fuck`. */
export function collapseRuns(s: string): string {
  return s.replace(/(.)\1+/gu, '$1');
}

const isCyrillic = (s: string): boolean => /[а-яё]/.test(s);

/** A root prepared for matching: the skeleton of its own script, plain and collapsed. */
interface PreparedRoot {
  word: string;
  script: 'latin' | 'cyrillic';
  plain: string;
  collapsed: string;
}

export function prepareRoot(word: string): PreparedRoot | null {
  const folded = foldText(word.trim());
  if (folded === '') return null;
  const script = isCyrillic(folded) ? 'cyrillic' : 'latin';
  const plain = script === 'cyrillic' ? cyrillicSkeleton(folded) : latinSkeleton(folded);
  if (plain.replaceAll(BREAK, '').length < 3 || plain.includes(BREAK)) return null; // too short / mixed: unsafe
  return { word, script, plain, collapsed: collapseRuns(plain) };
}

const BUILTIN: PreparedRoot[] = Object.values(PROFANITY_ROOTS)
  .flat()
  .map(prepareRoot)
  .filter((r): r is PreparedRoot => r !== null);

/**
 * The root that `text` contains, or null when clean. `extraWords` is the admin blocklist (any script; words shorter
 * than 3 letters after normalisation are ignored).
 */
export function findProfanity(text: string, extraWords: readonly string[] = []): string | null {
  const folded = foldText(text);
  const latin = latinSkeleton(folded);
  const cyrillic = cyrillicSkeleton(folded);
  const skeletons = {
    latin: [latin, collapseRuns(latin)] as const,
    cyrillic: [cyrillic, collapseRuns(cyrillic)] as const,
  };
  const extra = extraWords.map(prepareRoot).filter((r): r is PreparedRoot => r !== null);
  for (const root of [...BUILTIN, ...extra]) {
    const [plain, collapsed] = skeletons[root.script];
    if (plain.includes(root.plain)) return root.word;
    // `kkk` collapses to `k`: the collapsed form only counts while it is still long enough to be specific.
    if (root.collapsed.length >= 3 && collapsed.includes(root.collapsed)) return root.word;
  }
  return null;
}

/** True when `text` contains no built-in root and no `extraWords` entry. */
export function isClean(text: string, extraWords: readonly string[] = []): boolean {
  return findProfanity(text, extraWords) === null;
}
