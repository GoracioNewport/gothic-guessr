/**
 * The player's nickname with an inline editor (SPEC §10.1, §10.9): "Nickname: Wanderer1234 [Change]". Change turns
 * the line into a field with Save / Cancel (Enter saves, Escape cancels) and the rules hint underneath; Save sends
 * `PATCH /api/me`. A refused name keeps the field open with the localized reason (`nickname_rejected` = the filter,
 * `bad_request` = length or characters → the rules).
 *
 * Used by the main menu and by the screens shown after a game (summary, daily and challenge pages), where a saved
 * name also refreshes the leaderboard (`onSaved`). The editor keeps its state (open, draft, error) itself, so a page
 * that rebuilds its screen (language switch, new data) calls {@link NicknameEditor.element} on every render and an
 * open edit survives; the editor redraws only its own element for its own changes.
 */
import type { PlayerView } from '../../shared/api';
import { errorMessage, t } from '../i18n';
import { isApiError } from '../net/api';
import type { ApiClient } from '../net/api';
import { button, el, nicknameEl } from './dom';

/** Longest text the field accepts (the server allows 20 characters after trimming; extra spaces are forgiven). */
const INPUT_MAX_LENGTH = 40;

export interface NicknameEditorOptions {
  api: Pick<ApiClient, 'updateNickname' | 'me'>;
  /** The current player (null while unknown: Change is disabled). */
  player: () => PlayerView | null;
  /**
   * While `player()` is null, ask the server once (`GET /api/me`) and redraw: a summary restored after a reload has
   * made no player call yet. Default true; the menu loads the player itself.
   */
  loadPlayer?: boolean;
  /** Called after the server accepted a new name (not when the name did not change). */
  onSaved?: (player: PlayerView) => void;
  /**
   * `menu` (default): centred, "Change nickname", the hint as its own line of the card.
   * `inline`: for a header row after a game, right-aligned, a short "Change", the hint under the row.
   */
  variant?: 'menu' | 'inline';
}

/** A typed nickname as the server stores it: trimmed, inner whitespace collapsed to one space (SPEC §10.9). */
export function normaliseNickname(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** The message for a refused nickname: the rules for a malformed one, else the localized error code. */
export function nicknameErrorText(err: unknown): string {
  if (isApiError(err, 'bad_request')) return t('menu.nicknameRules');
  return isApiError(err) ? errorMessage(err.code) : t('error.unknown');
}

export class NicknameEditor {
  private readonly opts: NicknameEditorOptions;
  private editing = false;
  private draft = '';
  private error = '';
  private saving = false;
  private loading = false;
  private root: HTMLElement | null = null;

  constructor(opts: NicknameEditorOptions) {
    this.opts = opts;
  }

  /** True while the field is open. */
  get isEditing(): boolean {
    return this.editing;
  }

  /** A fresh element for the current state (call on every page render). */
  element(): HTMLElement {
    this.root = this.build();
    if (this.opts.player() === null && this.opts.loadPlayer !== false && !this.loading) {
      this.loading = true;
      // api.me() also hands the player to the app (ctx.player()), which `player()` reads.
      void this.opts.api
        .me()
        .then(() => this.redraw())
        .catch(() => undefined);
    }
    return this.root;
  }

  /** Close an open edit without saving. */
  cancel(): void {
    if (!this.editing) return;
    this.editing = false;
    this.error = '';
    this.redraw();
  }

  private get inline(): boolean {
    return this.opts.variant === 'inline';
  }

  /** Replace the mounted element (if any) with a new one; optionally focus the field. */
  private redraw(focus = false): void {
    const old = this.root;
    if (!old?.isConnected) return;
    const next = this.build();
    old.replaceWith(next);
    this.root = next;
    if (focus) next.querySelector<HTMLInputElement>('.g2-nick-input')?.focus();
  }

  private build(): HTMLElement {
    // The menu variant is a contents-only wrapper: its line and hint are items of the card's column as before.
    const box = el('div', this.inline ? 'g2-nick-box g2-nick-inline' : 'g2-nick-box g2-nick-menu');
    const player = this.opts.player();
    const line = el('div', 'g2-nick');
    line.appendChild(el('span', 'g2-nick-label', `${t('menu.nickname')}:`));
    if (!this.editing) {
      line.appendChild(nicknameEl(el('span', 'g2-nick-name', player?.nickname ?? '…')));
      const edit = button(this.inline ? t('nick.change') : t('menu.editNickname'), 'g2-btn g2-btn-secondary g2-btn-small g2-nick-edit', () => {
        this.editing = true;
        this.draft = this.opts.player()?.nickname ?? '';
        this.error = '';
        this.redraw(true);
      });
      if (this.inline) edit.setAttribute('aria-label', t('menu.editNickname'));
      edit.disabled = player === null;
      line.appendChild(edit);
    } else {
      const form = el('form', 'g2-nick-form');
      const input = el('input', 'g2-input g2-nick-input');
      input.type = 'text';
      input.value = this.draft;
      input.maxLength = INPUT_MAX_LENGTH;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', t('menu.nickname'));
      input.addEventListener('input', () => (this.draft = input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          // Escape closes the field only, never the page around it.
          e.preventDefault();
          e.stopPropagation();
          this.cancel();
        }
      });
      const save = el('button', 'g2-btn g2-btn-primary g2-btn-small g2-nick-save', t('menu.save'));
      save.type = 'submit';
      save.disabled = this.saving;
      const cancel = button(t('menu.cancel'), 'g2-btn g2-btn-secondary g2-btn-small g2-nick-cancel', () => this.cancel());
      form.append(input, save, cancel);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void this.save(input.value);
      });
      line.appendChild(form);
    }
    box.appendChild(line);
    if (this.editing) {
      const hint = el('p', this.error ? 'g2-field-error g2-nick-error' : 'g2-muted g2-nick-hint', this.error || t('menu.nicknameRules'));
      if (this.error) hint.setAttribute('role', 'alert');
      box.appendChild(hint);
    }
    return box;
  }

  private async save(value: string): Promise<void> {
    if (this.saving) return;
    const name = normaliseNickname(value);
    if (name === this.opts.player()?.nickname) {
      this.editing = false;
      this.error = '';
      this.redraw();
      return;
    }
    this.saving = true;
    this.redraw(true);
    let saved: PlayerView | null = null;
    try {
      saved = await this.opts.api.updateNickname(name);
      this.editing = false;
      this.error = '';
    } catch (err) {
      this.error = nicknameErrorText(err);
      this.draft = value;
    } finally {
      this.saving = false;
    }
    this.redraw(this.editing);
    if (saved) this.opts.onSaved?.(saved);
  }
}
