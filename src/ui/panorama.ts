/**
 * Photo Sphere Viewer wrapper: cubemap tiles adapter + virtual tour plugin (SPEC.md sections 3 and 10.7).
 *
 * Stage 3: the client knows no graph. Nodes are opaque keys; a {@link PanoNodeProvider} (the game's
 * `GET /api/games/:id/nodes/:key`, which applies the server's reach check) hands out one node at a time with
 * its links, and the plugin runs in "server" data mode with an async `getNode`. Tiles come from
 * `<data base>/panos/<key>/…` with the layout of `world.json` `pano` (the same for every world, so one viewer
 * serves a whole game across worlds without knowing which world it shows).
 *
 * Plugin node ids are `<generation>:<key>`: {@link PanoramaView.setProvider} (a new game) bumps the generation,
 * so the plugin's own node cache can never serve a node of an earlier game.
 *
 * The plugin's `preload` is off because it would fetch every neighbour through `getNode`, i.e. through the API,
 * which both spends the rate limit and moves the server's resume position to a node the player never visited.
 * Instead the base faces of linked nodes are preloaded straight from their tile URLs (keys are all that is needed).
 * When the plugin shows a node from its cache (walking back), the provider is still called once in the background
 * so the server's resume position (`GameView.currentKey`) follows the player.
 *
 * Yaw convention (verified empirically with the harbour sample, see docs/VIEWER_NOTES.md): Photo Sphere Viewer
 * yaw 0 is the centre of the `front` face and yaw grows clockwise when seen from above, exactly like the API's
 * "degrees clockwise from north". The conversion lives in src/game/graph.ts (`gameYawToViewerYaw`).
 *
 * Load failures: a missing base face fails the whole node inside the plugin, which clears the arrows and shows its
 * error overlay. Every load is therefore retried once, and if that fails too a "Retry" hint is shown; when the
 * failed node was a neighbour of the displayed one, that node's arrows are restored so the player can walk on.
 */
import { Viewer } from '@photo-sphere-viewer/core';
import { CubemapTilesAdapter } from '@photo-sphere-viewer/cubemap-tiles-adapter';
import type { CubemapTilesPanorama } from '@photo-sphere-viewer/cubemap-tiles-adapter';
import { VirtualTourPlugin } from '@photo-sphere-viewer/virtual-tour-plugin';
import type { VirtualTourNode, VirtualTourTransitionOptions } from '@photo-sphere-viewer/virtual-tour-plugin';
import '@photo-sphere-viewer/virtual-tour-plugin/index.css';

import type { CubeFace, GoToOptions, PanoLayout, PanoNodeData, PanoNodeProvider, PanoramaViewApi } from '../contracts';
import { dataBase } from '../data/manifest';
import { t } from '../i18n';
import { gamePitchToViewerPitch, gameYawToViewerYaw } from '../game/graph';

export { gamePitchToViewerPitch, gameYawToViewerYaw };

const DEG = Math.PI / 180;

/** Duration of the fade between two nodes, in milliseconds. */
const FADE_MS = 350;
/** Pause before a failed node load is retried, in milliseconds. */
const RETRY_DELAY_MS = 400;
/** PSV zoom level (0..100) used on start and whenever the camera is reset. */
const DEFAULT_ZOOM = 20;
/**
 * Navbar buttons with free look; with the camera frozen the navbar is empty and hidden by style.css
 * (`.pano-frozen`). No fullscreen button: PSV fullscreens only its own element, which would hide the guess map,
 * the Guess button and the HUD.
 */
const NAVBAR = ['zoom'];

/** Viewer yaw (radians) → API yaw (degrees clockwise from north, [0, 360)). Debug helper. */
export function viewerYawToGameYaw(rad: number): number {
  const deg = (rad / DEG) % 360;
  return deg < 0 ? deg + 360 : deg;
}

