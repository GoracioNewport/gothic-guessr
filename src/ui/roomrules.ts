/**
 * The rules block of the room lobby (SPEC §10.1, §10.6): the shared rules panel (src/ui/rulespanel.ts, kind `party`
 * for a normal room or `duel`) with the numbers of the settings shown, plus a few lines only a room has (how many
 * players, what happens after a round, dropping out, leaving a duel). The lobby is rebuilt on every settings change,
 * so the block follows the host's edits.
 */
import type { PublicSettings, RoomType } from '../../shared/api';
import { formatNumber, t } from '../i18n';
import { el } from './dom';
import { PARTY_CAPACITY } from './roomstate';
import { rulesPanel } from './rulespanel';

/** A room-only line: its rule id, the shared line it follows (null = first), its text. */
interface ExtraLine {
  id: string;
  after: string | null;
  text: string;
}

/** The room-only lines for `type`, each placed after a line of the shared panel. Exported for tests. */
export function roomExtraLines(type: RoomType): ExtraLine[] {
  if (type === 'duel') {
    return [
      { id: 'room.duel.players', after: null, text: t('roomRules.duel.players') },
      // Replaces the shared `duel.forfeit` line (disconnect only): leaving forfeits too.
      { id: 'room.duel.leave', after: 'duel.countdown', text: t('roomRules.duel.leave') },
    ];
  }
  return [
    { id: 'room.party.players', after: null, text: t('roomRules.party.players', { count: formatNumber(PARTY_CAPACITY) }) },
    { id: 'room.party.results', after: 'party.endEarly', text: t('roomRules.party.results') },
    { id: 'room.party.away', after: 'room.party.results', text: t('roomRules.party.away') },
  ];
}

/** The rules block: `<aside class="g2-panel g2-rules g2-room-rules">`, its heading names the room type. */
export function roomRulesBlock(type: RoomType, settings: PublicSettings, typeTitle: string): HTMLElement {
  // `duel.forfeit` is replaced by a room line; `worlds` repeats the world checkboxes right next to the panel and is
  // dropped so the block fits 1280×720.
  const panel = rulesPanel(settings, { kind: type, filter: (line) => line.id !== 'duel.forfeit' && line.id !== 'worlds' });
  const root = panel.root;
  root.classList.add('g2-room-rules');
  root.querySelector('.g2-rules-heading')?.append(' ', el('span', 'g2-room-rules-type', typeTitle));
  const list = root.querySelector('.g2-rules-list');
  if (!list) return root;
  for (const extra of roomExtraLines(type)) {
    const li = el('li', 'g2-rules-line', extra.text);
    li.dataset.rule = extra.id;
    const anchor = extra.after === null ? null : list.querySelector(`[data-rule="${extra.after}"]`);
    if (extra.after === null) list.prepend(li);
    else if (anchor) anchor.after(li);
    else list.appendChild(li);
  }
  return root;
}
