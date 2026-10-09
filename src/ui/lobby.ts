/**
 * The room lobby (SPEC §10.6, §10.7, route `/r/<CODE>`): invite link and code, the players (n/capacity, host crown,
 * "you", disconnected, Kick for the host), the settings (editable by the host: room type, worlds, mode, No move /
 * No look, time limit, rounds 3/5/10 for a party; read-only for everyone else), Start (host; a duel needs exactly two
 * connected players) and Leave. After a game the lobby also links the last game's challenge. The room type (normal or
 * duel) is picked here by the host; a new room starts as a normal one. The rules of the chosen type sit in their own
 * block to the right of the card (src/ui/roomrules.ts over the shared src/ui/rulespanel.ts, below it on narrow
 * screens) and follow the settings.
 *
 * Plain DOM: {@link lobbyScreen} builds the whole screen from a {@link LobbyModel}; the room page rebuilds it on
 * every room change (it restores the focused control by its `data-focus` key).
 */
import type { GameMode, PublicSettings, RoomType, RoomView } from '../../shared/api';
import { TIME_LIMITS } from '../../shared/api';
import type { WorldIndexEntry } from '../contracts';
import { formatTimeLimit, t, worldName } from '../i18n';
import { challengeLink } from '../play/share';
import { button, copyField, el, settingsList } from './dom';
import { createLangSelect } from './langselect';
import { legalLink } from './legal';
import { playerName } from './roomhud';
import { roomRulesBlock } from './roomrules';
import { withRules } from './rulespanel';
import { DUEL_ROUND_CAP, startBlock } from './roomstate';
import { applyToggleRules } from './screens';

export const PARTY_ROUND_OPTIONS: readonly number[] = [3, 5, 10];
/** Round time limit a room gets when the host switches to its type (a new room: src/ui/roompage.ts newRoomSettings). */
export const DEFAULT_TIME_LIMIT: Readonly<Record<RoomType, number>> = { party: 120, duel: 0 };
export { DUEL_ROUND_CAP };
const MODES: readonly GameMode[] = ['classic', 'mixed', 'hardcore'];

export interface LobbyModel {
  room: RoomView;
  me: string | null;
  /** Settings and type to show (the host's unsent edits win over the room's). */
  type: RoomType;
  settings: PublicSettings;
  colors: ReadonlyMap<string, string>;
  /** worlds.json entries and the loaded slugs. */
  worlds: readonly WorldIndexEntry[];
  slugs: readonly string[];
  /** A start request is on its way. */
  starting: boolean;
}

export interface LobbyActions {
  onSettings(type: RoomType, settings: PublicSettings): void;
  onKick(playerId: string, nickname: string): void;
  onStart(): void;
  onLeave(): void;
}

/**
 * Settings valid for `type`: a duel always has the round cap, a party one of 3/5/10 (5 when switching from a duel).
 * Exported for tests.
 */
export function settingsForType(type: RoomType, settings: PublicSettings): PublicSettings {
  if (type === 'duel') return { ...settings, rounds: DUEL_ROUND_CAP };
  return { ...settings, rounds: PARTY_ROUND_OPTIONS.includes(settings.rounds) ? settings.rounds : 5 };
}

/**
 * The host switches the room type: the settings for the new type with its default time limit (a normal room 2 min,
 * a duel none: its rounds end after the first guess's countdown or the 5 min cap). Exported for tests.
 */
export function switchType(from: RoomType, to: RoomType, settings: PublicSettings): PublicSettings {
  if (from === to) return settingsForType(to, settings);
  return settingsForType(to, { ...settings, timeLimit: DEFAULT_TIME_LIMIT[to] });
}

/** The room type's display name: "Normal room" / "Duel". */
export function roomTypeTitle(type: RoomType): string {
  return t(type === 'duel' ? 'room.duel' : 'room.normalRoom');
}

/** The room's invite link (`<origin>/r/<CODE>`). */
export function inviteLink(code: string, origin: string = location.origin): string {
  return `${origin}/r/${encodeURIComponent(code.toUpperCase())}`;
}

/** A group of pill radios (mode, time, rounds, type) with a `data-focus` key per option. */
function pills<T extends string | number>(
  name: string,
  legend: string,
  options: readonly T[],
  value: T,
  label: (v: T) => string,
  onPick: (v: T) => void,
  /** Options that cannot be picked now, with the reason shown as a tooltip. */
  blocked: ReadonlyMap<T, string> = new Map(),
): HTMLFieldSetElement {
  const field = el('fieldset', 'g2-mode g2-room-field');
  field.appendChild(el('legend', 'g2-legend', legend));
  const row = el('div', 'g2-mode-pills');
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', legend);
  for (const opt of options) {
    const pill = el('label', `g2-pill${opt === value ? ' g2-pill-active' : ''}`);
    const radio = el('input', 'g2-pill-input');
    radio.type = 'radio';
    radio.name = `g2-room-${name}`;
    radio.value = String(opt);
    radio.checked = opt === value;
    radio.dataset.focus = `${name}:${opt}`;
    const reason = blocked.get(opt);
    if (reason !== undefined && opt !== value) {
      radio.disabled = true;
      pill.classList.add('g2-pill-disabled');
      pill.title = reason;
    }
    radio.addEventListener('change', () => {
      if (radio.checked) onPick(opt);
    });
    pill.append(radio, el('span', 'g2-pill-label', label(opt)));
    row.appendChild(pill);
  }
  field.appendChild(row);
  return field;
}

