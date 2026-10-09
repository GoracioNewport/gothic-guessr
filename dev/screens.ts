/**
 * Dev harness for the stage-3 screens: the round HUD (with a countdown), the result card in its four variants
 * (distance, wrong world, timeout, no guess) and the summary page, with dummy data and dummy mounts (a draggable
 * fake panorama, a clickable fake map). Open /dev/screens.html; the language selector of the app is not on these
 * screens, so the harness toolbar has its own language buttons. Real pages (menu, setup, daily, challenge) are
 * checked in the app itself (`npm run dev`).
 */
import '../src/style.css';

import type { GameSummaryView, RoundResultView } from '../shared/api';
import { LANGS, setLanguage } from '../src/i18n';
import type { AppContext, Page } from '../src/pages/context';
import { renderSummary } from '../src/pages/summary';
import { Screens } from '../src/ui/screens';
import type { RoundScreenHandle } from '../src/ui/screens';

const appEl = document.getElementById('app');
const harnessEl = document.getElementById('harness');
if (!appEl || !harnessEl) throw new Error('harness: #app or #harness missing');
const app: HTMLElement = appEl;
const harness: HTMLElement = harnessEl;

const TOTAL = 5;
const screens = new Screens(app);
let roundHandle: RoundScreenHandle | null = null;
let settings = { mode: 'mixed' as const, worlds: ['khorinis', 'valley', 'jharkendar'], noMove: false, noLook: false, timeLimit: 120, rounds: 5 };

// --- harness toolbar -----------------------------------------------------------------------

const style = document.createElement('style');
style.textContent = `
  #harness { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 1000;
    display: flex; gap: 6px; align-items: center; padding: 6px 8px; font: 12px system-ui, sans-serif;
    background: rgba(40, 40, 40, 0.9); border: 1px solid #666; border-radius: 6px; color: #ddd; }
  #harness button { font: inherit; padding: 3px 8px; cursor: pointer; }
  #harness .log { max-width: 260px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #9c9; }
  .fake-pano { position: absolute; inset: 0; cursor: grab; user-select: none;
    background: repeating-linear-gradient(90deg, #2b3a4a 0 80px, #35475a 80px 160px),
                linear-gradient(#0b1b2b, #4b6b8b); background-blend-mode: overlay; }
  .fake-pano:active { cursor: grabbing; }
  .fake-pano::after { content: 'fake panorama — drag me'; position: absolute; left: 50%; top: 50%;
    transform: translate(-50%, -50%); color: rgba(255,255,255,0.6); font: 14px system-ui, sans-serif; }
  .fake-map { position: relative; width: 100%; height: 100%; cursor: crosshair;
    background: #2a4d73 repeating-linear-gradient(0deg, transparent 0 31px, rgba(255,255,255,0.12) 31px 32px),
                repeating-linear-gradient(90deg, transparent 0 31px, rgba(255,255,255,0.12) 31px 32px); }
  .fake-map .marker { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px;
    border-radius: 50%; background: #e33; border: 2px solid #fff; pointer-events: none; }
  .fake-map .size { position: absolute; left: 6px; bottom: 4px; font: 11px monospace; color: #fff; opacity: 0.7; }
`;
document.head.appendChild(style);

const log = document.createElement('span');
log.className = 'log';
function note(msg: string): void {
  console.log(`[harness] ${msg}`);
  log.textContent = msg;
}

function button(label: string, onClick: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    b.blur();
    onClick();
  });
  harness.appendChild(b);
}

// --- dummy mounts --------------------------------------------------------------------------

/** Fills the panorama mount with a draggable gradient to check the HUD does not block drags. */
function mountFakePanorama(el: HTMLElement): void {
  const pano = document.createElement('div');
  pano.className = 'fake-pano';
  el.appendChild(pano);
  let dragging = false;
  let offset = 0;
  let lastX = 0;
  pano.addEventListener('mousedown', (e) => {
    dragging = true;
    lastX = e.clientX;
    note('pano drag start');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    offset += e.clientX - lastX;
    lastX = e.clientX;
    pano.style.backgroundPosition = `${offset}px 0, 0 0`;
  });
  window.addEventListener('mouseup', () => {
    if (dragging) note(`pano drag end (offset ${offset}px)`);
    dragging = false;
  });
}

/** Fills a map mount with a grid; a click places a marker and enables Guess. */
function mountFakeMap(el: HTMLElement, interactive: boolean): void {
  const map = document.createElement('div');
  map.className = 'fake-map';
  const size = document.createElement('span');
  size.className = 'size';
  map.appendChild(size);
  el.appendChild(map);
  const ro = new ResizeObserver(() => {
    size.textContent = `${Math.round(map.clientWidth)}×${Math.round(map.clientHeight)}`;
  });
  ro.observe(map);
  if (!interactive) return;
  let marker: HTMLElement | null = null;
  map.addEventListener('click', (e) => {
    const r = map.getBoundingClientRect();
    if (!marker) {
      marker = document.createElement('div');
      marker.className = 'marker';
      map.appendChild(marker);
    }
    marker.style.left = `${e.clientX - r.left}px`;
    marker.style.top = `${e.clientY - r.top}px`;
    roundHandle?.setGuessEnabled(true);
    note('guess placed');
  });
}

