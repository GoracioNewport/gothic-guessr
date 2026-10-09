/**
 * Legal notice: a small "Legal" link at the bottom of the non-round pages (menu, quick play setup, daily, …) that opens
 * a modal with the fan-project notice, the rights statement, how rights holders ask for removal and what the game
 * stores (privacy). All text comes from the `legal.*` messages, so it follows the active language.
 *
 *   legalLink() → HTMLElement   the footer link; append it to a page's screen (positioned by `.g2-legal-foot`)
 *   openLegal(opener?)          open the modal directly; focus returns to `opener` (or the focused element) on close
 *
 * The modal is a native `<dialog>` opened with `showModal()` (the page behind is inert, Esc closes it), plus a Tab
 * focus trap and a Close button. Keys pressed inside it do not reach the page's own shortcuts (Enter = start game).
 * The optional contact (server env PUBLIC_CONTACT) comes from `GET /api/config`, fetched on first open and cached;
 * until it arrives (or when it is not configured) the text points to the in-game report function only.
 */
import type { PublicConfigView } from '../../shared/api';
import { hasMessage, t } from '../i18n';
import type { MessageKey } from '../i18n';
import { el } from './dom';

let config: Promise<PublicConfigView> | null = null;

/** The public site config, fetched once (failures count as "no contact" and are retried on the next open). */
function loadConfig(): Promise<PublicConfigView> {
  config ??= fetch('/api/config', { headers: { accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`config ${res.status}`);
      const body = (await res.json()) as Partial<PublicConfigView>;
      return { contact: typeof body.contact === 'string' && body.contact.trim() !== '' ? body.contact.trim() : null };
    })
    .catch(() => {
      config = null;
      return { contact: null };
    });
  return config;
}

/** The label of the report entry point, as the player sees it (the report module's own text when present). */
function reportLabel(): string {
  const key = 'report.link';
  return hasMessage(key) ? t(key) : t('legal.reportFallback');
}

/** A contact value as a node: e-mail → mailto link, http(s) URL → link in a new tab, anything else → text. */
export function contactNode(contact: string): HTMLElement {
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contact)) {
    const a = el('a', 'g2-legal-contact', contact);
    a.href = `mailto:${contact}`;
    return a;
  }
  if (/^https?:\/\/[^\s<>]+$/i.test(contact)) {
    const a = el('a', 'g2-legal-contact', contact);
    a.href = contact;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  return el('strong', 'g2-legal-contact', contact);
}

const CONTACT_MARK = '\u0001';

/** A paragraph from `key` with `{report}` filled in and `{contact}` (if any) as a link. */
function paragraph(key: MessageKey, contact: string | null): HTMLParagraphElement {
  const p = el('p', 'g2-legal-text');
  const text = t(key, { report: reportLabel(), contact: CONTACT_MARK });
  const parts = text.split(CONTACT_MARK);
  parts.forEach((part, i) => {
    if (i > 0 && contact) p.appendChild(contactNode(contact));
    if (part) p.appendChild(document.createTextNode(part));
  });
  return p;
}

/** The author's public contacts (owner, 2026-10-09). Same in every language; only the surrounding text is translated. */
export const AUTHOR = {
  name: 'GoracioNewport',
  links: [
    { label: 'E-mail', text: 'bdfyljkub@gmail.com', href: 'mailto:bdfyljkub@gmail.com' },
    { label: 'Telegram', text: 't.me/GoracioNewport', href: 'https://t.me/GoracioNewport' },
    { label: 'GitHub', text: 'github.com/GoracioNewport', href: 'https://github.com/GoracioNewport' },
  ],
} as const;

/** The author section: one line of text, then a list of the contacts as links. */
function authorParts(): HTMLElement[] {
  const ul = el('ul', 'g2-legal-links');
  for (const link of AUTHOR.links) {
    const li = el('li');
    const a = el('a', 'g2-legal-contact', link.text);
    a.href = link.href;
    if (!link.href.startsWith('mailto:')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    li.append(`${link.label}: `, a);
    ul.append(li);
  }
  return [el('p', 'g2-legal-text', t('legal.author', { name: AUTHOR.name })), ul];
}

function renderBody(body: HTMLElement, contact: string | null): void {
  const section = (heading: MessageKey, ...paras: HTMLElement[]): HTMLElement => {
    const s = el('section', 'g2-legal-section');
    s.append(el('h3', 'g2-legend g2-legal-heading', t(heading)), ...paras);
    return s;
  };
  body.replaceChildren(
    section('legal.fanHeading', paragraph('legal.fan', null), paragraph('legal.affiliation', null)),
    section('legal.authorHeading', ...authorParts()),
    section(
      'legal.rightsHeading',
      paragraph('legal.trademarks', null),
      paragraph(contact ? 'legal.removalContact' : 'legal.removal', contact),
    ),
    section(
      'legal.privacyHeading',
      paragraph('legal.privacy.stored', null),
      paragraph('legal.privacy.stats', null),
      paragraph(contact ? 'legal.privacy.deleteContact' : 'legal.privacy.delete', contact),
      paragraph('legal.privacy.local', null),
    ),
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

let open: HTMLDialogElement | null = null;

/** Open the legal notice (no-op while it is already open). */
export function openLegal(opener: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null): void {
  if (open) return;
  const dialog = el('dialog', 'g2-panel g2-legal');
  open = dialog;
  const titleId = 'g2-legal-title';
  dialog.setAttribute('aria-labelledby', titleId);

  const head = el('div', 'g2-legal-head');
  const title = el('h2', 'g2-heading g2-legal-title', t('legal.title'));
  title.id = titleId;
  const x = el('button', 'g2-btn g2-btn-secondary g2-btn-small g2-legal-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', t('legal.close'));
  head.append(title, x);

  const body = el('div', 'g2-legal-body');
  body.tabIndex = 0; // scrollable region: reachable by keyboard
  renderBody(body, null);

  const actions = el('div', 'g2-actions g2-legal-actions');
  const close = el('button', 'g2-btn g2-btn-primary g2-legal-close', t('legal.close'));
  close.type = 'button';
  actions.appendChild(close);
  dialog.append(head, body, actions);

  const onPop = (): void => dialog.close();
  const finish = (): void => {
    window.removeEventListener('popstate', onPop);
    dialog.remove();
    if (open === dialog) open = null;
    if (opener?.isConnected) opener.focus();
  };
  x.addEventListener('click', () => dialog.close());
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', finish);
  // A click on the backdrop (outside the panel box) closes it too.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener('keydown', (e) => {
    // The page's shortcuts listen on the document: keep them out while the notice is open.
    e.stopPropagation();
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  });
  window.addEventListener('popstate', onPop);

  document.body.appendChild(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  close.focus();

  void loadConfig().then(({ contact }) => {
    if (contact && open === dialog) renderBody(body, contact);
  });
}

/** The "Legal" footer link of a page. */
export function legalLink(): HTMLElement {
  const foot = el('footer', 'g2-legal-foot');
  const link = el('button', 'g2-legal-link', t('legal.link'));
  link.type = 'button';
  link.setAttribute('aria-haspopup', 'dialog');
  link.addEventListener('click', () => openLegal(link));
  foot.appendChild(link);
  return foot;
}
