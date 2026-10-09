/**
 * Inline SVG charts for the dashboard (SPEC §10.10: no chart library). Two forms over a per-day x axis:
 * - {@link lineChart}: a few series of one unit (page views and visitors) with a crosshair tooltip;
 * - {@link barChart}: stacked bars (games by kind) or a single series, with a per-day tooltip.
 * One y axis with a "nice" maximum, recessive grid, 2 px lines, bars with rounded tops and 2 px gaps between stacked
 * segments, a legend for 2+ series. Charts re-render on resize (ResizeObserver) so text is never stretched.
 * Series colours are CSS custom properties (`--s1`…`--s5` in admin.css), assigned in fixed order.
 */
import { fmtNum, h } from './dom';

export interface Series {
  name: string;
  /** CSS colour, e.g. `var(--s1)`. */
  color: string;
  values: number[];
}

export interface ChartSpec {
  /** YYYY-MM-DD per x position. */
  days: string[];
  series: Series[];
  height?: number;
  /** Accessible label of the whole chart. */
  label: string;
  /** Show a Total row in the tooltip (stacked bars). */
  total?: boolean;
}

const SVG = 'http://www.w3.org/2000/svg';
const M = { top: 10, right: 12, bottom: 24, left: 40 };

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Axis maximum for counts: 4 × a "nice" integer step (1, 2, 2.5, 3, 4, 5, 6, 8 × 10^k, never fractional), so the 4 grid lines
 * fall on whole numbers.
 */
export function niceMax(max: number): number {
  const raw = Math.max(1, max) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const step = m * p;
    if (step >= raw && Number.isInteger(step)) return step * 4;
  }
  return 10 * p * 4;
}

const shortDay = (d: string): string => d.slice(5);

