/**
 * Nickname blocklist (SPEC §10.9, §10.10): words added here are matched like the built-in roots (case, leetspeak,
 * Latin/Cyrillic look-alikes and separators are normalised). Includes a checker that shows why a nickname is refused.
 */
import type { AdminBlockedWord, AdminBlocklist } from '../../../shared/api';
import { api, errorText } from '../api';
import { badge, button, confirmAction, empty, fmtTime, h, mount, pageHeader, panel, table, toast } from '../dom';
import type { Page } from '../page';

export const blocklistPage: Page = async (ctx) => {
  const listHost = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  const addInput = h('input', { type: 'text', maxlength: 40, placeholder: 'word or root, e.g. gorgon', 'aria-label': 'Word to block', autocomplete: 'off' });
  const addStatus = h('p', { class: 'form-status', role: 'status' });
  const addForm = h('form', { class: 'search' }, addInput, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add'));

  const draw = (bl: AdminBlocklist): void => {
    if (bl.words.length === 0) {
      mount(listHost, empty('No custom words. The built-in EN/DE/PL/RU lists always apply.'));
      return;
    }
    mount(
      listHost,
      table<AdminBlockedWord>(bl.words, [
        { head: 'Word', cell: (w) => h('code', {}, w.word) },
        { head: 'Added (UTC)', cell: (w) => fmtTime(w.addedAt) },
        {
          head: '',
          class: 'actions',
          cell: (w) =>
            button(
              'Remove',
              async () => {
                if (!confirmAction(`Remove “${w.word}” from the blocklist?`)) return;
                try {
                  draw(await api.unblock(w.word));
                  toast(`“${w.word}” removed`);
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

  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const word = addInput.value.trim();
    if (!word) return;
    addStatus.textContent = '';
    try {
      draw(await api.block(word));
      toast(`“${word.toLowerCase()}” blocked`);
      addInput.value = '';
    } catch (err) {
      addStatus.textContent = errorText(err);
    }
  });

  const checkInput = h('input', { type: 'text', maxlength: 40, placeholder: 'Nickname to test', 'aria-label': 'Nickname to test', autocomplete: 'off' });
  const checkOut = h('p', { class: 'check-result', role: 'status' });
  const checkForm = h('form', { class: 'search' }, checkInput, h('button', { type: 'submit', class: 'btn' }, 'Check'));
  checkForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!checkInput.value) return;
    try {
      const r = await api.checkNickname(checkInput.value);
      mount(
        checkOut,
        r.result === 'ok'
          ? h('span', {}, badge('allowed', 'green'), ` “${r.nickname}” is accepted.`)
          : r.result === 'format'
            ? h('span', {}, badge('format', 'gold'), ' 2–20 characters: letters, digits, space, _ - . only.')
            : h('span', {}, badge('blocked', 'red'), ' matches ', h('code', {}, r.match ?? '?')),
      );
    } catch (err) {
      checkOut.textContent = errorText(err);
    }
  });

  mount(
    ctx.root,
    pageHeader('Nickname blocklist', 'Extra words for the nickname filter. New nicknames are checked against them; existing ones are not renamed (use Players → Reset nickname).'),
    h(
      'div',
      { class: 'two-col' },
      panel('Add a word', addForm, addStatus, h('p', { class: 'hint' }, 'One word, at least 3 letters of one script. Matching is a substring match after normalisation, so short roots catch more (and risk false positives).')),
      panel('Test a nickname', checkForm, checkOut),
    ),
    panel('Blocked words', listHost),
  );
  draw(await api.blocklist());
};
