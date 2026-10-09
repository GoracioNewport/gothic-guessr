/**
 * Standalone harness for the panorama viewer against the real API: /dev/pano.html (needs `npm run dev`).
 *
 * Stage 3: the client has no graph. The harness creates (or reuses) a player, starts a solo game with the settings
 * from the query (`?mode=…&worlds=a,b&nomove=1&nolook=1`, default all worlds/Mixed), opens round 1 and feeds the
 * viewer from `GET /api/games/:id/nodes/:key`. The overlay shows the current key, its links and the camera
 * direction; `window.__pano` exposes the view and the API client for console experiments.
 */
import '@photo-sphere-viewer/core/index.css';

import type { GameMode, PanoNode } from '../shared/api';
import { loadPublicWorlds, loadedSlugs, panoLayout } from '../src/data/worlds';
import { ApiClient } from '../src/net/api';
import { PanoramaView, viewerYawToGameYaw } from '../src/ui/panorama';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

function log(msg: string): void {
  console.log(`[pano] ${msg}`);
  const line = document.createElement('div');
  line.textContent = msg;
  const box = $('log');
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

const nodes = new Map<string, PanoNode>();

function renderHud(view: PanoramaView): void {
  const hud = $('hud');
  const key = view.getCurrentKey();
  if (!key) {
    hud.textContent = 'no node yet';
    return;
  }
  const node = nodes.get(key);
  const pos = view.getViewer()?.getPosition();
  const rows = [
    `node <b>${key}</b>`,
    pos
      ? `camera: viewer yaw ${((pos.yaw * 180) / Math.PI).toFixed(1)}° → game yaw ${viewerYawToGameYaw(pos.yaw).toFixed(1)}°, pitch ${((pos.pitch * 180) / Math.PI).toFixed(1)}°`
      : 'camera: n/a',
    'links:',
    ...(node?.links ?? []).map((l) => `  → ${l.key}  yaw ${l.yaw.toFixed(1).padStart(6)}°  pitch ${l.pitch.toFixed(1).padStart(5)}°`),
  ];
  hud.innerHTML = rows.map((r) => `<div class="row">${r}</div>`).join('');
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const worlds = await loadPublicWorlds();
  const layout = panoLayout(worlds);
  if (!layout) throw new Error('no world.json loaded');
  const api = new ApiClient();
  const slugs = params.get('worlds')?.split(',').filter((s) => loadedSlugs(worlds).includes(s)) ?? loadedSlugs(worlds);
  const noLook = params.get('nolook') === '1';
  const game = await api.createGame({
    kind: 'solo',
    settings: {
      mode: (params.get('mode') as GameMode | null) ?? 'mixed',
      worlds: slugs.length ? slugs : loadedSlugs(worlds),
      noMove: noLook || params.get('nomove') === '1',
      noLook,
      timeLimit: 0,
      rounds: 5,
    },
  });
  const round = await api.openRound(game.id);
  log(`game ${game.id}, round ${round.n}, start ${round.start.key}`);

  const view = new PanoramaView(layout, async (key) => {
    const node = await api.getNode(game.id, key);
    nodes.set(key, node);
    log(`GET node ${key}: ${node.links.length} links`);
    return node;
  });
  (window as unknown as { __pano: unknown }).__pano = { view, api, game, round };

  view.onNodeChanged((key) => {
    log(`node-changed → ${key}`);
    renderHud(view);
  });
  await view.init($('pano'));
  view.getViewer()?.addEventListener('position-updated', () => renderHud(view));

  $<HTMLInputElement>('goto-id').value = round.start.key;
  const go = (instant: boolean): void => {
    const key = $<HTMLInputElement>('goto-id').value.trim();
    log(`goTo(${key}${instant ? ', instant' : ''})`);
    view.goTo(key, { instant }).then(
      () => log(`goTo(${key}) resolved`),
      (err: unknown) => log(`goTo(${key}) rejected: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  $('goto').onclick = () => go(false);
  $('goto-instant').onclick = () => go(true);
  $('freeze').onclick = () => {
    view.setMovementEnabled(false);
    log('movement disabled');
  };
  $('unfreeze').onclick = () => {
    view.setMovementEnabled(true);
    log('movement enabled');
  };
  $('nolook').onclick = () => {
    view.setLookEnabled(false);
    log('look disabled (camera frozen)');
  };
  $('look').onclick = () => {
    view.setLookEnabled(true);
    log('look enabled');
  };
  if (game.settings.noMove) view.setMovementEnabled(false);
  if (game.settings.noLook) view.setLookEnabled(false);
  await view.goTo(round.start.key, { resetView: true });
  log('start node shown');
}

void main().catch((err: unknown) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
});