/** Indices of the x labels to print: first, last and evenly spaced ones without collisions. */
function labelIndices(n: number, width: number): number[] {
  const fit = Math.max(2, Math.floor(width / 56));
  if (n <= fit) return [...Array(n).keys()];
  const step = Math.ceil((n - 1) / (fit - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  if (out[out.length - 1] !== n - 1) {
    if (n - 1 - out[out.length - 1]! < step * 0.9) out.pop();
    out.push(n - 1);
  }
  return out;
}

function legend(series: Series[]): HTMLElement | null {
  if (series.length < 2) return null;
  return h(
    'div',
    { class: 'legend' },
    ...series.map((se) => h('span', { class: 'legend-item' }, swatch(se.color), se.name)),
  );
}

function swatch(color: string): HTMLElement {
  const sw = h('span', { class: 'swatch' });
  sw.style.background = color;
  return sw;
}

/** Shared frame: wrapper, legend, svg host and tooltip; `draw(width)` fills the svg. */
function frame(spec: ChartSpec, draw: (svg: SVGSVGElement, width: number, height: number, tip: Tooltip) => void): HTMLElement {
  const height = spec.height ?? 200;
  const host = h('div', { class: 'chart-plot' });
  const tipEl = h('div', { class: 'chart-tip', role: 'presentation' });
  const wrap = h('figure', { class: 'chart' }, legend(spec.series), host, tipEl);
  const tip = new Tooltip(tipEl, host, spec);
  let lastWidth = 0;
  const render = (): void => {
    const width = Math.max(240, Math.floor(host.clientWidth || 600));
    if (width === lastWidth) return;
    lastWidth = width;
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': spec.label });
    draw(svg, width, height, tip);
    host.replaceChildren(svg);
  };
  // Draw once attached (clientWidth is 0 before), then on every resize.
  const ro = new ResizeObserver(() => render());
  ro.observe(host);
  requestAnimationFrame(render);
  return wrap;
}

/** Grid lines + y labels + x labels; returns the scales. */
function axes(svg: SVGSVGElement, spec: ChartSpec, width: number, height: number, max: number, band: boolean) {
  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const n = spec.days.length;
  const x = band
    ? (i: number): number => M.left + (iw / n) * (i + 0.5)
    : (i: number): number => M.left + (n <= 1 ? iw / 2 : (iw / (n - 1)) * i);
  const y = (v: number): number => M.top + ih - (v / max) * ih;
  const g = s('g', { class: 'axis' });
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    const yy = Math.round(y(v)) + 0.5;
    g.appendChild(s('line', { x1: M.left, x2: width - M.right, y1: yy, y2: yy, class: k === 0 ? 'baseline' : 'gridline' }));
    const t = s('text', { x: M.left - 6, y: yy + 4, 'text-anchor': 'end' });
    t.textContent = fmtNum(Math.round(v * 10) / 10);
    g.appendChild(t);
  }
  for (const i of labelIndices(n, iw)) {
    const anchor = n > 1 && i === 0 && !band ? 'start' : n > 1 && i === n - 1 && !band ? 'end' : 'middle';
    const t = s('text', { x: x(i), y: height - 6, 'text-anchor': anchor });
    t.textContent = shortDay(spec.days[i]!);
    g.appendChild(t);
  }
  svg.appendChild(g);
  return { x, y, iw, ih, n };
}

class Tooltip {
  constructor(
    private readonly el: HTMLElement,
    private readonly host: HTMLElement,
    private readonly spec: ChartSpec,
  ) {}

  show(i: number, px: number): void {
    const rows = this.spec.series.map((se) =>
      h('div', { class: 'tip-row' }, swatch(se.color), h('span', {}, se.name), h('b', {}, fmtNum(se.values[i] ?? 0))),
    );
    const total =
      this.spec.total && this.spec.series.length > 1
        ? h('div', { class: 'tip-row tip-total' }, h('span', {}, 'Total'), h('b', {}, fmtNum(this.spec.series.reduce((a, se) => a + (se.values[i] ?? 0), 0))))
        : null;
    this.el.replaceChildren(h('div', { class: 'tip-date' }, this.spec.days[i]!), ...rows, total ?? '');
    this.el.style.display = 'block';
    const w = this.el.offsetWidth;
    const left = Math.min(Math.max(0, px + 12), this.host.clientWidth - w);
    this.el.style.left = `${px + 12 + w > this.host.clientWidth ? Math.max(0, px - w - 12) : left}px`;
    this.el.style.top = `${M.top + 24}px`;
  }

  hide(): void {
    this.el.style.display = 'none';
  }
}

/** Per-day hit targets across the whole plot height. */
function hover(svg: SVGSVGElement, n: number, x: (i: number) => number, iw: number, ih: number, tip: Tooltip, onIndex?: (i: number | null) => void): void {
  const w = iw / Math.max(1, n);
  const g = s('g', { class: 'hit' });
  for (let i = 0; i < n; i++) {
    const r = s('rect', { x: x(i) - w / 2, y: M.top, width: w, height: ih, fill: 'transparent' });
    r.addEventListener('mouseenter', () => {
      onIndex?.(i);
      tip.show(i, x(i));
    });
    g.appendChild(r);
  }
  g.addEventListener('mouseleave', () => {
    onIndex?.(null);
    tip.hide();
  });
  svg.appendChild(g);
}

export function lineChart(spec: ChartSpec): HTMLElement {
  return frame(spec, (svg, width, height, tip) => {
    const max = niceMax(Math.max(0, ...spec.series.flatMap((se) => se.values)));
    const { x, y, iw, ih, n } = axes(svg, spec, width, height, max, false);
    for (const se of spec.series) {
      const d = se.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      svg.appendChild(s('path', { d, fill: 'none', stroke: se.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (n === 1) svg.appendChild(s('circle', { cx: x(0), cy: y(se.values[0] ?? 0), r: 4, fill: se.color }));
    }
    const cross = s('line', { y1: M.top, y2: M.top + ih, class: 'crosshair', visibility: 'hidden' });
    const dots = spec.series.map((se) => s('circle', { r: 4, fill: se.color, class: 'hover-dot', visibility: 'hidden' }));
    svg.append(cross, ...dots);
    hover(svg, n, x, iw, ih, tip, (i) => {
      const vis = i === null ? 'hidden' : 'visible';
      cross.setAttribute('visibility', vis);
      dots.forEach((dot) => dot.setAttribute('visibility', vis));
      if (i === null) return;
      cross.setAttribute('x1', String(x(i)));
      cross.setAttribute('x2', String(x(i)));
      spec.series.forEach((se, k) => {
        dots[k]!.setAttribute('cx', String(x(i)));
        dots[k]!.setAttribute('cy', String(y(se.values[i] ?? 0)));
      });
    });
  });
}

/** Rounded-top rect path (radius r on the top corners only). */
function topRounded(x: number, y: number, w: number, hgt: number, r: number): string {
  const rr = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

export function barChart(spec: ChartSpec): HTMLElement {
  return frame(spec, (svg, width, height, tip) => {
    const n = spec.days.length;
    const totals = spec.days.map((_, i) => spec.series.reduce((a, se) => a + (se.values[i] ?? 0), 0));
    const max = niceMax(Math.max(0, ...totals));
    const { x, y, iw, ih } = axes(svg, spec, width, height, max, true);
    const bw = Math.max(2, Math.min(28, (iw / n) * 0.7));
    const GAP = 2;
    const g = s('g', { class: 'bars' });
    for (let i = 0; i < n; i++) {
      let base = 0;
      const visible = spec.series.map((se) => se.values[i] ?? 0).map((v, k) => ({ v, k })).filter((e) => e.v > 0);
      visible.forEach(({ v, k }, idx) => {
        const y0 = y(base);
        const y1 = y(base + v);
        const top = idx === visible.length - 1;
        const hgt = Math.max(1, y0 - y1 - (idx > 0 ? GAP : 0));
        const attrs = { fill: spec.series[k]!.color };
        if (top) g.appendChild(s('path', { ...attrs, d: topRounded(x(i) - bw / 2, y1, bw, hgt, 4) }));
        else g.appendChild(s('rect', { ...attrs, x: x(i) - bw / 2, y: y1, width: bw, height: hgt }));
        base += v;
      });
    }
    svg.appendChild(g);
    hover(svg, n, x, iw, ih, tip);
  });
}

/** A horizontal "top N" list with inline bars (referrers, paths). */
export function topList(rows: { label: string; count: number }[], emptyText: string): HTMLElement {
  if (rows.length === 0) return h('p', { class: 'empty' }, emptyText);
  const max = Math.max(...rows.map((r) => r.count));
  return h(
    'ol',
    { class: 'toplist' },
    ...rows.map((r) => {
      const bar = h('span', { class: 'toplist-bar' });
      bar.style.width = `${(r.count / max) * 100}%`;
      return h('li', {}, h('span', { class: 'toplist-label', title: r.label }, r.label), h('span', { class: 'toplist-track' }, bar), h('b', {}, fmtNum(r.count)));
    }),
  );
}
