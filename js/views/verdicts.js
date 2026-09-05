// Verdicts (spec §5, phase 1.5). A sweep, not a form.
//
// The verdict is described in §3 as the highest-value field in the schema and
// the cheapest to fill, and it sat at two rows out of 307. Nothing was missing
// from the data model — the detail view has had the box all along, and Finish
// even focuses it. What was missing was a way to write twenty of them without
// opening twenty pages.
//
// So this is Backfill's shape applied to a different gap: one row at a time,
// ordered by how fresh the memory is, with the box already focused.
//
// Ordering is by finish date descending for a reason. A verdict written a week
// after reading is worth more than one reconstructed a year later, and the
// undated import rows — where the memory is coldest and the guessing worst —
// come last rather than first.

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import { authorLine, containerName, byIdIndex, sortKeyTitle, inPool, todayISO } from '../model.js';

const SCOPES = {
  recent: {
    label: 'Finished recently',
    test: (t) => !!t.date_finished && daysSince(t.date_finished) <= 60,
  },
  pool: {
    label: 'In the comparison pool',
    test: (t) => inPool(t),
  },
  dated: {
    label: 'Everything with a finish date',
    test: (t) => !!t.date_finished,
  },
  all: {
    label: 'Everything read',
    test: () => true,
  },
};

let scope = 'recent';
let cursor = 0;
// Skips are deliberately not written to the file. "Not now" is a statement
// about this sitting, not about the text, and persisting it would quietly
// shrink the corpus of things that still want a verdict.
const skipped = new Set();

function daysSince(iso) {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return Infinity;
  return Math.max(0, Math.round((Date.now() - then) / 86400000));
}

function hasVerdict(t) {
  return !!(t.verdict || '').trim();
}

function eligible(t) {
  return (t.status === 'read' || t.status === 'abandoned') && !hasVerdict(t);
}

function worklist() {
  const texts = (state.doc && state.doc.texts) || [];
  return texts
    .filter(t => eligible(t) && SCOPES[scope].test(t)
      && !skipped.has(t.id) && !(t.import || {}).verdict_skipped)
    .sort((a, b) => {
      const da = a.date_finished || '', db = b.date_finished || '';
      if (da !== db) { if (!da) return 1; if (!db) return -1; return da > db ? -1 : 1; }
      return sortKeyTitle(a).localeCompare(sortKeyTitle(b));
    });
}

function setVerdict(id, text, ctx) {
  mutate(d => {
    const row = d.texts.find(x => x.id === id);
    if (row) row.verdict = text;
  });
  ctx.rerender();
}

function setAssessment(id, value, ctx) {
  mutate(d => {
    const row = d.texts.find(x => x.id === id);
    if (!row) return;
    // Sparse: clearing removes the key rather than storing false (§4).
    if (value) row.assessment = value; else delete row.assessment;
  });
  ctx.rerender();
}

export function renderVerdicts(root, ctx) {
  const texts = (state.doc && state.doc.texts) || [];
  const byId = byIdIndex(texts);
  const finished = texts.filter(t => t.status === 'read' || t.status === 'abandoned');
  const written = finished.filter(hasVerdict).length;
  const list = worklist();

  const head = h('header.view-head',
    h('h1', 'Verdicts'),
    h('p.counts',
      `${written} of ${finished.length} finished texts carry one`,
      list.length ? ` · ${list.length} in this pass` : null),
  );

  const scopePicker = h('div.controls',
    h('label.sel', h('span', 'Scope'),
      h('select', { onchange: e => { scope = e.target.value; cursor = 0; ctx.rerender(); } },
        Object.entries(SCOPES).map(([k, v]) =>
          h('option', { value: k, selected: scope === k }, v.label)))),
    skipped.size
      ? h('button.small', { onclick: () => { skipped.clear(); cursor = 0; ctx.rerender(); } },
        `Bring back ${skipped.size} skipped`)
      : null,
  );

  if (!list.length) {
    mount(root, head, scopePicker,
      h('div.empty',
        h('p', finished.filter(t => eligible(t)).length
          ? 'Nothing left in this scope. Widen it above, or come back after your next few reads.'
          : 'Every finished text has a verdict.'),
        h('div.empty-actions', h('a.button', { href: '#/queue' }, 'Back to the queue'))));
    return;
  }

  cursor = Math.max(0, Math.min(cursor, list.length - 1));
  const t = list[cursor];

  mount(root, head, scopePicker,
    h('p.progress-line', `${cursor + 1} of ${list.length}`),
    card(t, byId, list, ctx),
    upcoming(list, cursor),
  );
}

