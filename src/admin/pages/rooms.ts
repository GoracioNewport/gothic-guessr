/**
 * Active rooms (SPEC §10.10): players, phase, activity; close a room (members get `room_closed`). Refreshes every 5 s.
 */
import type { AdminRoom, AdminRoomsView } from '../../../shared/api';
import { api, errorText } from '../api';
import { badge, button, confirmAction, empty, fmtAgo, fmtTime, h, mount, pageHeader, panel, table, toast } from '../dom';
import type { Page } from '../page';

const PHASE_TONE: Record<AdminRoom['phase'], 'muted' | 'blue' | 'gold' | 'green'> = { lobby: 'muted', round: 'blue', result: 'gold', over: 'green' };

export const roomsPage: Page = async (ctx) => {
  const host = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  const stamp = h('span', { class: 'muted' });
  mount(ctx.root, pageHeader('Rooms', h('span', {}, 'Live party and duel rooms (in memory). ', stamp)), panel(null, host));

  const draw = (view: AdminRoomsView): void => {
    stamp.textContent = `Updated ${new Date().toISOString().slice(11, 19)} UTC.`;
    if (!view.available) {
      mount(host, empty('The rooms module is not running on this server, so there is no live room data.'));
      return;
    }
    if (view.rooms.length === 0) {
      mount(host, empty('No active rooms.'));
      return;
    }
    mount(
      host,
      table<AdminRoom>(view.rooms, [
        { head: 'Code', cell: (r) => h('code', {}, r.code) },
        { head: 'Type', cell: (r) => r.type },
        { head: 'Phase', cell: (r) => badge(r.phase, PHASE_TONE[r.phase]) },
        {
          head: 'Players',
          cell: (r) =>
            r.players.length === 0
              ? '—'
              : h('span', { class: 'room-players' }, ...r.players.map((p) => h('span', { class: p.connected ? 'online' : 'offline', title: p.connected ? 'connected' : 'disconnected' }, p.nickname))),
        },
        { head: 'Created (UTC)', cell: (r) => fmtTime(r.createdAt) },
        { head: 'Last activity', cell: (r) => fmtAgo(r.lastActivityAt) },
        {
          head: '',
          class: 'actions',
          cell: (r) =>
            button(
              'Close',
              async () => {
                if (!confirmAction(`Close room ${r.code}? ${r.players.length} player(s) will be disconnected from it.`)) return;
                try {
                  draw(await api.closeRoom(r.code));
                  toast(`Room ${r.code} closed`);
                } catch (err) {
                  toast(errorText(err), 'error');
                }
              },
              { kind: 'danger', small: true },
            ),
        },
      ]),
    );
  };

  draw(await api.rooms());
  const timer = window.setInterval(async () => {
    try {
      const view = await api.rooms();
      if (ctx.isCurrent()) draw(view);
    } catch {
      /* keep the last list */
    }
  }, 5000);
  return () => window.clearInterval(timer);
};