// --- dummy data ----------------------------------------------------------------------------

const answer = (world: string) => ({ world, x: 1385.1, z: 3172.4 });
const rounds: RoundResultView[] = [
  { n: 1, guess: { world: 'khorinis', x: 1000, z: 3000 }, answer: answer('khorinis'), distanceM: 4.2, score: 5000, timeMs: 23_400, timedOut: false },
  { n: 2, guess: { world: 'khorinis', x: 2000, z: 3000 }, answer: answer('valley'), distanceM: null, score: 0, timeMs: 61_000, timedOut: false },
  { n: 3, guess: null, answer: answer('valley'), distanceM: null, score: 0, timeMs: 120_000, timedOut: true },
  { n: 4, guess: { world: 'khorinis', x: 9000, z: 100 }, answer: answer('khorinis'), distanceM: 1203.7, score: 2, timeMs: 95_100, timedOut: false },
  { n: 5, guess: null, answer: answer('jharkendar'), distanceM: null, score: 0, timeMs: 3_000, timedOut: false },
];

const fakePage: Page = { alive: true, destroy() {} };
const fakeCtx = {
  slugs: settings.worlds,
  screens,
  player: () => ({ id: 'me', nickname: 'Wanderer1234', banned: false, createdAt: 0 }),
  router: { navigate: (p: unknown) => note(`navigate ${JSON.stringify(p)}`) },
  startSolo: async () => note('startSolo (play again)'),
} as unknown as AppContext;

function summary(daily: boolean): GameSummaryView {
  const total = rounds.reduce((s, r) => s + r.score, 0);
  const entries = Array.from({ length: 12 }, (_, i) => ({
    rank: i + 1, playerId: `p${i}`, nickname: i === 3 ? 'Хорошо_играю' : `Player${i + 1}`, total: 24000 - i * 1500, timeMs: 300_000 + i * 7000,
    rounds: [5000, 5000, 5000, 5000, 4000], me: false,
  }));
  const me = { rank: 31, playerId: 'me', nickname: 'Wanderer1234', total, timeMs: 302_500, rounds: rounds.map((r) => r.score), me: true };
  const view: GameSummaryView = {
    game: {
      id: 'g', kind: daily ? 'daily' : 'solo', challengeCode: daily ? 'daily-2026-10-07' : 'k7m2p9qa', settings, totalRounds: TOTAL,
      results: rounds, current: null, currentKey: null, finished: true, total, ...(daily ? { date: '2026-10-07' } : {}),
    },
    leaderboard: { code: 'k7m2p9qa', entries, me, total: 40 },
  };
  if (daily) view.shareText = `Gothic II Guessr — Daily 2026-10-07\n5 002 / 25 000\n🟩⬛⬛🟥⬛\n${location.origin}/daily`;
  return view;
}

// --- screens -------------------------------------------------------------------------------

function showRound(round: number, score: number, timed: boolean): void {
  roundHandle = screens.showRound({
    round,
    total: TOTAL,
    score,
    deadline: timed ? Date.now() + 35_000 : null,
    onTimeout: () => note('onTimeout (submit null)'),
    onGuess: () => {
      note(`onGuess round ${round}`);
      showResult(round);
    },
    onReturnToStart: () => note('onReturnToStart'),
    mountPanorama: mountFakePanorama,
    mountMap: (el) => mountFakeMap(el, true),
    onMapExpandChanged: (expanded) => note(`map ${expanded ? 'expanded' : 'collapsed'}`),
    noMove: settings.noMove,
    noLook: settings.noLook,
  });
}

function showResult(round: number): void {
  const result = rounds[round - 1] ?? rounds[0]!;
  roundHandle = null;
  screens.showResult({
    result,
    total: TOTAL,
    onNext: () => {
      note(`onNext after round ${round}`);
      if (round >= TOTAL) renderSummary(fakeCtx, fakePage, summary(false));
      else showRound(round + 1, rounds.slice(0, round).reduce((s, r) => s + r.score, 0), false);
    },
    mountMap: (el) => mountFakeMap(el, false),
  });
}

button('Round 1', () => showRound(1, 0, false));
button('Round 3 timed', () => showRound(3, 8459, true));
button('Result 1', () => showResult(1));
button('Result 2 (wrong world)', () => showResult(2));
button('Result 3 (timeout)', () => showResult(3));
button('Result 5 (no guess, last)', () => showResult(5));
button('Summary', () => renderSummary(fakeCtx, fakePage, summary(false)));
button('Summary daily', () => renderSummary(fakeCtx, fakePage, summary(true)));
button('Toggles', () => {
  settings = { ...settings, noMove: !settings.noMove, noLook: !settings.noMove };
  note(`settings now noMove=${settings.noMove} noLook=${settings.noLook}; reopen a round`);
});
for (const lang of LANGS) button(lang, () => setLanguage(lang, { persist: false }));
harness.appendChild(log);

showRound(1, 0, false);