function card(t, byId, list, ctx) {
  const parent = containerName(t, byId);
  const box = h('textarea.verdict-box', {
    rows: 5,
    placeholder: 'What it turned out to be worth. Two or three sentences — what you took from it, '
      + 'what it settled, what it did not.',
    value: t.verdict || '',
  });

  const saveAndNext = () => {
    const v = box.value.trim();
    if (!v) { box.focus(); return; }
    // The row leaves the list once it has a verdict, so the next one takes this
    // index. Advancing as well would step over it.
    setVerdict(t.id, v, ctx);
  };
  const skip = () => { skipped.add(t.id); ctx.rerender(); };
  const never = () => {
    mutate(d => {
      const row = d.texts.find(x => x.id === t.id);
      row.import = { ...(row.import || {}), verdict_skipped: true };
    });
    ctx.rerender();
  };

  box.onkeydown = (e) => {
    // Enter alone has to insert a newline: a verdict is prose, not a field.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveAndNext(); }
    if (e.key === 'Escape') { e.preventDefault(); box.blur(); }
  };

  const mark = (value, label, title) =>
    h(`button.small${t.assessment === value ? '.primary' : ''}`, {
      type: 'button', title,
      'aria-pressed': t.assessment === value ? 'true' : 'false',
      onclick: () => setAssessment(t.id, t.assessment === value ? null : value, ctx),
    }, label);

  const meta = [authorLine(t), t.year || null, t.type !== 'article' ? t.type : null,
    t.pages ? `${t.pages} pp` : null].filter(Boolean);

  return h('article.card.verdict-card',
    h('div.card-head',
      h('a.verdict-title', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title || '(untitled)'),
      h('span.dim.small', t.date_finished
        ? `finished ${t.date_finished} · ${daysSince(t.date_finished)}d ago`
        : 'no finish date')),
    h('p.dim.small', [meta.join(' · '), parent ? `in ${parent}` : null].filter(Boolean).join(' · ')),
    h('div.verdict-marks',
      h('span.dim.small', 'Was it worth the hours?'),
      mark('good', 'Good', 'You would have regretted missing it.'),
      mark('bad', 'Bad', 'The hours did not pay.'),
      t.assessment ? h('span.dim.small', 'click again to clear') : null),
    box,
    h('div.actions',
      h('button.primary', { type: 'button', onclick: saveAndNext }, 'Save and next'),
      h('button', { type: 'button', onclick: skip }, 'Skip for now'),
      h('span.spacer'),
      h('button.small.linkish', { type: 'button', onclick: never }, 'Nothing to say about this one')),
    h('p.hint.dim', 'Cmd/Ctrl + Enter saves. Skipping is for this sitting only; '
      + '“nothing to say” is remembered.'),
  );
}

function upcoming(list, i) {
  const next = list.slice(i + 1, i + 5);
  if (!next.length) return null;
  return h('section.card.upcoming',
    h('h2', 'Up next'),
    h('ul.child-list', next.map(t => h('li',
      h('span', t.title || '(untitled)'),
      h('span.dim', ` — ${[authorLine(t), t.date_finished || 'undated'].filter(Boolean).join(' · ')}`)))));
}

/** Focus the box on arrival, without stealing it back on every re-render. */
export function focusVerdictBox() {
  const box = document.querySelector('.verdict-box');
  if (box && document.activeElement !== box) box.focus();
}
