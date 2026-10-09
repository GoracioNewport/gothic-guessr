/**
 * Problem reports, player side (owner's request; server: server/routes/reports.ts). Plain DOM, Gothic look.
 *
 * - {@link openReportDialog}: a modal over everything (appended to `<body>`, so a screen change behind it, e.g. a room
 *   round that ends, does not drop what the player typed). Type picker (place, translation, bug, other), category
 *   chips for a place, free text (≤ 1000), Send → `POST /api/reports` → a thank-you toast. While it is open, keys
 *   never reach the screen behind it (Space would guess, R would return to the start).
 * - {@link reportFlagButton}: the discreet flag button of the round HUD (src/ui/screens.ts) — reports the place the
 *   player is standing on; the server resolves it from the player's own game, nothing is sent back.
 * - {@link installReportLink}: a small "Report a problem" link in the corner of every page except the round screen.
 *   After a game on the same page (summary, room standings) it offers that game's rounds as places.
 * - {@link noteReportRound}: the round player (src/play/flow.ts) records which game and round are on screen.
 *
 * Sent along: the UI language, the path, the viewport and the client build hash; the server adds the user agent and
 * the player. Nothing of it is shown to other players.
 */
import { REPORT_CATEGORIES, REPORT_TEXT_MAX } from '../../shared/api';
import type { CreateReportRequest, ReportCategory, ReportType } from '../../shared/api';
import { errorMessage, getLanguage, onLanguageChange, t } from '../i18n';
import type { MessageKey } from '../i18n';
import { isApiError } from '../net/api';
import type { ApiClient } from '../net/api';
import type { Router } from '../router';
import { el, toast } from './dom';

const TYPES: readonly ReportType[] = ['location', 'translation', 'bug', 'other'];

export interface ReportDialogOptions {
  /** Pre-selected type (default: `location` when a place can be attached, else `bug`). */
  type?: ReportType;
  /** The open round of this game: "where I am standing now" (round HUD). */
  current?: { gameId: string };
  /** Rounds 1..`rounds` of this game can be picked as the place (after a game, or earlier rounds). */
  game?: { gameId: string; rounds: number };
}

/** Where a location report points: the current position or round n of the game. */
type Where = { kind: 'current'; gameId: string } | { kind: 'round'; gameId: string; round: number };

let openDialog: { close(): void } | null = null;

/** Build hash of the client bundle (`/assets/index-<hash>.js`), `dev` under Vite's dev server. */
export function appVersion(): string {
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  if (env?.DEV) return 'dev';
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? '';
  const m = /-([A-Za-z0-9_-]{6,32})\.js$/.exec(src);
  return m ? m[1]! : 'unknown';
}

/** The request body for the current form state (exported for tests). */
export function buildReport(state: { type: ReportType; text: string; categories: readonly ReportCategory[]; where: Where | null }): CreateReportRequest {
  const body: CreateReportRequest = {
    type: state.type,
    context: {
      lang: getLanguage(),
      path: location.pathname,
      viewport: { w: Math.round(window.innerWidth), h: Math.round(window.innerHeight) },
      appVersion: appVersion(),
    },
  };
  const text = state.text.trim();
  if (text) body.text = text;
  if (state.type === 'location') {
    if (state.categories.length) body.categories = [...state.categories];
    if (state.where) {
      body.game = state.where.kind === 'round' ? { gameId: state.where.gameId, round: state.where.round } : { gameId: state.where.gameId };
    }
  }
  return body;
}

/** Inline SVG flag (currentColor). */
function flagIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('g2-report-icon');
  const pole = document.createElementNS(ns, 'path');
  pole.setAttribute('d', 'M3 1.5v13.5');
  pole.setAttribute('stroke', 'currentColor');
  pole.setAttribute('stroke-width', '1.6');
  pole.setAttribute('fill', 'none');
  const cloth = document.createElementNS(ns, 'path');
  cloth.setAttribute('d', 'M3.8 2.2h9.4l-2.2 3.3 2.2 3.3H3.8z');
  cloth.setAttribute('fill', 'currentColor');
  svg.append(pole, cloth);
  return svg;
}

/** The flag button of the round HUD. */
export function reportFlagButton(onClick: () => void): HTMLButtonElement {
  const btn = el('button', 'g2-btn g2-btn-secondary g2-report-flag');
  btn.type = 'button';
  btn.title = t('report.flag');
  btn.setAttribute('aria-label', t('report.flag'));
  btn.appendChild(flagIcon());
  btn.addEventListener('click', () => {
    btn.blur();
    onClick();
  });
  return btn;
}