/** URL of one tile file of node `key` (`file` is the layout's `base` or `tile` name, placeholders filled). */
export function panoFileUrl(layout: PanoLayout, key: string, file: string): string {
  return `${dataBase()}/${layout.path.replace('{key}', encodeURIComponent(key)).replace('{id}', encodeURIComponent(key))}/${file}`;
}

/** Cubemap tiles configuration for node `key` (SPEC.md section 2 layout, §10.3 paths). Exported for tests. */
export function panoramaConfig(layout: PanoLayout, key: string): CubemapTilesPanorama {
  const baseFace = (face: CubeFace): string => panoFileUrl(layout, key, layout.base.replace('{face}', face));
  return {
    faceSize: layout.faceSize,
    nbTiles: layout.nbTiles,
    // The pipeline's top/bottom faces (top: image-up = south, bottom: image-up = north, the classic cross
    // layout) are rotated 180° from what the adapter expects. Verified in docs/VIEWER_NOTES.md.
    flipTopBottom: true,
    baseUrl: {
      front: baseFace('front'),
      right: baseFace('right'),
      back: baseFace('back'),
      left: baseFace('left'),
      top: baseFace('top'),
      bottom: baseFace('bottom'),
    },
    tileUrl: (face, col, row) =>
      panoFileUrl(
        layout,
        key,
        layout.tile.replace('{face}', face).replace('{col}', String(col)).replace('{row}', String(row)),
      ),
  };
}

const noProvider: PanoNodeProvider = (key) => Promise.reject(new Error(`PanoramaView: no node provider (node ${key})`));

export class PanoramaView implements PanoramaViewApi {
  private readonly layout: PanoLayout;
  private provider: PanoNodeProvider;
  /** Bumped by setProvider; part of every plugin node id. */
  private generation = 0;
  /** Nodes fetched in this generation (links of the displayed node, restoring arrows). */
  private nodes = new Map<string, PanoNodeData>();
  /** Key of the last provider call: an arrival at another key re-syncs the server position. */
  private lastFetched: string | null = null;
  /** Element the viewer is created in; moved into every new container handed to {@link init}. */
  private host: HTMLDivElement | null = null;
  private viewer: Viewer | null = null;
  private tour: VirtualTourPlugin | null = null;
  private currentKey: string | null = null;
  private movementEnabled = true;
  private lookEnabled = true;
  private readonly listeners = new Set<(key: string) => void>();
  /** Plugin node id behind every panorama object handed to the viewer, to identify `panorama-error`s. */
  private readonly panoramaNode = new WeakMap<object, string>();
  /** Plugin id a programmatic load (goTo, retry) is working on; its failures are handled by that load. */
  private loading: string | null = null;
  private loadSeq = 0;
  private retryHint: HTMLElement | null = null;
  private readonly preloaded = new Set<string>();
  /** An arrow click is moving to another node (cleared on arrival). */
  private walking = false;

  constructor(layout: PanoLayout, provider: PanoNodeProvider = noProvider) {
    this.layout = layout;
    this.provider = provider;
  }

