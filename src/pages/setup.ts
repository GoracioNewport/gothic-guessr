/**
 * Quick play setup (SPEC §10.1 "Solo", §10.7, route `/play`): the stage-2 start controls without the seed field
 * (seeds are server secrets) plus the round time limit and the number of rounds. Worlds (a checkbox per world,
 * unavailable ones greyed with their error), mode, No move / No look (No look requires No move), time limit (off /
 * 30 s / 1 / 2 / 5 min), rounds (3 / 5 / 10, default 5). The rules panel (src/ui/rulespanel.ts) to the right of the
 * card follows the settings live; the Legal link sits at the bottom.
 * The last settings used are remembered in localStorage ({@link SOLO_SETTINGS_KEY}).
 */
import type { GameMode, PublicSettings } from '../../shared/api';
import { ROUND_COUNTS, TIME_LIMITS } from '../../shared/api';
import { formatNumber, formatTimeLimit, t, worldDescription, worldName } from '../i18n';
import { worldThumbnailUrl } from '../data/worlds';
import { button, el, hasModifier, isOwnSpaceTarget, isTypingTarget, keyButton, WORLD_MAP_ART } from '../ui/dom';
import { createLangSelect } from '../ui/langselect';
import { legalLink } from '../ui/legal';
import { rulesPanel, withRules } from '../ui/rulespanel';
import { applyToggleRules } from '../ui/screens';
import type { AppContext, Page } from './context';
import { pageScope } from './context';

export const SOLO_SETTINGS_KEY = 'gothic2guessr.solo';
const MODES: readonly GameMode[] = ['classic', 'mixed', 'hardcore'];
export const DEFAULT_MODE: GameMode = 'mixed';
export const DEFAULT_ROUNDS = 5;

/** Defaults: every available world, Mixed, movement on, no time limit, 5 rounds. */
export function defaultSoloSettings(slugs: readonly string[]): PublicSettings {
  return { mode: DEFAULT_MODE, worlds: [...slugs], noMove: false, noLook: false, timeLimit: 0, rounds: DEFAULT_ROUNDS };
}

/**
 * Settings from a stored JSON value, sanitised against the available worlds (unknown worlds dropped, invalid
 * fields reset to the defaults, No look implies No move). Exported for tests.
 */
export function sanitiseSoloSettings(raw: unknown, slugs: readonly string[]): PublicSettings {
  const base = defaultSoloSettings(slugs);
  if (typeof raw !== 'object' || raw === null) return base;
  const s = raw as Partial<Record<keyof PublicSettings, unknown>>;
  const worlds = Array.isArray(s.worlds) ? slugs.filter((slug) => (s.worlds as unknown[]).includes(slug)) : [];
  const noLook = s.noLook === true;
  return {
    mode: MODES.includes(s.mode as GameMode) ? (s.mode as GameMode) : base.mode,
    worlds: worlds.length > 0 ? worlds : base.worlds,
    noMove: noLook || s.noMove === true,
    noLook,
    timeLimit: typeof s.timeLimit === 'number' && TIME_LIMITS.includes(s.timeLimit) ? s.timeLimit : 0,
    rounds: typeof s.rounds === 'number' && ROUND_COUNTS.includes(s.rounds) ? s.rounds : DEFAULT_ROUNDS,
  };
}

export function readSoloSettings(slugs: readonly string[]): PublicSettings {
  try {
    const raw = localStorage.getItem(SOLO_SETTINGS_KEY);
    return sanitiseSoloSettings(raw ? JSON.parse(raw) : null, slugs);
  } catch {
    return defaultSoloSettings(slugs);
  }
}

