/**
 * Side-by-side panorama compression comparison: /dev/compare.html (Vite dev server only, `npm run dev`).
 *
 * Data: public/data/panos-cmp/ written by `uv run --with pillow python tools/make_compare.py` (a sample of nodes in
 * several encodings plus index.json with measured sizes). Each side is a plain Photo Sphere Viewer with the cubemap
 * tiles adapter; the panorama object comes from `panoramaConfig` in src/ui/panorama.ts (the game's own builder,
 * including `flipTopBottom`), fed with a layout whose path points at the variant's folder.
 *
 * Camera sync: the pane the user last touched (pointer, wheel, navbar) is the leader and only its position/zoom
 * events are mirrored to the other one, so the follower's own update events can never push the leader back.
 *
 * Query: ?node=<index>&left=<variant>&right=<variant>&yaw=<deg>&pitch=<deg>&zoom=<0..100>.
 * `window.__cmp` exposes the viewers and helpers for console experiments and the Playwright check.
 */
import '@photo-sphere-viewer/core/index.css';

import { Viewer } from '@photo-sphere-viewer/core';
import type { Position } from '@photo-sphere-viewer/core';
import { CubemapTilesAdapter } from '@photo-sphere-viewer/cubemap-tiles-adapter';

import type { PanoLayout } from '../src/contracts';
import { dataBase } from '../src/data/manifest';
import { panoramaConfig } from '../src/ui/panorama';

interface CmpNode {
  key: string;
  label: string;
  world: string;
  wp?: string;
}

interface CmpVariant {
  name: string;
  faceSize: number;
  tileSize: number;
  nbTiles: number;
  baseSize: number;
  quality: number;
  baseQuality: number;
  reencoded: boolean;
  avgKB: number;
  ratioToOrig: number;
  projectedGB: number;
  projectedScaledGB: number;
}

interface CmpIndex {
  note: string;
  path: string;
  base: string;
  tile: string;
  fullDataset: { nodes: number; measuredNodes: number; bytes: number; GB: number };
  sampleNodes: number;
  nodes: CmpNode[];
  variants: CmpVariant[];
}

type Side = 'left' | 'right';
const SIDES: Side[] = ['left', 'right'];
const DEG = Math.PI / 180;
/** Same as the game (src/ui/panorama.ts) except minFov: half-width panes need twice the zoom for the same texel density. */
const VIEWER_FOV = { minFov: 15, maxFov: 100 };
const DEFAULT_ZOOM = 20;

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} missing`);
  return el;
};

class Pane {
  readonly viewer: Viewer;
  readonly select: HTMLSelectElement;
  private readonly stats: HTMLElement;
  private readonly badge: HTMLElement;
  variant: CmpVariant;

  constructor(
    readonly side: Side,
    private readonly index: CmpIndex,
    variant: CmpVariant,
    onTouch: (side: Side) => void,
  ) {
    const root = $<HTMLElement>(`#pane-${side}`);
    this.select = $<HTMLSelectElement>('select.variant', root);
    this.stats = $<HTMLElement>('.stats', root);
    this.badge = $<HTMLElement>('.badge', root);
    this.variant = variant;
    for (const v of index.variants) this.select.add(new Option(v.name, v.name));
    this.select.value = variant.name;

    const host = $<HTMLElement>('.viewer', root);
    this.viewer = new Viewer({
      container: host,
      adapter: CubemapTilesAdapter.withConfig({ baseBlur: false, showErrorTile: false, antialias: true }),
      navbar: ['zoom', 'fullscreen'],
      defaultZoomLvl: DEFAULT_ZOOM,
      ...VIEWER_FOV,
      moveInertia: 0.7,
      keyboard: false,
      loadingTxt: '',
      canvasBackground: '#000',
    });
    // Capture phase: mark this pane as the sync leader before PSV handles the gesture.
    for (const type of ['pointerdown', 'wheel', 'touchstart']) {
      host.addEventListener(type, () => onTouch(side), { capture: true, passive: true });
    }
    this.renderInfo();
  }

  setVariant(v: CmpVariant): void {
    this.variant = v;
    this.select.value = v.name;
    this.renderInfo();
  }

  /** Show `node` with this pane's variant at the given camera (no transition, so both sides switch together). */
  async show(node: CmpNode, position: Position, zoom: number): Promise<void> {
    const v = this.variant;
    const layout: PanoLayout = {
      faceSize: v.faceSize,
      tileSize: v.tileSize,
      nbTiles: v.nbTiles,
      baseSize: v.baseSize,
      path: this.index.path.replace('{variant}', encodeURIComponent(v.name)),
      base: this.index.base,
      tile: this.index.tile,
      faces: ['front', 'right', 'back', 'left', 'top', 'bottom'],
    };
    await this.viewer.setPanorama(panoramaConfig(layout, node.key), {
      transition: false,
      showLoader: false,
      position,
      zoom,
    });
  }

  private renderInfo(): void {
    const v = this.variant;
    const tiles = v.nbTiles === 1 ? `1 tile of ${v.tileSize}` : `${v.nbTiles}×${v.nbTiles} tiles of ${v.tileSize}`;
    const pct = Math.round(v.ratioToOrig * 100);
    this.stats.innerHTML = [
      `<span><b>${v.faceSize}²</b>/face (${tiles})</span>`,
      `<span>WebP <b>q${v.quality}</b> (base ${v.baseSize}² q${v.baseQuality})</span>`,
      `<span><b>${Math.round(v.avgKB)} KB</b>/node (${pct}%)</span>`,
      `<span>dataset ≈ <b>${v.projectedGB.toFixed(1)} GB</b></span>`,
    ].join('');
    this.stats.title =
      `${v.name}: average over ${this.index.sampleNodes} sample nodes × ${this.index.fullDataset.nodes} nodes = ` +
      `${v.projectedGB} GB; scaled from the real dataset size (${this.index.fullDataset.GB} GB × ${v.ratioToOrig}) = ` +
      `${v.projectedScaledGB} GB` +
      (v.reencoded ? '. Re-encoded from the q78 originals.' : '. Published originals.');
    this.badge.textContent = v.name;
  }
}

