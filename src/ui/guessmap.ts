/**
 * Leaflet wrapper for the guess map (SPEC.md sections 4 and 9.4).
 *
 * Raster map under `L.CRS.Simple`: a full-resolution pixel (px, py) is `unproject([px, py], maxZoom)`.
 * Everything crossing the public API is in game coordinates; conversions live in ./mapcoords.ts.
 * Markers are `L.divIcon`s styled by a stylesheet injected once (no image URLs, nothing to 404).
 * `setExpanded` toggles the `gm-expanded` class on the container; the screens module decides what
 * sizes that class produces. The player's own zoom/pan survives collapse/expand cycles: the map is
 * only re-fitted to the whole island while the view is still untouched (fresh round), because a fit
 * made at the collapsed size would show a tiny island in the expanded widget.
 *
 * Several worlds (§9.4): one Leaflet map, one tile layer at a time, a tab strip above the map
 * (hidden when there is a single world). Switching tabs swaps the tile layer, bounds and max zoom
 * and restores that world's own view (first show = fit the world). The guess marker belongs to the
 * world it was placed on and only shows on that tab; the guess is the last marker placed. In result
 * mode the answer marker shows on the answer's tab; the dashed line is drawn only when guess and
 * answer are on the same world.
 *
 * Container layout: the container is given `display: flex; flex-direction: column`; the tab strip
 * is the first child, the Leaflet map (`.gm-canvas`) fills the rest. The container must be a sized
 * block element, as before.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GuessMapApi, GuessMapWorld, PlayerMarker, WorldGuess } from '../contracts';
import { worldBase } from '../data/manifest';
import { t, worldName } from '../i18n';
import { gameToLatLng, latLngToGame } from './mapcoords';

export type { GuessMapWorld, PlayerMarker, WorldGuess } from '../contracts';

const SEA_COLOUR = '#2a4d73';
/** The result view never zooms closer than this many levels below the native resolution: at native
 *  zoom one pixel is a few centimetres, the top-down render turns to mush and steep rock faces smear
 *  into stripes. Two levels below (~30 cm/px) still separates markers a few metres apart. */
const RESULT_ZOOM_BELOW_NATIVE = 2;
const STYLE_ID = 'gm-styles';
const STYLES = `
.gm-map { display: flex; flex-direction: column; background: ${SEA_COLOUR}; }
.gm-canvas { flex: 1 1 auto; min-height: 0; background: ${SEA_COLOUR}; }
/* Chrome draws hairline gaps between tiles (sea colour bleeds through), at integer zooms too on
   HiDPI; a transparent outline forces the tile edges onto whole device pixels. Verified visually. */
.gm-canvas .leaflet-tile { outline: 1px solid transparent; }
.gm-tabs { flex: none; display: flex; gap: 2px; padding: 0 0 2px; background: rgba(0, 0, 0, 0.35); }
.gm-tabs[hidden] { display: none; }
.gm-tab { position: relative; flex: 1 1 0; min-width: 0; padding: 4px 8px; font: 600 12px/1.3 system-ui, sans-serif;
  color: rgba(255, 255, 255, 0.65); background: rgba(255, 255, 255, 0.06); border: 0; border-bottom: 2px solid transparent;
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gm-tab:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }
.gm-tab:focus-visible { outline: 2px solid #f2c14e; outline-offset: -2px; }
.gm-tab-active { color: #fff; background: rgba(255, 255, 255, 0.16); border-bottom-color: #f2c14e; }
/* A dot on tabs that hold a marker (guess: blue, answer: gold). */
.gm-tab-dot { display: inline-block; width: 8px; height: 8px; margin-left: 6px; border-radius: 50%;
  border: 1px solid #fff; vertical-align: middle; }
.gm-tab-dot-guess { background: #2f80ed; }
.gm-tab-dot-answer { background: #f2c14e; }
/* Rooms: other players' guesses on this tab (one small dot per player, in their colour). */
.gm-tab-dot-player { width: 6px; height: 6px; margin-left: 3px; border-width: 1px; border-color: rgba(0, 0, 0, 0.7); }
.gm-pin { width: 18px; height: 18px; border-radius: 50%; box-sizing: border-box;
  border: 3px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.6); }
.gm-pin-guess { background: #2f80ed; }
.gm-pin-answer { background: #f2c14e; border-radius: 3px; transform: rotate(45deg); }
.gm-pin-player { border-width: 2px; overflow: hidden; }
`;