  init(container: HTMLElement): Promise<void> {
    if (this.viewer && this.host) {
      // Already created: move the viewer's host into the new container. PSV observes its own inner element for
      // resizes, and a canvas keeps its WebGL context across DOM moves.
      if (this.host.parentElement !== container) container.appendChild(this.host);
      this.viewer.autoSize();
      return Promise.resolve();
    }

    const host = document.createElement('div');
    host.className = 'pano-host';
    host.style.width = '100%';
    host.style.height = '100%';
    container.appendChild(host);
    this.host = host;

    this.viewer = new Viewer({
      container: host,
      adapter: CubemapTilesAdapter.withConfig({ baseBlur: false, showErrorTile: false, antialias: true }),
      plugins: [
        VirtualTourPlugin.withConfig({
          dataMode: 'server',
          positionMode: 'manual',
          renderMode: '3d',
          getNode: (id) => this.buildNode(id),
          preload: false,
          // Arrow clicks: short fade, camera direction is kept (no rotation towards the link).
          transitionOptions: () => keepDirectionTransition(false),
          showLinkTooltip: false,
          linksOnCompass: false,
          arrowsPosition: { minPitch: 0.2, maxPitch: Math.PI / 2, linkOverlapAngle: Math.PI / 6 },
          arrowStyle: { size: { width: 64, height: 64 } },
        }),
      ],
      navbar: [...NAVBAR],
      defaultZoomLvl: DEFAULT_ZOOM,
      minFov: 30,
      maxFov: 100,
      moveInertia: 0.7,
      loadingTxt: '',
      canvasBackground: '#000',
    });

    this.tour = this.viewer.getPlugin(VirtualTourPlugin);
    this.tour.addEventListener('node-changed', (e) => this.arrived(String(e.node.id)));
    host.addEventListener(
      'click',
      (e) => {
        if (e.target instanceof Element && e.target.closest('.psv-virtual-tour-link')) this.walking = true;
      },
      true,
    );
    this.viewer.addEventListener('panorama-error', (e) => this.handlePanoramaError(e.panorama));

    this.applyMovementEnabled();
    this.applyLookEnabled();
    return Promise.resolve();
  }

  setProvider(provider: PanoNodeProvider): void {
    this.provider = provider;
    this.generation++;
    this.nodes = new Map();
    this.lastFetched = null;
    this.currentKey = null;
    this.walking = false;
    this.preloaded.clear();
  }

  async goTo(key: string, opts?: GoToOptions): Promise<void> {
    if (!this.tour) throw new Error('PanoramaView: init() has not been called');
    const first = this.currentKey === null;
    const options: VirtualTourTransitionOptions & { forceUpdate?: boolean } = keepDirectionTransition(first || opts?.instant === true);
    if (first || opts?.resetView) {
      if (this.lookEnabled) {
        // First node of a round: face the first link so the player sees a way forward.
        const node = await this.fetchNode(key);
        const link = node.links[0];
        options.rotateTo = { yaw: link ? gameYawToViewerYaw(link.yaw) : 0, pitch: 0 };
      } else {
        // Frozen camera: the initial direction is north, pitch 0, at the default zoom.
        options.rotateTo = { yaw: 0, pitch: 0 };
        options.zoomTo = DEFAULT_ZOOM;
      }
      options.showLoader = true;
    }
    // While a walk runs the plugin still holds the node it is leaving as current, and setCurrentNode() to that
    // node is a no-op: "Return to start" pressed during the walk would be dropped and the walk would finish.
    if (this.walking && key === this.currentKey) options.forceUpdate = true;
    return this.load(this.pluginId(key), options);
  }

  getCurrentKey(): string | null {
    return this.currentKey;
  }

