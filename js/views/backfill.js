// Backfill (spec §6, phase 1.5). A sibling of Triage.
//
// The rubric in §4 is supposed to regress fitted scores on author, field, year,
// type and length. Right now `year` sits on 3% of rows and `pages` on 2%, so
// that regression would run on the author column alone. This view is how the
// corpus gets the features, and it is deliberately NOT a batch job.
//
// Why not a batch job, given the machine can match all 217 rows unattended:
// Crossref, asked for a book by title, will happily return a three-page review
// of that book by somebody else — same title, wrong author, wrong type, wrong
// year, wrong DOI. Run unattended, that silently corrupts dozens of rows at
// once and the damage is invisible until the rubric is already trained on it.
// So: one row at a time, the exact diff shown before anything is written, and
// a keystroke to accept or skip. Fast, but never automatic.

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import { childIndex, authorLine, todayISO, STATUS_LABEL, inPool } from '../model.js';
import { lookup, applyCandidate, previewChanges, authorsAgree, describe, rankCandidates } from '../lookup.js';

const SCOPES = {
  queue: { label: 'Queue first', test: t => t.status === 'queued' || t.status === 'reading' },
  // The rubric trains on the read corpus and predicts on the queue, so features
  // are needed on both. The pool is the part of the read corpus that will
  // actually be compared, which makes it the shortest path to phase 2.
  pool: { label: 'Comparison pool', test: t => inPool(t) },
  read: { label: 'Read corpus', test: t => t.status === 'read' },
  all: { label: 'Everything', test: t => t.status !== 'triage' },
};

// Module state: survives the re-render that every acceptance triggers.
let cursor = 0;
let scope = 'queue';
let showChecked = false;
const cache = new Map();      // id -> { state:'loading'|'done'|'error', candidates, error }
const queries = new Map();    // id -> the query string, once the user has edited it
let undoStack = [];

/** Anything still missing a feature the rubric wants. */
function needsMetadata(t, children) {
  const suspectType = t.type === 'book' && !(children.get(t.id) || []).length;
  return t.year == null || t.pages == null || suspectType;
}

function worklist() {
  const texts = (state.doc && state.doc.texts) || [];
  const children = childIndex(texts);
  return texts.filter(t =>
    SCOPES[scope].test(t)
    && needsMetadata(t, children)
    && (showChecked || !(t.import || {}).metadata_checked));
}

function defaultQuery(t) {
  if (t.doi) return t.doi;
  if (t.isbn) return t.isbn;
  return t.title || '';
}

function surnameOf(t) {
  const a = (t.authors || [])[0];
  return a ? String(a).trim().split(/\s+/).pop() : '';
}

function runLookup(t, ctx, { force = false } = {}) {
  if (!force && cache.has(t.id)) return;
  cache.set(t.id, { state: 'loading' });
  const q = queries.has(t.id) ? queries.get(t.id) : defaultQuery(t);
  lookup(q, { author: surnameOf(t) })
    .then(candidates => {
      cache.set(t.id, { state: 'done', candidates: rankCandidates(candidates, t) });
      ctx.rerender();
    })
    .catch(err => { cache.set(t.id, { state: 'error', error: err.message }); ctx.rerender(); });
}

function markChecked(id) {
  mutate(d => {
    const row = d.texts.find(x => x.id === id);
    if (row) row.import = { ...(row.import || {}), metadata_checked: todayISO() };
  });
}

