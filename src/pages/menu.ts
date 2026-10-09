/**
 * Main menu (SPEC §10.7, route `/`): the Gothic II logo, nickname with inline edit, language selector, Quick play
 * (→ solo setup), Daily challenge with today's status, Multiplayer (create a room / join by code; handled by the
 * rooms module, src/pages/room.ts), how to play, and the Legal link (src/ui/legal.ts) at the bottom.
 * The backdrop (the Night of the Raven start screen) comes from `.g2-centered` in style.css.
 */
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROUND_COUNTS } from '../../shared/api';
import type { ChallengeView, PlayerView } from '../../shared/api';
import { formatNumber, getLanguage, t } from '../i18n';
import { button, el, formatScore, hasModifier, isTypingTarget, logo } from '../ui/dom';
import { createLangSelect } from '../ui/langselect';
import { NicknameEditor } from '../ui/nickname';
import { legalLink } from '../ui/legal';
import type { AppContext, Page } from './context';
import { pageScope } from './context';
import { rooms } from './room';

const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/**
 * A room code as typed → the server's format (exactly 5 letters of the room alphabet, no I/O; server/core/random.ts),
 * or null. Case, spaces and dashes are forgiven.
 */
export function normaliseRoomCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s\-_.]/g, '');
  return ROOM_CODE_RE.test(code) ? code : null;
}

type DailyStatus = { state: 'loading' } | { state: 'error' } | { state: 'ok'; view: ChallengeView };