export function saveSoloSettings(settings: PublicSettings): void {
  try {
    localStorage.setItem(SOLO_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* optional */
  }
}

export function setupPage(ctx: AppContext): Page {
  const page = pageScope();
  const available = new Set(ctx.slugs);
  let settings = readSoloSettings(ctx.slugs);
  let starting = false;

  const render = (): void => {
    if (!page.alive) return;
    const screen = el('div', 'g2-screen g2-centered g2-start');
    const lang = createLangSelect({ corner: true });
    screen.appendChild(lang.root);
    const card = el('div', 'g2-card');
    const rules = rulesPanel(settings, { kind: 'solo' });
    screen.appendChild(withRules(card, rules.root));
    screen.appendChild(legalLink());
    card.appendChild(el('h1', 'g2-title', t('solo.heading')));

    // --- worlds
    const field = el('fieldset', 'g2-worlds');
    field.appendChild(el('legend', 'g2-legend', t('start.worlds')));
    const list = el('div', 'g2-world-list');
    for (const info of ctx.worlds.index.worlds) {
      const isAvailable = available.has(info.slug);
      const failure = ctx.worlds.failed.find((f) => f.slug === info.slug);
      const label = el('label', `g2-world${isAvailable ? '' : ' g2-world-unavailable'}`);
      const box = el('input', 'g2-world-box');
      box.type = 'checkbox';
      box.value = info.slug;
      const name = worldName(info.slug, info.name);
      box.setAttribute('aria-label', name);
      box.checked = isAvailable && settings.worlds.includes(info.slug);
      box.disabled = !isAvailable;
      box.addEventListener('change', () => {
        const chosen = new Set(settings.worlds);
        if (box.checked) chosen.add(info.slug);
        else chosen.delete(info.slug);
        settings = { ...settings, worlds: ctx.slugs.filter((s) => chosen.has(s)) };
        label.classList.toggle('g2-world-on', box.checked);
        validate();
        if (settings.worlds.length > 0) rules.update(settings);
      });
      label.classList.toggle('g2-world-on', box.checked);
      label.appendChild(box);
      const thumb = el('img', 'g2-world-thumb');
      thumb.alt = '';
      thumb.decoding = 'async';
      thumb.loading = 'lazy';
      const tileThumb = worldThumbnailUrl(info);
      const art = WORLD_MAP_ART[info.slug];
      if (art) thumb.classList.add('g2-world-thumb-art');
      thumb.src = art ?? tileThumb;
      thumb.addEventListener('error', () => {
        if (art && thumb.src.endsWith(art)) {
          thumb.classList.remove('g2-world-thumb-art');
          thumb.src = tileThumb;
          return;
        }
        thumb.classList.add('g2-world-thumb-missing');
      });
      label.appendChild(thumb);
      const text = el('div', 'g2-world-text');
      text.appendChild(el('div', 'g2-world-name', name));
      const description = worldDescription(info.slug, info.description);
      if (description) {
        const desc = el('div', 'g2-world-desc', description);
        desc.title = description;
        text.appendChild(desc);
      }
      if (!isAvailable) {
        text.appendChild(el('div', 'g2-world-error', t('start.worldUnavailable', { error: failure?.error ?? t('start.worldLoadError') })));
      }
      label.appendChild(text);
      list.appendChild(label);
    }
    field.appendChild(list);
    const worldsError = el('p', 'g2-field-error', t('start.worldsRequired'));
    field.appendChild(worldsError);
    card.appendChild(field);

    // --- mode (radio buttons styled as pills; arrow keys work because they share a name)
    const modeField = el('fieldset', 'g2-mode');
    modeField.appendChild(el('legend', 'g2-legend g2-mode-legend', t('start.mode')));
    const pills = el('div', 'g2-mode-pills');
    pills.setAttribute('role', 'radiogroup');
    pills.setAttribute('aria-label', t('start.modeAria'));
    modeField.appendChild(pills);
    const modeDesc = el('p', 'g2-mode-desc');
    modeDesc.id = 'g2-mode-desc';
    modeField.appendChild(modeDesc);
    const setMode = (next: GameMode): void => {
      settings = { ...settings, mode: next };
      rules.update(settings);
      modeDesc.textContent = t(`mode.${next}.desc`);
      for (const pill of pills.querySelectorAll<HTMLLabelElement>('.g2-pill')) {
        pill.classList.toggle('g2-pill-active', pill.dataset.mode === next);
      }
    };
    for (const mode of MODES) {
      const pill = el('label', 'g2-pill');
      pill.dataset.mode = mode;
      const radio = el('input', 'g2-pill-input');
      radio.type = 'radio';
      radio.name = 'g2-mode';
      radio.value = mode;
      radio.checked = mode === settings.mode;
      radio.setAttribute('aria-describedby', modeDesc.id);
      radio.addEventListener('change', () => {
        if (radio.checked) setMode(mode);
      });
      pill.append(radio, el('span', 'g2-pill-label', t(`mode.${mode}`)));
      pills.appendChild(pill);
    }
    setMode(settings.mode);
    card.appendChild(modeField);

    // --- toggles (No look requires No move)
    const toggleField = el('fieldset', 'g2-toggles');
    toggleField.appendChild(el('legend', 'g2-legend', t('start.challenge')));
    const makeToggle = (name: string, hint: string, flag: string): { label: HTMLLabelElement; box: HTMLInputElement } => {
      const label = el('label', 'g2-toggle');
      const box = el('input', 'g2-toggle-box');
      box.type = 'checkbox';
      box.dataset.toggle = flag;
      box.setAttribute('aria-label', name);
      label.appendChild(box);
      const text = el('span', 'g2-toggle-text');
      text.append(el('span', 'g2-toggle-name', name), el('span', 'g2-toggle-hint', hint));
      label.appendChild(text);
      toggleField.appendChild(label);
      return { label, box };
    };
    const noMove = makeToggle(t('start.noMove'), t('start.noMove.hint'), 'nomove');
    const noLook = makeToggle(t('start.noLook'), t('start.noLook.hint'), 'nolook');
    const renderToggles = (): void => {
      rules.update(settings);
      noMove.box.checked = settings.noMove;
      noLook.box.checked = settings.noLook;
      noMove.label.classList.toggle('g2-toggle-on', settings.noMove);
      noLook.label.classList.toggle('g2-toggle-on', settings.noLook);
    };
    noMove.box.addEventListener('change', () => {
      settings = { ...settings, ...applyToggleRules(settings, { noMove: noMove.box.checked }) };
      renderToggles();
    });
    noLook.box.addEventListener('change', () => {
      settings = { ...settings, ...applyToggleRules(settings, { noLook: noLook.box.checked }) };
      renderToggles();
    });
    renderToggles();
    card.appendChild(toggleField);

    // --- time limit
    const timeField = el('fieldset', 'g2-mode g2-time');
    timeField.appendChild(el('legend', 'g2-legend', t('start.timeLimit')));
    const timePills = el('div', 'g2-mode-pills');
    timePills.setAttribute('role', 'radiogroup');
    timePills.setAttribute('aria-label', t('start.timeLimit'));
    for (const limit of TIME_LIMITS) {
      const pill = el('label', `g2-pill${limit === settings.timeLimit ? ' g2-pill-active' : ''}`);
      pill.dataset.time = String(limit);
      const radio = el('input', 'g2-pill-input');
      radio.type = 'radio';
      radio.name = 'g2-time';
      radio.value = String(limit);
      radio.checked = limit === settings.timeLimit;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        settings = { ...settings, timeLimit: limit };
        rules.update(settings);
        for (const p of timePills.querySelectorAll<HTMLLabelElement>('.g2-pill')) {
          p.classList.toggle('g2-pill-active', p.dataset.time === String(limit));
        }
      });
      pill.append(radio, el('span', 'g2-pill-label', formatTimeLimit(limit)));
      timePills.appendChild(pill);
    }
    timeField.appendChild(timePills);

    // --- rounds (3 / 5 / 10), on one line with the time limit
    const roundsField = el('fieldset', 'g2-mode g2-rounds');
    roundsField.appendChild(el('legend', 'g2-legend', t('settings.rounds')));
    const roundPills = el('div', 'g2-mode-pills');
    roundPills.setAttribute('role', 'radiogroup');
    roundPills.setAttribute('aria-label', t('settings.rounds'));
    for (const count of ROUND_COUNTS) {
      const pill = el('label', `g2-pill${count === settings.rounds ? ' g2-pill-active' : ''}`);
      pill.dataset.rounds = String(count);
      const radio = el('input', 'g2-pill-input');
      radio.type = 'radio';
      radio.name = 'g2-rounds';
      radio.value = String(count);
      radio.checked = count === settings.rounds;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        settings = { ...settings, rounds: count };
        rules.update(settings);
        for (const p of roundPills.querySelectorAll<HTMLLabelElement>('.g2-pill')) {
          p.classList.toggle('g2-pill-active', p.dataset.rounds === String(count));
        }
      });
      pill.append(radio, el('span', 'g2-pill-label', formatNumber(count)));
      roundPills.appendChild(pill);
    }
    roundsField.appendChild(roundPills);
    const timeRow = el('div', 'g2-time-rounds');
    timeRow.append(timeField, roundsField);
    card.appendChild(timeRow);

    const actions = el('div', 'g2-actions g2-start-actions');
    actions.appendChild(button(t('menu.back'), 'g2-btn g2-btn-secondary', () => ctx.router.navigate('/')));
    const startBtn = keyButton('g2-btn g2-btn-primary g2-btn-big g2-start-btn', t('start.startGame'), 'Enter');
    actions.appendChild(startBtn);
    card.appendChild(actions);

    const validate = (): void => {
      const ok = settings.worlds.length > 0;
      worldsError.hidden = ok;
      startBtn.disabled = !ok || starting;
    };
    validate();

    const start = (): void => {
      if (settings.worlds.length === 0 || starting) return;
      starting = true;
      validate();
      saveSoloSettings(settings);
      void ctx.startSolo(settings).finally(() => {
        starting = false;
        if (page.alive) validate();
      });
    };
    startBtn.addEventListener('click', start);

    ctx.screens.page(screen, {
      rerender: render,
      cleanup: () => lang.destroy(),
      keys: (e) => {
        if (hasModifier(e) || e.repeat) return;
        if (e.key === 'Enter' && !isTypingTarget(e) && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          start();
        } else if (e.code === 'Space' && !isTypingTarget(e) && !isOwnSpaceTarget(e)) {
          e.preventDefault();
          start();
        }
      },
    });
  };
  render();
  return page;
}
