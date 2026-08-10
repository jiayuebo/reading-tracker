// Type-to-filter picker for choosing a parent row.
//
// Replaces a <select> that had grown to 227 options. It is also the keyboard
// route to everything drag-and-drop does in the queue: dragging is a pointer
// gesture that no keyboard and no touch screen can perform, so nesting has to
// be reachable here too, not only by dragging.

import { h, mount } from '../dom.js';
import { matchesQuery, sortKeyTitle, authorLine, STATUS_LABEL } from '../model.js';

const MAX_SHOWN = 8;

/**
 * @param {{
 *   texts: Array, value: ?string, banned: Set<string>,
 *   onChange: (id: ?string) => void, placeholder?: string
 * }} opts
 */
export function rowPicker({ texts, value, banned, onChange, placeholder }) {
  const candidates = texts
    .filter(x => !banned.has(x.id))
    .sort((a, b) => sortKeyTitle(a).localeCompare(sortKeyTitle(b)));
  const byId = new Map(candidates.map(x => [x.id, x]));

  const current = value && byId.get(value);
  const input = h('input.picker-input', {
    type: 'text',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-autocomplete': 'list',
    autocomplete: 'off',
    placeholder: placeholder || 'Type to find a parent…',
    value: current ? current.title : '',
  });
  const list = h('ul.picker-list', { role: 'listbox', hidden: true });
  const chosen = h('p.picker-chosen');

  let matches = [];
  let active = -1;
  let open = false;

  const paintChosen = (id) => {
    const row = id && byId.get(id);
    mount(chosen, row
      ? [h('span.dim', 'Nested under '), h('strong', row.title),
        h('button.link', { type: 'button', onclick: () => pick(null) }, 'remove')]
      : h('span.dim', 'Top level — not nested under anything.'));
  };

  const close = () => {
    open = false;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const pick = (id) => {
    const row = id && byId.get(id);
    input.value = row ? row.title : '';
    paintChosen(id);
    close();
    onChange(id);
  };

  const paintList = () => {
    mount(list, matches.map((m, i) =>
      h('li', { role: 'option', 'aria-selected': i === active ? 'true' : 'false' },
        h(`button.picker-hit${i === active ? '.active' : ''}`, {
          type: 'button',
          // mousedown, not click: blur would close the list first.
          onmousedown: (e) => { e.preventDefault(); pick(m.id); },
        },
          h('span.picker-title', m.title || '(untitled)'),
          h('span.picker-meta',
            [authorLine(m), m.year || null, m.type, STATUS_LABEL[m.status] || m.status]
              .filter(Boolean).join(' · '))))));
  };

  const search = () => {
    const q = input.value.trim();
    matches = (q
      ? candidates.filter(x => matchesQuery(`${x.title} ${(x.authors || []).join(' ')}`, q))
      : candidates
    ).slice(0, MAX_SHOWN);
    active = matches.length ? 0 : -1;
    open = matches.length > 0;
    list.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    paintList();
  };

  input.addEventListener('input', search);
  input.addEventListener('focus', search);
  input.addEventListener('blur', () => {
    setTimeout(() => {
      close();
      // Leaving text that matches nothing must not imply a change was made.
      const row = value && byId.get(value);
      input.value = row ? row.title : '';
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); return; }
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { search(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(matches.length - 1, active + 1); paintList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paintList(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && matches[active]) pick(matches[active].id);
    }
  });

  paintChosen(value);
  return h('div.picker', input, list, chosen);
}
