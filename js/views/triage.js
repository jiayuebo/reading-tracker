// Triage (spec §5.4). 17 rows ship in this state.
//
// These are chapter stubs — "Ch. 3", "Book 6", "Epilogue" — that lost their
// parent when Google Tasks completed them. Note the consequence the spec only
// implies: they were *completed* tasks, so most carry a `date_finished`. The
// default resolution is therefore "read", not "queued".

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import { childIndex, isContainer, fold, sortKeyTitle, todayISO } from '../model.js';

// Drafts survive the re-render that each resolution triggers.
const drafts = new Map();

export function renderTriage(root, ctx) {
  const doc = state.doc;
  const texts = doc.texts || [];
  const rows = texts.filter(t => t.status === 'triage');
  const children = childIndex(texts);
  const containers = texts
    .filter(x => isContainer(x, children) || x.type === 'book' || x.type === 'collection')
    .sort((a, b) => sortKeyTitle(a).localeCompare(sortKeyTitle(b)));

  mount(root,
    h('header.view-head',
      h('h1', 'Triage'),
      h('p.counts', rows.length
        ? `${rows.length} row${rows.length === 1 ? '' : 's'} needing a decision before they can join the queue or the read corpus`
        : 'Nothing waiting.'),
    ),

    rows.length ? h('p.notice.quiet',
      'Each of these was a completed Google Task whose parent title was lost. The syllabi have been checked and will not resolve more of them — this is a manual pass. Give it a container, correct the title if you want, and send it where it belongs.',
    ) : null,

    rows.length
      ? h('div.triage-list', rows.map(t => card(t, { containers, ctx })))
      : h('div.empty',
        h('p', 'Triage is clear. Every row has a container and a home.'),
        h('a.button', { href: '#/queue' }, 'Back to the queue')),
  );
}

function draftFor(t) {
  if (!drafts.has(t.id)) {
    drafts.set(t.id, {
      title: t.title || '',
      container: t.container || '',
      parent_id: t.parent_id || '',
    });
  }
  return drafts.get(t.id);
}

function card(t, { containers, ctx }) {
  const im = t.import || {};
  const cands = im.container_candidates || [];
  const d = draftFor(t);

  const containerInput = h('input', {
    type: 'text', value: d.container, placeholder: 'Container title',
    'aria-label': 'Container',
    oninput: e => { d.container = e.target.value; },
  });
  const parentSel = h('select', {
    'aria-label': 'Parent row',
    onchange: e => { d.parent_id = e.target.value; },
  },
    h('option', { value: '' }, '— no parent row —'),
    containers.map(c => h('option', { value: c.id, selected: c.id === d.parent_id }, c.title || c.id)),
  );
  const titleInput = h('input.triage-title', {
    type: 'text', value: d.title, 'aria-label': 'Title',
    oninput: e => { d.title = e.target.value; },
  });

  const pick = (cand) => {
    d.container = cand;
    containerInput.value = cand;
    const match = matchContainer(cand, containers);
    if (match) { d.parent_id = match.id; parentSel.value = match.id; }
    containerInput.focus();
  };

  const resolve = (status) => {
    const patch = {
      title: d.title.trim() || t.title,
      container: d.container.trim() || null,
      parent_id: d.parent_id || null,
      status,
    };
    if (status === 'read' && !t.date_finished) patch.date_finished = todayISO();
    mutate(doc => {
      const row = doc.texts.find(x => x.id === t.id);
      Object.assign(row, patch);
      row.import = { ...(row.import || {}), needs_container: false };
    });
    drafts.delete(t.id);
    ctx.rerender();
  };

  return h('article.triage-card',
    h('div.triage-head',
      titleInput,
      h('a.dim.small', { href: `#/text/${encodeURIComponent(t.id)}` }, 'Open full record'),
    ),

    h('p.triage-prov',
      im.raw_title && im.raw_title !== t.title ? [h('span.dim', 'as imported: '), h('code', im.raw_title), ' · '] : null,
      h('span.dim', 'added '), t.date_added || 'unknown',
      t.date_finished ? [h('span.dim', ' · completed '), t.date_finished] : null,
      im.courses && im.courses.length ? [h('span.dim', ' · '), im.courses.join(', ')] : null,
    ),

    cands.length
      ? h('div.candidates',
        h('span.dim.small', 'Neighbouring titles from the import:'),
        h('div.cand-buttons', cands.map((c, i) =>
          h('button.cand', { onclick: () => pick(c), title: c },
            h('kbd', String(i + 1)), ' ', c))))
      : h('p.dim.small', 'No container candidates were captured for this row.'),

    h('div.triage-fields',
      h('label', h('span', 'Container'), containerInput),
      h('label', h('span', 'Parent row'), parentSel),
    ),

    h('div.triage-actions',
      h('button.primary', { onclick: () => resolve('read') }, 'Resolve as read'),
      h('button', { onclick: () => resolve('queued') }, 'Send to queue'),
      h('button', { onclick: () => resolve('abandoned') }, 'Abandon'),
      h('span.spacer'),
      h('span.hint.dim', t.date_finished
        ? 'This was a completed task, so “read” is the likely answer.'
        : 'No completion date on this row.'),
    ),
  );
}

/** Candidate strings carry the author too; match generously in both directions. */
function matchContainer(cand, containers) {
  const c = fold(cand);
  let best = null, bestLen = 0;
  for (const x of containers) {
    const title = fold(x.title || '');
    if (!title) continue;
    if (c.includes(title) || title.includes(c)) {
      if (title.length > bestLen) { best = x; bestLen = title.length; }
    }
  }
  return best;
}