function snapshot(id) {
  const row = (state.doc.texts || []).find(x => x.id === id);
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

function accept(t, c, ctx) {
  undoStack.push(snapshot(t.id));
  mutate(d => {
    const row = d.texts.find(x => x.id === t.id);
    applyCandidate(row, c);
    row.import = { ...(row.import || {}), metadata_checked: todayISO() };
  });
  cache.delete(t.id);
  ctx.toast('Filled. Press u to undo.');
  ctx.rerender();
}

function skip(t, ctx, { permanent = false } = {}) {
  if (permanent) {
    undoStack.push(snapshot(t.id));
    markChecked(t.id);
  } else {
    cursor += 1;
  }
  ctx.rerender();
}

function undo(ctx) {
  const prev = undoStack.pop();
  if (!prev) { ctx.toast('Nothing to undo.'); return; }
  mutate(d => {
    const i = d.texts.findIndex(x => x.id === prev.id);
    if (i >= 0) d.texts[i] = prev;
  });
  cache.delete(prev.id);
  ctx.toast(`Reverted “${(prev.title || '').slice(0, 40)}”.`);
  ctx.rerender();
}

// ── keyboard, delegated from app.js while this route is active ──────

export function backfillKeys(e, ctx) {
  const list = worklist();
  if (!list.length) return false;
  const t = list[Math.min(cursor, list.length - 1)];
  const entry = cache.get(t.id);
  const cands = (entry && entry.state === 'done' && entry.candidates) || [];

  if (e.key === 's' || e.key === 'ArrowRight') { e.preventDefault(); skip(t, ctx); return true; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); cursor = Math.max(0, cursor - 1); ctx.rerender(); return true; }
  if (e.key === 'u') { e.preventDefault(); undo(ctx); return true; }
  if (e.key === 'x') { e.preventDefault(); skip(t, ctx, { permanent: true }); return true; }
  if (/^[1-5]$/.test(e.key)) {
    const c = cands[Number(e.key) - 1];
    if (c) { e.preventDefault(); accept(t, c, ctx); return true; }
  }
  if (e.key === 'Enter' && cands[0]) { e.preventDefault(); accept(t, cands[0], ctx); return true; }
  return false;
}

// ── view ────────────────────────────────────────────────────────────

export function renderBackfill(root, ctx) {
  const texts = (state.doc && state.doc.texts) || [];
  const children = childIndex(texts);
  const list = worklist();
  const totalMissing = texts.filter(t => SCOPES[scope].test(t) && needsMetadata(t, children)).length;

  if (!list.length) {
    mount(root,
      head(ctx, 0, totalMissing),
      h('div.empty',
        h('p', totalMissing
          ? 'Everything in this scope has been looked at. Nothing left that a lookup can fill.'
          : 'Nothing in this scope is missing a year, a page count, or a trustworthy type.'),
        h('div.empty-actions',
          h('a.button', { href: '#/queue' }, 'Back to the queue'),
          totalMissing ? h('button', {
            onclick: () => { showChecked = true; cursor = 0; ctx.rerender(); },
          }, 'Show the ones I already checked') : null)));
    return;
  }

  cursor = Math.max(0, Math.min(cursor, list.length - 1));
  const t = list[cursor];
  runLookup(t, ctx);
  const next = list[cursor + 1];
  if (next) runLookup(next, ctx);   // prefetch, so advancing feels instant

  mount(root,
    head(ctx, cursor, list.length),
    card(t, ctx),
    upcoming(list, cursor),
  );
}

function head(ctx, i, n) {
  return h('header.view-head',
    h('h1', 'Backfill'),
    h('p.counts', n ? `${i + 1} of ${n} in this pass` : 'Nothing waiting'),
    h('div.controls',
      h('label.sel', h('span.sr-only', 'Scope'),
        h('select', {
          'aria-label': 'Scope',
          onchange: e => { scope = e.target.value; cursor = 0; ctx.rerender(); },
        }, Object.entries(SCOPES).map(([k, v]) =>
          h('option', { value: k, selected: k === scope }, v.label)))),
      h('label.check',
        h('input', {
          type: 'checkbox', checked: showChecked,
          onchange: e => { showChecked = e.target.checked; cursor = 0; ctx.rerender(); },
        }),
        h('span', 'Include ones I already checked')),
      h('span.spacer'),
      h('span.hint.dim',
        h('kbd', '1'), '–', h('kbd', '5'), ' accept · ', h('kbd', 's'), ' skip · ',
        h('kbd', 'x'), ' nothing to find · ', h('kbd', 'u'), ' undo'),
    ));
}

