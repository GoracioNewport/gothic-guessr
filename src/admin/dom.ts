/**
 * Tiny DOM toolkit of the admin SPA: an element factory, formatters and a few shared widgets (badges, empty states,
 * toasts, confirm). Plain DOM, no framework, like the game client.
 */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** `h('a', {href: '/x', class: 'btn', onclick: fn}, 'text', child)`. `false`/null/undefined attrs and children are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2), value);
    } else if (value === true) {
      el.setAttribute(name, '');
    } else {
      el.setAttribute(name, String(value));
    }
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Replace all children. */
export function mount(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}

const NUM = new Intl.NumberFormat('en-US');
export const fmtNum = (n: number): string => NUM.format(n);

/** `2026-10-07 14:03` in UTC (the admin works in UTC days). */
export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** `3m 12s` / `850 ms`. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** `5 min ago`. */
export function fmtAgo(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return `${Math.floor(d / 86_400_000)} d ago`;
}

export function badge(text: string, tone: 'gold' | 'red' | 'green' | 'muted' | 'blue' = 'muted'): HTMLElement {
  return h('span', { class: `badge badge-${tone}` }, text);
}

export function empty(text: string): HTMLElement {
  return h('p', { class: 'empty' }, text);
}

/** A page header: title + optional subtitle + right-side actions. */
export function pageHeader(title: string, subtitle?: string | Node | null, ...actions: Child[]): HTMLElement {
  return h(
    'header',
    { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'sub' }, subtitle) : null),
    actions.length ? h('div', { class: 'page-actions' }, ...actions) : null,
  );
}

export function panel(title: string | null, ...children: Child[]): HTMLElement {
  return h('section', { class: 'panel' }, title ? h('h2', {}, title) : null, ...children);
}

export function button(
  label: string,
  onclick: (ev: MouseEvent) => void | Promise<void>,
  opts: { kind?: 'primary' | 'danger' | 'ghost'; title?: string; small?: boolean } = {},
): HTMLButtonElement {
  const b = h('button', {
    type: 'button',
    class: ['btn', opts.kind ? `btn-${opts.kind}` : '', opts.small ? 'btn-sm' : ''].filter(Boolean).join(' '),
    title: opts.title,
  });
  b.textContent = label;
  b.addEventListener('click', async (ev) => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      await onclick(ev);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

let toastHost: HTMLElement | null = null;

/** A short notice in the corner (errors stay longer). */
export function toast(text: string, tone: 'ok' | 'error' = 'ok'): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast toast-${tone}` }, text);
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), tone === 'error' ? 6000 : 2500);
}

/** Native confirm, kept behind one function so pages read clearly. */
export function confirmAction(text: string): boolean {
  return window.confirm(text);
}

/** A data table: `columns` with header + cell renderer. */
export function table<T>(
  rows: readonly T[],
  columns: { head: string; cell: (row: T) => Child; class?: string }[],
  opts: { rowClass?: (row: T) => string; onRow?: (row: T) => void } = {},
): HTMLTableElement {
  const thead = h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { class: c.class }, c.head))));
  const tbody = h('tbody');
  for (const row of rows) {
    const tr = h('tr', { class: opts.rowClass?.(row) || null });
    if (opts.onRow) {
      tr.classList.add('clickable');
      tr.addEventListener('click', (ev) => {
        if ((ev.target as Element).closest('a,button,input,select,label')) return;
        opts.onRow!(row);
      });
    }
    for (const c of columns) tr.appendChild(h('td', { class: c.class }, c.cell(row)));
    tbody.appendChild(tr);
  }
  return h('table', { class: 'grid' }, thead, tbody);
}

/** An in-app link (handled by the router). */
export function link(href: string, ...children: Child[]): HTMLAnchorElement {
  return h('a', { href, 'data-link': true }, ...children);
}