export function menuPage(ctx: AppContext): Page {
  const page = pageScope();
  let player: PlayerView | null = ctx.player();
  let daily: DailyStatus = { state: 'loading' };
  // UI state that survives a language re-render (the nickname editor keeps its own).
  const nickEditor = new NicknameEditor({ api: ctx.api, player: () => player, loadPlayer: false, onSaved: (p) => (player = p) });
  let friendsOpen = false;
  let code = '';
  let codeError = '';
  let howToOpen = false;

  const render = (): void => {
    if (!page.alive) return;
    const screen = el('div', 'g2-screen g2-centered g2-menu');
    const lang = createLangSelect({ corner: true });
    screen.appendChild(lang.root);
    const card = el('div', 'g2-card g2-menu-card');
    screen.appendChild(card);
    card.appendChild(logo());
    card.appendChild(el('h1', 'g2-title', t('app.title')));
    card.appendChild(el('p', 'g2-tagline', t('start.tagline')));

    // --- nickname (src/ui/nickname.ts)
    card.appendChild(nickEditor.element());

    // --- main entries
    const entries = el('nav', 'g2-menu-entries');
    const entry = (label: string, hint: string, onClick: () => void, cls = ''): HTMLButtonElement => {
      const btn = el('button', `g2-btn g2-menu-entry ${cls}`.trim());
      btn.type = 'button';
      btn.appendChild(el('span', 'g2-menu-entry-label', label));
      btn.appendChild(el('span', 'g2-menu-entry-hint', hint));
      btn.addEventListener('click', () => {
        btn.blur();
        onClick();
      });
      entries.appendChild(btn);
      return btn;
    };
    entry(t('menu.play'), t('menu.playHint'), () => ctx.router.navigate('/play'), 'g2-btn-primary g2-menu-play');
    entry(t('menu.daily'), dailyLine(daily), () => ctx.router.navigate('/daily'), 'g2-menu-daily');
    const friends = entry(t('menu.friends'), t('menu.friendsHint'), () => {
      friendsOpen = !friendsOpen;
      // One panel at a time: both open do not fit the card at 1280×720.
      if (friendsOpen) howToOpen = false;
      render();
      document.querySelector<HTMLElement>('.g2-menu-friends')?.focus();
    });
    friends.classList.add('g2-menu-friends');
    friends.setAttribute('aria-expanded', String(friendsOpen));
    card.appendChild(entries);

    if (friendsOpen) {
      const panel = el('div', 'g2-friends');
      const create = el('div', 'g2-friends-create');
      // One button: the room starts as a normal one, the host picks the type (normal / duel) in the lobby.
      const room = button(t('menu.createRoom'), 'g2-btn g2-btn-secondary', () => void rooms.create(ctx));
      room.title = t('menu.createRoomHint');
      create.append(room);
      panel.appendChild(create);
      const join = el('form', 'g2-join');
      const label = el('label', 'g2-join-label', t('menu.joinByCode'));
      const input = el('input', 'g2-input g2-join-code');
      input.type = 'text';
      input.value = code;
      input.placeholder = t('menu.codePlaceholder');
      input.maxLength = 8;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.id = 'g2-join-code';
      label.htmlFor = input.id;
      input.autocapitalize = 'characters';
      input.addEventListener('input', () => {
        // Codes are upper case: show them that way while typing (caret kept).
        const upper = input.value.toUpperCase();
        if (upper !== input.value) {
          const { selectionStart, selectionEnd } = input;
          input.value = upper;
          input.setSelectionRange(selectionStart, selectionEnd);
        }
        code = input.value;
      });
      const go = el('button', 'g2-btn g2-btn-primary g2-btn-small', t('menu.join'));
      go.type = 'submit';
      join.append(label, input, go);
      join.addEventListener('submit', (e) => {
        e.preventDefault();
        const normal = normaliseRoomCode(input.value);
        if (!normal) {
          codeError = t('menu.codeInvalid');
          render();
          return;
        }
        codeError = '';
        ctx.router.navigate({ name: 'room', code: normal });
      });
      panel.appendChild(join);
      if (codeError) panel.appendChild(el('p', 'g2-field-error', codeError));
      card.appendChild(panel);
    }

    // --- how to play
    const how = el('details', 'g2-howto-box');
    how.open = howToOpen;
    how.addEventListener('toggle', () => {
      howToOpen = how.open;
      if (howToOpen && friendsOpen) {
        friendsOpen = false;
        render();
        document.querySelector<HTMLElement>('.g2-howto-summary')?.focus();
      }
    });
    how.appendChild(el('summary', 'g2-legend g2-howto-summary', t('menu.howToPlay')));
    const list = el('ul', 'g2-howto');
    for (const line of [
      t('start.howto.look'),
      t('start.howto.walk'),
      t('start.howto.guess'),
      // Quick play offers 3, 5 or 10 rounds: "3, 5 or 10 rounds, up to 5,000 points each".
      t('start.howto.rounds', { rounds: roundChoices(), max: formatScore(5000) }),
      t('menu.howto.timer'),
      t('menu.howto.daily'),
    ]) {
      list.appendChild(el('li', undefined, line));
    }
    how.appendChild(list);
    card.appendChild(how);
    screen.appendChild(legalLink());

    ctx.screens.page(screen, {
      rerender: render,
      cleanup: () => lang.destroy(),
      keys: (e) => {
        if (isTypingTarget(e) || hasModifier(e) || e.repeat) return;
        if (e.key === 'Enter' && document.activeElement === document.body) {
          e.preventDefault();
          ctx.router.navigate('/play');
        }
      },
    });
  };

  render();
  void ctx.api
    .me()
    .then((p) => {
      player = p;
      render();
    })
    .catch(() => undefined);
  void ctx.api
    .daily()
    .then((view) => {
      daily = { state: 'ok', view };
      render();
    })
    .catch(() => {
      daily = { state: 'error' };
      render();
    });
  return page;
}

/** The status line of the Daily entry: your score, in progress, or not played. */
function dailyLine(daily: DailyStatus): string {
  if (daily.state !== 'ok') return t('menu.dailyHint');
  const mine = daily.view.myGame;
  if (!mine) return t('menu.dailyNotPlayed');
  if (!mine.finished) return t('menu.dailyInProgress');
  return t('menu.dailyPlayed', { score: formatScore(mine.total) });
}

/** "3, 5 or 10" in the active language (the quick play round counts). */
function roundChoices(): string {
  const counts = ROUND_COUNTS.map((n) => formatNumber(n));
  try {
    return new Intl.ListFormat(getLanguage(), { type: 'disjunction' }).format(counts);
  } catch {
    return counts.join(', ');
  }
}