function card(t, ctx) {
  const entry = cache.get(t.id) || { state: 'loading' };
  const q = queries.has(t.id) ? queries.get(t.id) : defaultQuery(t);

  const queryInput = h('input.lookup-input', {
    type: 'text', value: q, 'aria-label': 'Search query',
    onkeydown: e => {
      e.stopPropagation();                        // let the user type "s" and "1"
      if (e.key === 'Enter') { e.preventDefault(); queries.set(t.id, e.target.value); runLookup(t, ctx, { force: true }); ctx.rerender(); }
    },
    oninput: e => queries.set(t.id, e.target.value),
  });

  return h('article.backfill-card',
    h('div.backfill-head',
      h('a.backfill-title', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title || '(untitled)'),
      h('span.dim.small', [authorLine(t), STATUS_LABEL[t.status] || t.status, t.type]
        .filter(Boolean).join(' · ')),
    ),
    h('p.backfill-missing',
      h('span.dim', 'missing: '),
      [t.year == null ? 'year' : null, t.pages == null ? 'pages' : null,
        t.type === 'book' ? 'type is “book”, unverified' : null].filter(Boolean).join(', ') || 'nothing',
    ),

    h('div.lookup-bar', queryInput,
      h('button', { type: 'button', onclick: () => { runLookup(t, ctx, { force: true }); ctx.rerender(); } }, 'Search')),

    entry.state === 'loading' ? h('p.hint', 'Searching…') : null,
    entry.state === 'error' ? h('p.hint.bad', `${entry.error} Skip it, or edit the query and search again.`) : null,
    entry.state === 'done' && !entry.candidates.length
      ? h('p.hint', 'No match. Edit the query, or press ', h('kbd', 'x'), ' to record that there is nothing to find.')
      : null,
    entry.state === 'done' && entry.candidates.length
      ? h('div.lookup-results', entry.candidates.map((c, i) => candidateRow(t, c, i, ctx)))
      : null,

    h('div.triage-actions',
      h('button', { onclick: () => skip(t, ctx) }, 'Skip for now'),
      h('button', { onclick: () => skip(t, ctx, { permanent: true }) }, 'Nothing to find'),
      h('span.spacer'),
      undoStack.length ? h('button', { onclick: () => undo(ctx) }, 'Undo last') : null,
    ),
  );
}

function candidateRow(t, c, i, ctx) {
  const diff = previewChanges(t, c);
  const mismatch = !authorsAgree(t, c);
  return h(`div.backfill-hit${mismatch ? '.mismatch' : ''}`,
    h('div.backfill-hit-head',
      h('kbd', String(i + 1)),
      h('span.lookup-title', c.title),
    ),
    h('p.lookup-meta', describe(c)),
    mismatch
      ? h('p.lookup-warn',
        `Different author from this row (${(c.authors || []).join(', ') || 'none listed'}). `
        + 'Reviews and replies carry their subject’s title — check before accepting.')
      : null,
    diff.length
      ? h('ul.diff', diff.map(d => h('li',
        h('span.diff-field', d.field), ' ',
        h('span.diff-from', d.from == null ? '—' : String(d.from)),
        ' → ', h('span.diff-to', String(d.to)))))
      : h('p.hint', 'Nothing this row is missing.'),
    h('div.actions',
      h('button.primary', {
        disabled: !diff.length,
        onclick: () => {
          if (mismatch && !confirm(
            `This record is by ${(c.authors || []).join(', ') || 'an unlisted author'}, but the row is by `
            + `${(t.authors || []).join(', ') || 'nobody listed'}.\n\nUse it anyway?`)) return;
          accept(t, c, ctx);
        },
      }, `Accept ${i + 1}`)),
  );
}

function upcoming(list, i) {
  const rest = list.slice(i + 1, i + 6);
  if (!rest.length) return null;
  return h('section.card',
    h('h2', 'Up next'),
    h('ul.child-list', rest.map(x =>
      h('li', x.title || '(untitled)', h('span.dim', ` — ${authorLine(x) || 'no author'}`)))));
}