/** The host's settings form. */
function settingsForm(model: LobbyModel, actions: LobbyActions): HTMLElement {
  const { type, settings } = model;
  const form = el('div', 'g2-room-settings');
  const emit = (nextType: RoomType, next: PublicSettings): void => actions.onSettings(nextType, settingsForType(nextType, next));

  // A duel holds two players: with more in the room the host has to kick first.
  const blocked = new Map<RoomType, string>();
  if (model.room.players.length > 2) blocked.set('duel', t('room.duelTooMany'));
  form.appendChild(
    pills<RoomType>(
      'type',
      t('room.type'),
      ['party', 'duel'],
      type,
      (v) => t(v === 'party' ? 'room.party' : 'room.duel'),
      (v) => emit(v, switchType(type, v, settings)),
      blocked,
    ),
  );

  // Worlds: compact checkboxes, at least one stays on.
  const worlds = el('fieldset', 'g2-room-field g2-room-worlds');
  worlds.appendChild(el('legend', 'g2-legend', t('start.worlds')));
  const list = el('div', 'g2-room-world-list');
  for (const info of model.worlds) {
    const available = model.slugs.includes(info.slug);
    const on = available && settings.worlds.includes(info.slug);
    const label = el('label', `g2-toggle g2-room-world${on ? ' g2-toggle-on' : ''}`);
    const box = el('input', 'g2-toggle-box');
    box.type = 'checkbox';
    box.checked = on;
    box.disabled = !available || (on && settings.worlds.length === 1);
    box.dataset.focus = `world:${info.slug}`;
    box.addEventListener('change', () => {
      const chosen = new Set(settings.worlds);
      if (box.checked) chosen.add(info.slug);
      else chosen.delete(info.slug);
      const next = model.slugs.filter((s) => chosen.has(s));
      if (next.length === 0) {
        box.checked = true;
        return;
      }
      emit(type, { ...settings, worlds: next });
    });
    label.append(box, el('span', 'g2-toggle-name', worldName(info.slug, info.name)));
    list.appendChild(label);
  }
  worlds.appendChild(list);
  form.appendChild(worlds);

  form.appendChild(pills<GameMode>('mode', t('start.mode'), MODES, settings.mode, (m) => t(`mode.${m}`), (m) => emit(type, { ...settings, mode: m })));

  const toggles = el('fieldset', 'g2-room-field g2-room-toggles');
  toggles.appendChild(el('legend', 'g2-legend', t('start.challenge')));
  const toggleList = el('div', 'g2-room-toggle-list');
  toggles.appendChild(toggleList);
  const toggle = (flag: 'noMove' | 'noLook', name: string, hint: string): void => {
    const label = el('label', `g2-toggle${settings[flag] ? ' g2-toggle-on' : ''}`);
    label.title = hint;
    const box = el('input', 'g2-toggle-box');
    box.type = 'checkbox';
    box.checked = settings[flag];
    box.dataset.focus = `toggle:${flag}`;
    box.addEventListener('change', () => emit(type, { ...settings, ...applyToggleRules(settings, { [flag]: box.checked }) }));
    label.append(box, el('span', 'g2-toggle-name', name));
    toggleList.appendChild(label);
  };
  toggle('noMove', t('start.noMove'), t('start.noMove.hint'));
  toggle('noLook', t('start.noLook'), t('start.noLook.hint'));
  form.appendChild(toggles);

  form.appendChild(
    pills<number>('time', t('start.timeLimit'), TIME_LIMITS, settings.timeLimit, (v) => formatTimeLimit(v), (v) =>
      emit(type, { ...settings, timeLimit: v }),
    ),
  );

  if (type === 'party') {
    form.appendChild(
      pills<number>('rounds', t('settings.rounds'), PARTY_ROUND_OPTIONS, settings.rounds, (v) => String(v), (v) => emit(type, { ...settings, rounds: v })),
    );
  }
  return form;
}