/** Open the report dialog (one at a time; a second call focuses nothing new). */
export function openReportDialog(api: ApiClient, opts: ReportDialogOptions = {}): void {
  if (openDialog) return;
  const places: Where[] = [];
  if (opts.current) places.push({ kind: 'current', gameId: opts.current.gameId });
  if (opts.game) {
    for (let n = 1; n <= opts.game.rounds; n++) places.push({ kind: 'round', gameId: opts.game.gameId, round: n });
  }
  let type: ReportType = opts.type ?? (places.length ? 'location' : 'bug');
  let where: Where | null = places[0] ?? null;
  const categories = new Set<ReportCategory>();
  let sending = false;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const backdrop = el('div', 'g2-modal-backdrop');
  const dialog = el('div', 'g2-card g2-modal g2-report');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const titleId = 'g2-report-title';
  dialog.setAttribute('aria-labelledby', titleId);
  backdrop.appendChild(dialog);

  const title = el('h2', 'g2-heading g2-report-title', t('report.title'));
  title.id = titleId;
  const intro = el('p', 'g2-report-intro', t('report.intro'));

  // --- type picker
  const typeSet = el('fieldset', 'g2-report-types');
  typeSet.appendChild(el('legend', 'g2-legend', t('report.typeLegend')));
  const typeList = el('div', 'g2-report-type-list');
  typeSet.appendChild(typeList);
  const typeInputs = new Map<ReportType, HTMLInputElement>();
  for (const value of TYPES) {
    const row = el('label', 'g2-toggle g2-report-type');
    const input = el('input', 'g2-toggle-box');
    input.type = 'radio';
    input.name = 'g2-report-type';
    input.value = value;
    input.checked = value === type;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      type = value;
      sync();
    });
    typeInputs.set(value, input);
    const text = el('span', 'g2-toggle-text');
    text.append(el('span', 'g2-toggle-name', t(`report.type.${value}` as MessageKey)), el('span', 'g2-toggle-hint', t(`report.type.${value}.hint` as MessageKey)));
    row.append(input, text);
    typeList.appendChild(row);
  }

  // --- place (location only)
  const placeBox = el('div', 'g2-report-place');
  if (places.length > 1) {
    const whereSet = el('fieldset', 'g2-report-where');
    whereSet.appendChild(el('legend', 'g2-legend g2-report-sublegend', t('report.whereLegend')));
    const list = el('div', 'g2-report-chips');
    places.forEach((p, i) => {
      const chip = el('label', 'g2-report-chip');
      const input = el('input');
      input.type = 'radio';
      input.name = 'g2-report-where';
      input.checked = i === 0;
      input.addEventListener('change', () => {
        if (input.checked) where = p;
      });
      chip.append(input, el('span', undefined, p.kind === 'current' ? t('report.whereCurrent') : t('report.roundN', { round: p.round })));
      list.appendChild(chip);
    });
    whereSet.appendChild(list);
    placeBox.appendChild(whereSet);
  }
  const chipSet = el('fieldset', 'g2-report-cats');
  chipSet.appendChild(el('legend', 'g2-legend g2-report-sublegend', t('report.chipsLegend')));
  const chipList = el('div', 'g2-report-chips');
  for (const cat of REPORT_CATEGORIES) {
    const chip = el('label', 'g2-report-chip');
    const input = el('input');
    input.type = 'checkbox';
    input.value = cat;
    input.addEventListener('change', () => {
      if (input.checked) categories.add(cat);
      else categories.delete(cat);
    });
    chip.append(input, el('span', undefined, t(`report.cat.${cat}` as MessageKey)));
    chipList.appendChild(chip);
  }
  chipSet.appendChild(chipList);
  placeBox.appendChild(chipSet);
  const placeNote = el('p', 'g2-report-note', places.length ? t('report.attachedPlace') : t('report.whereDescribe'));
  placeBox.appendChild(placeNote);

  // --- text
  const textId = 'g2-report-text';
  const textLabel = el('label', 'g2-legend g2-report-sublegend');
  textLabel.htmlFor = textId;
  const textarea = el('textarea', 'g2-input g2-report-textarea');
  textarea.id = textId;
  textarea.rows = 3;
  textarea.maxLength = REPORT_TEXT_MAX;
  const counter = el('span', 'g2-report-counter');
  const updateCounter = (): void => {
    counter.textContent = `${[...textarea.value].length}/${REPORT_TEXT_MAX}`;
  };
  textarea.addEventListener('input', () => {
    updateCounter();
    error.textContent = '';
  });
  const textHead = el('div', 'g2-report-texthead');
  textHead.append(textLabel, counter);
  const error = el('p', 'g2-field-error g2-report-error');
  error.setAttribute('role', 'alert');

  const privacy = el('p', 'g2-report-note', t('report.attached'));

  const cancel = el('button', 'g2-btn g2-btn-secondary', t('report.cancel'));
  cancel.type = 'button';
  const send = el('button', 'g2-btn g2-btn-primary', t('report.send'));
  send.type = 'button';
  const actions = el('div', 'g2-actions g2-report-actions');
  actions.append(cancel, send);

  dialog.append(title, intro, typeSet, placeBox, textHead, textarea, error, privacy, actions);

  const textRequired = (): boolean => !(type === 'location' && where !== null);
  function sync(): void {
    placeBox.hidden = type !== 'location';
    textLabel.textContent = textRequired() ? t('report.details') : t('report.detailsOptional');
    textarea.placeholder = t(`report.ph.${type}` as MessageKey);
    for (const [value, input] of typeInputs) input.closest('.g2-toggle')?.classList.toggle('g2-toggle-on', value === type);
    error.textContent = '';
  }

  // --- behaviour
  const close = (): void => {
    if (openDialog !== handle) return;
    openDialog = null;
    window.removeEventListener('keydown', onWindowKey, true);
    unsubscribeLang();
    backdrop.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const handle = { close };

  const focusables = (): HTMLElement[] =>
    [...dialog.querySelectorAll<HTMLElement>('input, textarea, button')].filter((n) => !(n as HTMLButtonElement).disabled && n.offsetParent !== null);

  // Capture phase: nothing outside the dialog sees a key while it is open; Escape closes, Tab stays inside.
  const onWindowKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!sending) close();
      return;
    }
    if (e.key === 'Tab') {
      const items = focusables();
      if (items.length) {
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        if (!dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    if (!(e.target instanceof Node) || !dialog.contains(e.target)) {
      if (e.key !== 'Tab') e.preventDefault();
      e.stopPropagation();
    }
  };
  // Keys inside the dialog work there but stop before the document's screen shortcuts.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && !sending && textarea.value.trim() === '') close();
  });
  cancel.addEventListener('click', () => {
    if (!sending) close();
  });

  const submit = async (): Promise<void> => {
    if (sending) return;
    const text = textarea.value.trim();
    if (textRequired() && text === '') {
      error.textContent = t('report.required');
      textarea.focus();
      return;
    }
    sending = true;
    send.disabled = true;
    cancel.disabled = true;
    send.textContent = t('report.sending');
    try {
      await api.call<void>('/reports', { method: 'POST', body: buildReport({ type, text, categories: [...categories], where }) });
      close();
      toast(t('report.sent'), 'info');
    } catch (err) {
      error.textContent = isApiError(err) ? errorMessage(err.code) : t('error.unknown');
    } finally {
      sending = false;
      send.disabled = false;
      cancel.disabled = false;
      send.textContent = t('report.send');
    }
  };
  send.addEventListener('click', () => void submit());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  });

  // The language selector cannot be reached while the dialog is open, but another tab can switch it.
  const unsubscribeLang = onLanguageChange(() => close());

  openDialog = handle;
  window.addEventListener('keydown', onWindowKey, true);
  sync();
  updateCounter();
  document.body.appendChild(backdrop);
  (typeInputs.get(type) ?? textarea).focus();
}