async function main(): Promise<void> {
  const res = await fetch(`${dataBase()}/panos-cmp/index.json`);
  if (!res.ok) throw new Error(`panos-cmp/index.json: HTTP ${res.status}. Run: uv run --with pillow python tools/make_compare.py`);
  const index = (await res.json()) as CmpIndex;
  if (!index.nodes.length || !index.variants.length) throw new Error('panos-cmp/index.json has no nodes or variants');

  const params = new URLSearchParams(location.search);
  const variantByName = new Map(index.variants.map((v) => [v.name, v]));
  const pickVariant = (name: string | null, fallback: string): CmpVariant =>
    variantByName.get(name ?? '') ?? variantByName.get(fallback) ?? index.variants[0]!;

  let nodeIdx = Math.min(Math.max(Number(params.get('node')) || 0, 0), index.nodes.length - 1);
  let leader: Side = 'left';
  const initPos: Position = {
    yaw: (Number(params.get('yaw')) || 0) * DEG,
    pitch: (Number(params.get('pitch')) || 0) * DEG,
  };
  const initZoom = params.has('zoom') ? Number(params.get('zoom')) : DEFAULT_ZOOM;

  const panes: Record<Side, Pane> = {
    left: new Pane('left', index, pickVariant(params.get('left'), 'orig'), (s) => (leader = s)),
    right: new Pane('right', index, pickVariant(params.get('right'), 'f1536q70'), (s) => (leader = s)),
  };
  const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

  // --- camera sync -------------------------------------------------------------------------
  const EPS = 1e-5;
  for (const side of SIDES) {
    const v = panes[side].viewer;
    v.addEventListener('position-updated', ({ position }) => {
      if (side !== leader) return;
      const target = panes[other(side)].viewer;
      const cur = target.getPosition();
      if (Math.abs(cur.yaw - position.yaw) > EPS || Math.abs(cur.pitch - position.pitch) > EPS) target.rotate(position);
    });
    v.addEventListener('zoom-updated', ({ zoomLevel }) => {
      if (side !== leader) return;
      const target = panes[other(side)].viewer;
      if (Math.abs(target.getZoomLevel() - zoomLevel) > EPS) target.zoom(zoomLevel);
      renderFoot();
    });
  }

  // --- node selector -----------------------------------------------------------------------
  const nodeSelect = $<HTMLSelectElement>('#node');
  index.nodes.forEach((n, i) => nodeSelect.add(new Option(`${i + 1}. ${n.label}`, String(i))));

  const foot = $<HTMLElement>('#foot');
  function renderFoot(): void {
    const v = panes[leader].viewer;
    const fov = v.state.hFov;
    const w = v.state.size.width;
    const dpr = window.devicePixelRatio || 1;
    // Texels per device pixel at the view centre for a face of the given size (a face spans 90°).
    const density = (face: number): string =>
      ((face / 2 / Math.tan(45 * DEG)) / ((w * dpr) / 2 / Math.tan((fov / 2) * DEG))).toFixed(2);
    foot.innerHTML = [
      `<span>Horizontal FOV <b>${fov.toFixed(0)}°</b> in a ${Math.round(w)} px pane (DPR ${dpr}) — texels per device px: ` +
        `2048 → <b>${density(2048)}</b>, 1536 → <b>${density(1536)}</b>, 1024 → <b>${density(1024)}</b> (below 1 = upscaled)</span>`,
      `<span>Full dataset now: <b>${index.fullDataset.GB} GB</b> for ${index.fullDataset.measuredNodes} nodes; ` +
        `projections = sample average × ${index.fullDataset.nodes}</span>`,
      `<span title="${index.note}">Variants re-encoded from the q78 originals (slight generation loss vs a fresh render)</span>`,
    ].join('');
  }

  /**
   * Zoom both panes so the texel density at the view centre equals the full-window game at its vertical FOV
   * `gameVFov` (src/ui/panorama.ts: default zoom 20 = 86°, max zoom = 30°), assuming the game fills this window.
   */
  function matchGameFov(gameVFov: number): void {
    const v = panes[leader].viewer;
    const { width: pw, height: ph } = v.state.size;
    const gw = window.innerWidth;
    const gh = window.innerHeight;
    const gameHalfTan = Math.tan((gameVFov / 2) * DEG) * (gw / gh); // tan(hFov/2) of the game view
    const paneHalfTan = (gameHalfTan * pw) / gw; // same angle per pixel at the centre
    const paneVFov = (2 * Math.atan((paneHalfTan * ph) / pw)) / DEG;
    const { minFov, maxFov } = VIEWER_FOV;
    const zoom = ((maxFov - Math.min(maxFov, Math.max(minFov, paneVFov))) / (maxFov - minFov)) * 100;
    v.zoom(zoom);
  }

  function syncUrl(): void {
    const q = new URLSearchParams(location.search);
    q.set('node', String(nodeIdx));
    q.set('left', panes.left.variant.name);
    q.set('right', panes.right.variant.name);
    history.replaceState(null, '', `${location.pathname}?${q.toString()}`);
  }

  let loadSeq = 0;
  async function showAll(camera?: { position: Position; zoom: number }): Promise<void> {
    const seq = ++loadSeq;
    const node = index.nodes[nodeIdx]!;
    nodeSelect.value = String(nodeIdx);
    $<HTMLElement>('#counter').textContent = `${nodeIdx + 1} / ${index.nodes.length} · ${node.world}`;
    document.title = `Compare · ${node.label}`;
    syncUrl();
    const lead = panes[leader].viewer;
    const { position, zoom } = camera ?? { position: lead.getPosition(), zoom: lead.getZoomLevel() };
    await Promise.all(SIDES.map((s) => panes[s].show(node, position, zoom)));
    if (seq === loadSeq) renderFoot();
  }

  function step(delta: number): void {
    nodeIdx = (nodeIdx + delta + index.nodes.length) % index.nodes.length;
    void showAll().catch(showError);
  }

  function swap(): void {
    const l = panes.left.variant;
    panes.left.setVariant(panes.right.variant);
    panes.right.setVariant(l);
    void showAll().catch(showError);
  }

  nodeSelect.addEventListener('change', () => {
    nodeIdx = Number(nodeSelect.value);
    nodeSelect.blur();
    void showAll().catch(showError);
  });
  for (const side of SIDES) {
    const sel = panes[side].select;
    sel.addEventListener('change', () => {
      panes[side].setVariant(pickVariant(sel.value, 'orig'));
      sel.blur();
      void showAll().catch(showError);
    });
  }
  $<HTMLButtonElement>('#prev').addEventListener('click', () => step(-1));
  $<HTMLButtonElement>('#next').addEventListener('click', () => step(1));
  $<HTMLButtonElement>('#game-default').addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).blur();
    matchGameFov(86);
  });
  $<HTMLButtonElement>('#game-max').addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).blur();
    matchGameFov(30);
  });
  $<HTMLButtonElement>('#swap').addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).blur();
    swap();
  });

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1);
      else if (e.key === ' ') swap();
      else return;
      // Also keeps a focused <select> or button from acting on the key.
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  window.addEventListener('resize', () => renderFoot());

  // First load: both panes start at the camera from the query.
  await showAll({ position: initPos, zoom: initZoom });

  Object.assign(window, {
    __cmp: {
      index,
      panes,
      viewers: { left: panes.left.viewer, right: panes.right.viewer },
      /** Set the camera on one side (default left) and let the sync mirror it; angles in degrees. */
      look(yawDeg: number, pitchDeg: number, zoom?: number, side: Side = 'left'): void {
        leader = side;
        const v = panes[side].viewer;
        v.rotate({ yaw: yawDeg * DEG, pitch: pitchDeg * DEG });
        if (zoom !== undefined) v.zoom(zoom);
      },
      matchGameFov,
      goTo(i: number): Promise<void> {
        nodeIdx = i;
        return showAll();
      },
      swap,
    },
  });
}

function showError(err: unknown): void {
  console.error(err);
  const box = $<HTMLElement>('#error');
  box.style.display = 'block';
  box.textContent = String(err instanceof Error ? err.message : err);
}

main().catch(showError);