/** The lobby screen. */
export function lobbyScreen(model: LobbyModel, actions: LobbyActions): { screen: HTMLElement; destroy(): void } {
  const { room, me } = model;
  const host = room.players.find((p) => p.host)?.id ?? null;
  const amHost = host !== null && host === me;

  const screen = el('div', 'g2-screen g2-centered g2-room-lobby');
  const lang = createLangSelect({ corner: true });
  screen.appendChild(lang.root);
  const card = el('div', 'g2-card g2-card-wide g2-room-card');

  const head = el('div', 'g2-summary-head g2-room-head');
  head.appendChild(el('h1', 'g2-heading', `${roomTypeTitle(model.type)} · ${t('room.lobby')}`));
  const codeBox = el('span', 'g2-room-code');
  codeBox.append(el('span', 'g2-room-code-label', `${t('room.code')}:`), el('span', 'g2-room-code-value', room.code));
  head.appendChild(codeBox);
  card.appendChild(head);

  const invite = el('section', 'g2-share g2-room-invite');
  invite.appendChild(el('p', 'g2-muted g2-share-hint', t('room.inviteHint')));
  invite.appendChild(copyField(inviteLink(room.code), { label: t('room.copyInvite'), className: 'g2-room-invite-link' }));
  card.appendChild(invite);

  const body = el('div', 'g2-room-body');
  card.appendChild(body);

  // --- players
  const players = el('section', 'g2-room-players');
  players.appendChild(el('h3', 'g2-legend', t('room.players', { count: room.players.length, capacity: room.capacity })));
  const list = el('ul', 'g2-room-player-list');
  for (const p of room.players) {
    const li = el('li', `g2-room-player${p.connected ? '' : ' g2-room-player-away'}${p.id === me ? ' g2-room-player-me' : ''}`);
    li.dataset.player = p.id;
    const crown = el('span', 'g2-room-crown', p.host ? '♛' : '');
    if (p.host) {
      crown.title = t('room.host');
      crown.setAttribute('aria-label', t('room.host'));
    } else crown.setAttribute('aria-hidden', 'true');
    li.appendChild(crown);
    li.appendChild(playerName(p.nickname, model.colors.get(p.id), p.id === me));
    if (!p.connected) li.appendChild(el('span', 'g2-room-away', t('room.disconnected')));
    if (amHost && p.id !== me) {
      const kick = button(t('room.kick'), 'g2-btn g2-btn-secondary g2-btn-small g2-room-kick', () => actions.onKick(p.id, p.nickname));
      kick.dataset.focus = `kick:${p.id}`;
      li.appendChild(kick);
    }
    list.appendChild(li);
  }
  players.appendChild(list);
  if (room.players.length < 2) players.appendChild(el('p', 'g2-muted', t('room.waitingPlayers')));
  // The last game's challenge link sits under the players (the right column is the tall one).
  if (room.challengeCode) {
    const last = el('section', 'g2-share g2-room-last');
    last.appendChild(el('h3', 'g2-legend', t('room.letFriendsPlay')));
    last.appendChild(copyField(challengeLink(room.challengeCode), { label: t('share.copyLink'), className: 'g2-share-link' }));
    players.appendChild(last);
  }
  body.appendChild(players);

  // --- settings
  const settingsBox = el('section', 'g2-room-settings-box');
  settingsBox.appendChild(el('h3', 'g2-legend', t('room.settings')));
  if (amHost) settingsBox.appendChild(settingsForm(model, actions));
  else {
    settingsBox.appendChild(settingsList(model.settings, model.slugs));
    settingsBox.appendChild(el('p', 'g2-muted g2-room-hint', t('room.settingsHostOnly')));
  }
  body.appendChild(settingsBox);

  // --- actions
  const block = startBlock({ ...room, type: model.type }, me);
  const status = el('p', 'g2-muted g2-room-status');
  status.setAttribute('aria-live', 'polite');
  if (block === 'notHost') status.textContent = t('room.waitingHost');
  else if (block === 'needTwo') status.textContent = t('room.needTwo');
  else if (block === 'noPlayers') status.textContent = t('room.waitingPlayers');
  card.appendChild(status);

  const row = el('div', 'g2-actions g2-actions-end g2-room-actions');
  const leave = button(t('room.leave'), 'g2-btn g2-btn-secondary g2-room-leave', () => actions.onLeave());
  leave.dataset.focus = 'leave';
  row.appendChild(leave);
  if (amHost) {
    const start = button(t('room.start'), 'g2-btn g2-btn-primary g2-btn-big g2-room-start', () => actions.onStart());
    start.dataset.focus = 'start';
    start.disabled = block !== null || model.starting;
    row.appendChild(start);
  }
  card.appendChild(row);
  // The rules of the shown type and settings to the right of the card (src/ui/roomrules.ts).
  const layout = withRules(card, roomRulesBlock(model.type, model.settings, roomTypeTitle(model.type)));
  layout.classList.add('g2-room-layout');
  screen.appendChild(layout);
  screen.appendChild(legalLink());
  return { screen, destroy: () => lang.destroy() };
}