  onNodeChanged(cb: (key: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  setMovementEnabled(enabled: boolean): void {
    this.movementEnabled = enabled;
    this.applyMovementEnabled();
  }

  isMovementEnabled(): boolean {
    return this.movementEnabled;
  }

  /**
   * Enable or disable free look (SPEC §9.2 "No look"). When disabled the camera is frozen: mouse, touch and
   * keyboard rotation and wheel zoom are off, the zoom control is hidden, and the view is put at the initial
   * direction (north, pitch 0) at the default zoom.
   */
  setLookEnabled(enabled: boolean): void {
    this.lookEnabled = enabled;
    this.applyLookEnabled();
    if (!enabled && this.viewer && this.currentKey !== null) {
      this.viewer.rotate({ yaw: 0, pitch: 0 });
      this.viewer.zoom(DEFAULT_ZOOM);
    }
  }

  isLookEnabled(): boolean {
    return this.lookEnabled;
  }

  destroy(): void {
    if (!this.viewer) return;
    this.hideRetryHint();
    this.loading = null;
    this.viewer.destroy();
    this.host?.remove();
    this.host = null;
    this.viewer = null;
    this.tour = null;
    this.currentKey = null;
    this.listeners.clear();
  }

  /** The underlying viewer, for the dev harness and debugging only. */
  getViewer(): Viewer | null {
    return this.viewer;
  }

  // --- nodes -------------------------------------------------------------------------------

  private pluginId(key: string): string {
    return `${this.generation}:${key}`;
  }

  /** Key of a plugin id of the current generation, or null for a stale one. */
  private keyOf(id: string): string | null {
    const sep = id.indexOf(':');
    if (sep < 0 || id.slice(0, sep) !== String(this.generation)) return null;
    return id.slice(sep + 1);
  }

  /** Ask the provider for `key` (always a real call: it also moves the server's resume position). */
  private async fetchNode(key: string): Promise<PanoNodeData> {
    const generation = this.generation;
    this.lastFetched = key;
    const node = await this.provider(key);
    if (generation === this.generation) this.nodes.set(key, node);
    return node;
  }

  /** The plugin's `getNode`: the node fetched by goTo moments ago, else a provider call. */
  private async buildNode(id: string): Promise<VirtualTourNode> {
    const key = this.keyOf(id);
    if (key === null) throw new Error(`PanoramaView: stale node ${id}`);
    const node = this.lastFetched === key ? (this.nodes.get(key) ?? (await this.fetchNode(key))) : await this.fetchNode(key);
    const panorama = panoramaConfig(this.layout, key);
    this.panoramaNode.set(panorama, id);
    return {
      id,
      panorama,
      links: node.links
        .filter((l) => l.key !== key)
        .map((l) => ({
          nodeId: this.pluginId(l.key),
          position: { yaw: gameYawToViewerYaw(l.yaw), pitch: gamePitchToViewerPitch(l.pitch) },
        })),
    };
  }

  private arrived(id: string): void {
    const key = this.keyOf(id);
    if (key === null) return;
    this.currentKey = key;
    this.walking = false;
    // Shown from the plugin's cache (walking back): tell the server where the player stands.
    if (this.lastFetched !== key) void this.fetchNode(key).catch(() => undefined);
    this.preloadNeighbours(key);
    for (const cb of [...this.listeners]) cb(key);
  }

  /** Fetch the base faces of the linked nodes from their tile URLs, so arrow clicks fade in at once. */
  private preloadNeighbours(key: string): void {
    const viewer = this.viewer;
    const node = this.nodes.get(key);
    if (!viewer || !node || !this.movementEnabled) return;
    for (const link of node.links) {
      if (this.preloaded.has(link.key)) continue;
      this.preloaded.add(link.key);
      viewer.textureLoader.preloadPanorama(panoramaConfig(this.layout, link.key)).catch(() => this.preloaded.delete(link.key));
    }
  }

  // --- movement / look ---------------------------------------------------------------------

  /**
   * Show or hide the 3D arrows container. A `display: none` container has no hit-testable arrows, so hiding it
   * both removes the arrows and makes link clicks impossible; `pointer-events: none` is a second guard.
   */
  private applyMovementEnabled(): void {
    const arrows = this.viewer?.container.querySelector<HTMLElement>('.psv-virtual-tour-arrows');
    if (!arrows) return;
    arrows.style.display = this.movementEnabled ? '' : 'none';
    arrows.style.pointerEvents = this.movementEnabled ? '' : 'none';
  }

  private applyLookEnabled(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const on = this.lookEnabled;
    viewer.setOptions({
      mousemove: on,
      mousewheel: on,
      keyboard: on ? 'fullscreen' : false,
      navbar: on ? [...NAVBAR] : [],
    });
    viewer.container.classList.toggle('pano-frozen', !on);
  }

  // --- loading and failure recovery ------------------------------------------------------

  private async load(id: string, options: VirtualTourTransitionOptions & { forceUpdate?: boolean }, attempts = 2): Promise<void> {
    const tour = this.tour;
    if (!tour) throw new Error('PanoramaView: init() has not been called');
    this.hideRetryHint();
    const seq = ++this.loadSeq;
    this.loading = id;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await tour.setCurrentNode(id, options);
          return;
        } catch (err) {
          if (attempt >= attempts || !this.tour || this.keyOf(id) === null) {
            if (this.tour && this.keyOf(id) !== null) {
              this.showRetryHint(id, options);
              this.restoreArrows(id);
            }
            throw err;
          }
          console.warn(`PanoramaView: node ${id} failed to load, retrying`, err);
          await sleep(RETRY_DELAY_MS);
        }
      }
    } finally {
      if (this.loadSeq === seq) this.loading = null;
    }
  }

  /** A node the plugin tried to load after an arrow click failed: retry once, then hint. */
  private handlePanoramaError(panorama: unknown): void {
    if (this.loading !== null) return;
    const id = typeof panorama === 'object' && panorama ? this.panoramaNode.get(panorama) : undefined;
    if (id === undefined || this.keyOf(id) === null || this.keyOf(id) === this.currentKey) return;
    window.setTimeout(() => {
      if (this.loading !== null || this.keyOf(id) === null || this.keyOf(id) === this.currentKey) return;
      this.load(id, keepDirectionTransition(false), 1).catch(() => undefined);
    }, RETRY_DELAY_MS);
  }

  /**
   * After a failed walk the plugin has cleared the arrows of the node still on screen. Reloading that node in
   * place (`forceUpdate`, no transition, textures from cache) brings them back. Skipped for jumps (round start,
   * return to start): then the error overlay stays until Retry succeeds.
   */
  private restoreArrows(failedId: string): void {
    const tour = this.tour;
    const current = this.currentKey;
    const failed = this.keyOf(failedId);
    if (!tour || current === null || failed === null) return;
    if (!this.nodes.get(current)?.links.some((l) => l.key === failed)) return;
    const hint = this.retryHint;
    const seq = ++this.loadSeq;
    const id = this.pluginId(current);
    this.loading = id;
    tour
      .setCurrentNode(id, { ...keepDirectionTransition(true), forceUpdate: true })
      .catch((err: unknown) => console.warn(`PanoramaView: could not restore node ${current}`, err))
      .then(() => {
        if (this.loadSeq === seq) this.loading = null;
        if (hint && this.retryHint === hint) this.host?.appendChild(hint);
      });
  }

  private showRetryHint(id: string, options: VirtualTourTransitionOptions): void {
    this.hideRetryHint();
    const host = this.host;
    if (!host) return;
    const hint = document.createElement('div');
    hint.className = 'pano-retry';
    Object.assign(hint.style, {
      position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, 48px)', zIndex: '120',
      display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderRadius: '8px',
      background: 'rgba(20, 20, 20, 0.85)', color: '#eee', font: '14px system-ui, sans-serif',
    });
    hint.appendChild(document.createTextNode(t('pano.loadFailed')));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t('pano.retry');
    Object.assign(btn.style, {
      padding: '6px 14px', borderRadius: '6px', border: '1px solid #777', background: '#2f80ed',
      color: '#fff', font: 'inherit', cursor: 'pointer',
    });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      this.load(id, options).catch(() => undefined);
    });
    hint.appendChild(btn);
    host.appendChild(hint);
    this.retryHint = hint;
  }

  private hideRetryHint(): void {
    this.retryHint?.remove();
    this.retryHint = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transition options that keep the current camera direction. `rotateTo`/`zoomTo` are set to undefined on
 * purpose: they override the plugin's default (rotate towards the clicked link).
 */
function keepDirectionTransition(instant: boolean): VirtualTourTransitionOptions {
  return {
    effect: instant ? 'none' : 'fade',
    speed: FADE_MS,
    rotation: false,
    rotateTo: undefined,
    zoomTo: undefined,
    showLoader: false,
  };
}