/** Close the dialog if one is open (tests, route teardown). */
export function closeReportDialog(): void {
  openDialog?.close();
}

// ---------------------------------------------------------------------------------------------
// The game on screen, for the page link after a game
// ---------------------------------------------------------------------------------------------

let lastGame: { gameId: string; rounds: number; path: string } | null = null;

/** Called by the round player for every round it shows. */
export function noteReportRound(gameId: string, round: number): void {
  const path = location.pathname;
  if (lastGame && lastGame.gameId === gameId) lastGame = { gameId, rounds: Math.max(lastGame.rounds, round), path };
  else lastGame = { gameId, rounds: round, path };
}

/** The game played on this page, if any (summary or room standings after it). */
export function reportGameHere(): { gameId: string; rounds: number } | null {
  return lastGame && lastGame.path === location.pathname ? { gameId: lastGame.gameId, rounds: lastGame.rounds } : null;
}

/**
 * The "Report a problem" corner link on every page (hidden by CSS while a round is on screen). Call once; the link
 * lives outside the screen root so page changes never remove it.
 */
export function installReportLink(api: ApiClient, router: Pick<Router, 'onChange'>): () => void {
  const link = el('button', 'g2-report-link');
  link.type = 'button';
  const label = el('span', undefined, t('report.link'));
  link.append(flagIcon(), label);
  link.addEventListener('click', () => {
    link.blur();
    const game = reportGameHere();
    openReportDialog(api, game ? { game } : {});
  });
  document.body.appendChild(link);
  const offLang = onLanguageChange(() => (label.textContent = t('report.link')));
  // A new page forgets the game of the previous one (a game's summary stays on the game's own path).
  const offRoute = router.onChange(() => {
    if (lastGame && lastGame.path !== location.pathname) lastGame = null;
  });
  return () => {
    offLang();
    offRoute();
    link.remove();
  };
}