/** Inject the marker/background stylesheet once per document. */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function pinIcon(kind: 'guess' | 'answer'): L.DivIcon {
  return L.divIcon({ className: `gm-pin gm-pin-${kind}`, iconSize: [18, 18], iconAnchor: [9, 9] });
}

/** Another player's marker (rooms): a smaller pin in the player's colour. */
function playerIcon(color: string): L.DivIcon {
  const safe = /^#[0-9a-f]{3,8}$|^[a-z]+$|^(rgb|hsl)a?\([0-9.,%\s]+\)$/i.test(color) ? color : '#999';
  return L.divIcon({
    className: 'gm-pin gm-pin-player',
    html: `<span style="display:block;width:100%;height:100%;border-radius:50%;background:${safe}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

/** A world's own view, remembered across tab switches. `null` = not touched yet (fit on show). */
interface SavedView {
  center: L.LatLng;
  zoom: number;
}

export class GuessMap implements GuessMapApi {
  private worlds: GuessMapWorld[];
  private map: L.Map | null = null;
  private container: HTMLElement | null = null;
  private canvas: HTMLElement | null = null;
  private tabStrip: HTMLElement | null = null;
  private tileLayer: L.TileLayer | null = null;
  private imageBounds: L.LatLngBounds | null = null;
  private layers: L.LayerGroup | null = null;
  private active = '';
  private guess: WorldGuess | null = null;
  private result: { guess: WorldGuess | null; answer: WorldGuess; others: PlayerMarker[] } | null = null;
  private mode: 'guessing' | 'result' = 'guessing';
  private readonly listeners: Array<(p: WorldGuess) => void> = [];
  private readonly worldListeners: Array<(slug: string) => void> = [];
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-world view the player left; absent while a world's view is still untouched. */
  private readonly views = new Map<string, SavedView>();
  private programmatic = 0;

  /**
   * `worlds` in tab order (SPEC §9.4: the order of worlds.json, never depending on the round).
   */
  constructor(worlds: GuessMapWorld[]) {
    this.worlds = worlds.slice();
    if (this.worlds.length === 0) throw new Error('GuessMap: at least one world is required');
    this.active = this.worlds[0]!.slug;
  }

  /**
   * Create the Leaflet map inside `container` (an empty, sized block element). Synchronous.
   * `worlds` replaces the world list given to the constructor and selects its first tab.
   */
  init(container: HTMLElement, worlds?: GuessMapWorld[]): void {
    if (this.map) this.destroy();
    if (worlds) {
      this.worlds = worlds.slice();
      if (this.worlds.length === 0) throw new Error('GuessMap: at least one world is required');
      this.views.clear();
      // A new world list starts on its first tab (SPEC §9.4: never the round's own world).
      this.active = this.worlds[0]!.slug;
      if (this.guess && !this.world(this.guess.world)) this.guess = null;
      if (this.result && ((this.result.guess && !this.world(this.result.guess.world)) || !this.world(this.result.answer.world))) {
        this.result = null;
        this.mode = 'guessing';
      }
    }
    ensureStyles();
    container.classList.add('gm-map');
    this.container = container;

    const tabs = document.createElement('div');
    tabs.className = 'gm-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.hidden = this.worlds.length < 2;
    for (const w of this.worlds) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'gm-tab';
      tab.setAttribute('role', 'tab');
      tab.dataset.world = w.slug;
      // A narrow map may still clip a long name; the tooltip and accessible name keep it whole.
      const name = worldName(w.slug, w.name);
      tab.title = name;
      tab.setAttribute('aria-label', name);
      tab.appendChild(document.createTextNode(name));
      tab.addEventListener('click', () => {
        tab.blur();
        this.setActiveWorld(w.slug);
      });
      tabs.appendChild(tab);
    }
    container.appendChild(tabs);
    this.tabStrip = tabs;

    const canvas = document.createElement('div');
    canvas.className = 'gm-canvas';
    container.appendChild(canvas);
    this.canvas = canvas;

    const map = L.map(canvas, {
      crs: L.CRS.Simple,
      minZoom: -1,
      maxZoom: 0, // set per world in applyWorld()
      zoomSnap: 0.25,
      attributionControl: false,
      maxBoundsViscosity: 0.5,
    });
    this.map = map;
    this.layers = L.layerGroup().addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => this.handleClick(e.latlng));
    // Any move/zoom outside our own fitBounds/invalidateSize calls is the player's doing; remember
    // it for the active world so a tab switch and back restores it.
    map.on('moveend zoomend', () => {
      if (this.programmatic === 0 && this.map) {
        this.views.set(this.active, { center: this.map.getCenter(), zoom: this.map.getZoom() });
      }
    });

    this.applyWorld(this.active);
  }

  onGuess(cb: (p: WorldGuess) => void): void {
    this.listeners.push(cb);
  }

  /** Subscribe to tab switches (player click or `setActiveWorld`/`showResult`). */
  onWorldChanged(cb: (slug: string) => void): void {
    this.worldListeners.push(cb);
  }

  /** The last marker placed, with the world it sits on; `null` when no marker is placed. */
  getGuess(): WorldGuess | null {
    return this.guess;
  }

  /** Slug of the world whose tiles are shown. */
  getActiveWorld(): string {
    return this.active;
  }

  /** Slugs of the worlds, in tab order. */
  getWorlds(): string[] {
    return this.worlds.map((w) => w.slug);
  }

  /** Show `slug`'s tab: swap tiles/bounds/zoom range and restore that world's own view. */
  setActiveWorld(slug: string): void {
    if (!this.world(slug)) throw new Error(`GuessMap: unknown world "${slug}"`);
    if (slug === this.active && this.tileLayer) return;
    this.active = slug;
    if (this.map) this.applyWorld(slug);
    for (const cb of this.worldListeners) cb(slug);
  }

  clearGuess(): void {
    this.guess = null;
    this.result = null;
    this.mode = 'guessing';
    this.layers?.clearLayers();
    this.updateTabs();
  }

  /**
   * Switch to result mode. The answer's tab is shown with the answer marker; the player's guess (if any) on its own
   * tab, joined to the answer by a dashed line when both are on the same world; `others` adds every other player's
   * marker in its colour with the nickname as tooltip (rooms), with a thinner line to the answer. The view is fitted
   * to the answer and every guess on its world, or to the whole world when the answer is alone there.
   */
  showResult(guess: WorldGuess | null, answer: WorldGuess, others: PlayerMarker[] = []): void {
    const g = guess ? this.checkedWorld(guess) : null;
    const a = this.checkedWorld(answer);
    const known = others.filter((o) => !o.guess || this.world(o.guess.world));
    this.guess = g;
    this.result = { guess: g, answer: a, others: known };
    this.mode = 'result';
    if (!this.map) return;
    // The answer's tab (SPEC §9.5: a wrong-world guess keeps its marker on its own tab).
    if (a.world !== this.active) this.setActiveWorld(a.world);
    else this.redraw();
    const map = this.map;
    const cfg = this.world(this.active)!.map;
    const points = [a, ...(g && g.world === a.world ? [g] : []), ...known.flatMap((o) => (o.guess && o.guess.world === a.world ? [o.guess] : []))];
    this.run(() => {
      map.invalidateSize({ animate: false });
      if (points.length > 1) {
        const bounds = L.latLngBounds(points.map((p) => L.latLng(gameToLatLng(cfg, p))));
        map.fitBounds(bounds, { padding: [48, 48], maxZoom: cfg.maxZoom - RESULT_ZOOM_BELOW_NATIVE, animate: false });
      } else if (this.imageBounds) {
        map.fitBounds(this.imageBounds, { animate: false });
      }
    });
  }

  /** Fit the whole active world (its full map image) into the view and forget the player's view. */
  fitWorld(): void {
    const map = this.map;
    const bounds = this.imageBounds;
    if (!map || !bounds) return;
    this.run(() => {
      map.invalidateSize({ animate: false });
      map.fitBounds(bounds, { animate: false });
    });
    this.views.delete(this.active);
  }

  setExpanded(expanded: boolean): void {
    this.container?.classList.toggle('gm-expanded', expanded);
    this.refit(expanded);
    // The screens module may animate the size change; refresh once more after a typical transition.
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.refit(expanded), 300);
  }

  invalidateSize(): void {
    const map = this.map;
    if (map) this.run(() => map.invalidateSize({ animate: false }));
  }

  destroy(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.map?.remove();
    this.map = null;
    this.tileLayer = null;
    this.layers = null;
    this.imageBounds = null;
    this.tabStrip?.remove();
    this.tabStrip = null;
    this.canvas?.remove();
    this.canvas = null;
    this.container?.classList.remove('gm-map', 'gm-expanded');
    this.container = null;
  }

  // --- internals -------------------------------------------------------------------------

  private world(slug: string): GuessMapWorld | undefined {
    return this.worlds.find((w) => w.slug === slug);
  }

  /** A copy of `p` after checking that its world is on the map. */
  private checkedWorld(p: WorldGuess): WorldGuess {
    if (!this.world(p.world)) throw new Error(`GuessMap: unknown world "${p.world}"`);
    return { world: p.world, x: p.x, z: p.z };
  }

  /** Put `slug`'s tiles, bounds and zoom range on the map and show its remembered view. */
  private applyWorld(slug: string): void {
    const map = this.map;
    const w = this.world(slug);
    if (!map || !w) return;
    const cfg = w.map;

    this.tileLayer?.remove();
    const bounds = L.latLngBounds(
      map.unproject(L.point(0, 0), cfg.maxZoom),
      map.unproject(L.point(cfg.width, cfg.height), cfg.maxZoom),
    );
    this.imageBounds = bounds;
    map.setMaxZoom(cfg.maxZoom + 1);
    map.setMaxBounds(bounds.pad(0.25));
    this.tileLayer = L.tileLayer(`${worldBase(w.slug)}/${cfg.path}`, {
      tileSize: cfg.tileSize,
      // Same minZoom as the map: GridLayer's default minZoom is 0, and below it the layer drops
      // every tile (blank sea at zoom -1 after two clicks of the "-" control). minNativeZoom
      // makes zoom -1 reuse the z=0 tile scaled down.
      minZoom: -1,
      minNativeZoom: 0,
      maxNativeZoom: cfg.maxZoom,
      maxZoom: cfg.maxZoom + 1,
      noWrap: true,
      bounds,
    }).addTo(map);

    this.redraw();
    const saved = this.views.get(slug);
    if (saved) {
      this.run(() => {
        map.invalidateSize({ animate: false });
        map.setView(saved.center, saved.zoom, { animate: false });
      });
    } else {
      this.fitWorld();
    }
  }

  /** After a size change: keep the player's view, or re-fit the world while the view is untouched. */
  private refit(expanded: boolean): void {
    if (expanded && !this.views.has(this.active)) this.fitWorld();
    else this.invalidateSize();
  }

  /** Run a programmatic view change without it counting as a player interaction. */
  private run(fn: () => void): void {
    this.programmatic++;
    try {
      fn();
    } finally {
      this.programmatic--;
    }
  }

  /** Guessing mode: place or move the marker on the active world and notify. Result mode: ignore. */
  private handleClick(latlng: L.LatLng): void {
    if (this.mode !== 'guessing') return;
    const w = this.world(this.active);
    if (!w) return;
    const p = latLngToGame(w.map, latlng);
    this.guess = { world: this.active, x: p.x, z: p.z };
    this.redraw();
    for (const cb of this.listeners) cb(this.guess);
  }

  /** Re-create the markers of the active world from `guess` / `result` (after a click, a tab switch, a re-init). */
  private redraw(): void {
    const layers = this.layers;
    const w = this.world(this.active);
    if (!layers || !w) return;
    layers.clearLayers();
    const cfg = w.map;
    if (this.mode === 'result' && this.result) {
      const { guess, answer, others } = this.result;
      const onAnswer = answer.world === this.active;
      const al = L.latLng(gameToLatLng(cfg, answer));
      for (const o of others) {
        if (!o.guess || o.guess.world !== this.active) continue;
        const ol = L.latLng(gameToLatLng(cfg, o.guess));
        if (onAnswer) L.polyline([ol, al], { color: o.color, weight: 2, dashArray: '4 6', opacity: 0.8 }).addTo(layers);
        L.marker(ol, { icon: playerIcon(o.color), interactive: true, keyboard: false })
          .bindTooltip(o.name, { direction: 'top', offset: [0, -8] })
          .addTo(layers);
      }
      const onGuess = guess !== null && guess.world === this.active;
      if (onGuess && onAnswer) {
        const gl = L.latLng(gameToLatLng(cfg, guess));
        L.polyline([gl, al], { color: '#fff', weight: 3, dashArray: '8 8', opacity: 0.9 }).addTo(layers);
      }
      if (onGuess) L.marker(L.latLng(gameToLatLng(cfg, guess)), { icon: pinIcon('guess'), interactive: false }).addTo(layers);
      if (onAnswer) L.marker(al, { icon: pinIcon('answer'), interactive: false }).addTo(layers);
    } else if (this.guess && this.guess.world === this.active) {
      const ll = L.latLng(gameToLatLng(cfg, this.guess));
      L.marker(ll, { icon: pinIcon('guess'), interactive: false }).addTo(layers);
    }
    this.updateTabs();
  }

  /** Active tab highlight and the marker dots. */
  private updateTabs(): void {
    const strip = this.tabStrip;
    if (!strip) return;
    for (const tab of strip.querySelectorAll<HTMLButtonElement>('.gm-tab')) {
      const slug = tab.dataset.world ?? '';
      const isActive = slug === this.active;
      tab.classList.toggle('gm-tab-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
      tab.querySelectorAll('.gm-tab-dot').forEach((d) => d.remove());
      const dots: Array<'guess' | 'answer'> = [];
      if (this.mode === 'result' && this.result) {
        if (this.result.answer.world === slug) dots.push('answer');
        if (this.result.guess?.world === slug) dots.push('guess');
      } else if (this.guess?.world === slug) {
        dots.push('guess');
      }
      for (const kind of dots) {
        const dot = document.createElement('span');
        dot.className = `gm-tab-dot gm-tab-dot-${kind}`;
        dot.title = kind === 'guess' ? t('map.guessHere') : t('map.answerHere');
        tab.appendChild(dot);
      }
      if (this.mode === 'result' && this.result) {
        for (const o of this.result.others) {
          if (o.guess?.world !== slug) continue;
          const dot = document.createElement('span');
          dot.className = 'gm-tab-dot gm-tab-dot-player';
          dot.style.background = o.color;
          dot.title = o.name;
          tab.appendChild(dot);
        }
      }
    }
  }
}
