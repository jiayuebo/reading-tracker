// Text detail (spec §5.2). Every field editable, including the many the import
// left null. Scores are hand-enterable in phase 1 and optional (spec §6).

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import {
  TYPES, STATUSES, SOURCES, STATUS_LABEL, childIndex, byIdIndex, descendantIds,
  containerName, unreadPrerequisites, quadrant, scores, todayISO, sortKeyTitle, poolEligible, orderOf,
} from '../model.js';
import { lookupPanel, lookupEnabled } from './lookup-ui.js';
import { applyCandidate, describe } from '../lookup.js';
import { rowPicker } from './row-picker.js';
import { chaptersDialog } from './dialogs.js';

export function renderDetail(root, ctx, id) {
  const doc = state.doc;
  const texts = doc.texts || [];
  const t = texts.find(x => x.id === id);
  if (!t) {
    mount(root, h('div.empty',
      h('p', `No text with id “${id}”.`),
      h('a.button', { href: '#/queue' }, 'Back to the queue')));
    return;
  }

  const children = childIndex(texts);
  const byId = byIdIndex(texts);
  const kids = children.get(t.id) || [];
  const set = (patch) => { mutate(d => { Object.assign(d.texts.find(x => x.id === t.id), patch); }); ctx.rerender(); };
  const setIn = (block, key, value) => {
    mutate(d => {
      const row = d.texts.find(x => x.id === t.id);
      row[block] = { ...(row[block] || {}), [key]: value };
    });
    ctx.rerender();
  };

  // `assessment` is sparse: cleared means the key goes away, not that it becomes
  // false or undefined. Absence is a meaningful third state (§4) and has to look
  // like absence in the file.
  const setAssessment = (value) => {
    mutate(d => {
      const row = d.texts.find(x => x.id === t.id);
      if (value) row.assessment = value;
      else delete row.assessment;
    });
    ctx.rerender();
  };

  const q = quadrant(t);
  const blocked = unreadPrerequisites(t, byId);

  mount(root,
    h('header.view-head',
      h('nav.crumbs', h('a', { href: '#/queue' }, '← Queue'),
        containerName(t, byId) ? [' · ', h('span.dim', containerName(t, byId))] : null),
      h('h1.detail-title', t.title || '(untitled)'),
      h('p.counts',
        STATUS_LABEL[t.status] || t.status,
        ' · ', t.source || 'queue',
        kids.length ? ` · contains ${kids.length} row${kids.length === 1 ? '' : 's'}` : '',
      ),
    ),

    blocked.length ? h('p.notice.warn',
      `Prerequisites still unread: ${blocked.map(b => b.title).join('; ')}.`) : null,

    actionBar(t, set, ctx),

    lookupEnabled() ? h('section.card',
      h('h2', 'Look up metadata'),
      h('p.hint', 'Fills only fields that are still empty, so anything you corrected by hand stays. '
        + 'Type is the exception: a value of "book" left over from the import is replaced when a real record disagrees.'),
      lookupPanel((c) => {
        let changed = [];
        mutate(d => { changed = applyCandidate(d.texts.find(x => x.id === t.id), c); });
        ctx.toast(changed.length
          ? `Filled ${changed.join(', ')} from ${c.source}.`
          : `${c.source} had nothing this row was missing.`);
        ctx.rerender();
      }, { compareTo: t, placeholder: t.title ? `DOI, ISBN, JSTOR link, or "${t.title.slice(0, 30)}"` : 'DOI, ISBN, JSTOR link, or title...' }),
    ) : null,

    section('Bibliographic', [
      field('Title', h('input', { type: 'text', value: t.title || '', onchange: e => set({ title: e.target.value }) })),
      field('Authors', h('textarea', {
        rows: Math.max(2, (t.authors || []).length + 1),
        placeholder: 'One per line',
        value: (t.authors || []).join('\n'),
        onchange: e => set({ authors: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }),
      }), (t.authors || []).length ? null : 'Empty on 20 imported rows — the author is often inside the title instead.'),
      field('Year', h('input', {
        type: 'number', min: 0, max: 3000, value: t.year ?? '',
        onchange: e => set({ year: numOrNull(e.target.value) }),
      })),
      field('Type', selectEl(TYPES.map(x => [x, x]), t.type, v => set({ type: v })),
        'Unknown rows were imported as “book”; correct it here.'),
      field('Journal or publication', h('input', {
        type: 'text', value: t.journal || '', placeholder: 'e.g. Nous',
        onchange: e => set({ journal: e.target.value.trim() || null }),
      }), 'Where it appeared. Shown for reference; never used for nesting.'),
    ]),

    h('section.card',
      h('h2', 'Parent'),
      h('div.field.wide',
        h('label', { for: 'parent-picker' }, 'Nest this under'),
        parentPicker(t, texts, children, set),
        h('p.hint', 'Start typing a title. You can also drag a row onto another in the queue.')),
      t.parent_id ? null : h('div.field.wide',
        h('label', { for: 'f-parent-title-unlinked' }, 'Parent title, not linked'),
        h('input#f-parent-title-unlinked', {
          type: 'text', value: t.container || '', placeholder: 'e.g. Critique of Pure Reason',
          onchange: e => set({ container: e.target.value.trim() || null }),
        }),
        h('p.hint', 'Only for a parent that has no record of its own. The queue groups by this '
          + 'string until you link a real row above, which takes precedence.')),
    ),

    t.status === 'read' || t.status === 'abandoned' ? assessmentCard(t, setAssessment) : null,

    (doc.subjects || []).length ? subjectsCard(t, doc, set) : null,

    section('State', [
      field('Status', selectEl(STATUSES.map(x => [x, STATUS_LABEL[x]]), t.status, v => set({ status: v }))),
      field('Source', selectEl(SOURCES.map(x => [x, x]), t.source || 'queue', v => set({ source: v })),
        'Anything but “queue” was never scored by the model — those are the calibration controls (spec §4).'),
      flags([
        ['notes_written', 'Notes written'],
        ['carded', 'Carded'],
        ['reread_wanted', 'Reread wanted'],
        ...(poolEligible(t) ? [['in_pool', 'In the comparison pool']] : []),
      ], t, set),
    ]),

    section('Effort', [
      field('Pages', h('input', { type: 'number', min: 0, value: t.pages ?? '', onchange: e => set({ pages: numOrNull(e.target.value) }) })),
      field('Estimated hours', h('input', { type: 'number', min: 0, step: 0.25, value: t.est_hours ?? '', onchange: e => set({ est_hours: numOrNull(e.target.value) }) })),
      field('Familiarity', selectEl(
        [['', '—'], [0, '0 unfamiliar'], [1, '1 some'], [2, '2 good'], [3, '3 expert']],
        t.familiarity ?? '', v => set({ familiarity: v === '' ? null : Number(v) })),
        'Prior familiarity at the time of adding — a rubric input, not an outcome.'),
    ]),

    scoreSection(t, setIn, q),

    section('Verdict', [
      h('div.field.wide',
        h('label', { for: 'verdict' }, 'Verdict'),
        h('textarea#verdict', {
          rows: 4, value: t.verdict || '',
          placeholder: 'Two or three sentences, written on finishing.',
          onchange: e => set({ verdict: e.target.value }),
        }),
        h('p.hint', 'The highest-value field in the schema and the cheapest to fill (spec §3). Empty on all 229 imported rows.'),
      ),
    ]),

    section('Links', [
      field('Notes link', h('input', { type: 'url', value: t.notes_link || '', placeholder: 'https://…', onchange: e => set({ notes_link: e.target.value.trim() || null }) })),
      field('Zotero key', h('input', { type: 'text', value: t.zotero_key || '', onchange: e => set({ zotero_key: e.target.value.trim() || null }) })),
      field('DOI', h('input', { type: 'text', value: t.doi || '', placeholder: '10.xxxx/...', onchange: e => set({ doi: e.target.value.trim() || null }) })),
      field('ISBN', h('input', { type: 'text', value: t.isbn || '', onchange: e => set({ isbn: e.target.value.trim() || null }) })),
    ]),

    section('Dates', [
      field('Added', dateInput(t.date_added, v => set({ date_added: v }))),
      field('Started', dateInput(t.date_started, v => set({ date_started: v }))),
      field('Finished', dateInput(t.date_finished, v => set({ date_finished: v }))),
    ]),

    kids.length || t.type === 'book' ? childList(t, kids, ctx) : null,

    provenance(t),

    h('section.card.danger',
      h('h2', 'Remove'),
      h('p.hint', 'Deleting a row is not the same as abandoning it. Abandoned is a first-class outcome and worth keeping (spec §3).'),
      h('button.danger', {
        onclick: () => {
          if (kids.length && !confirm(`${kids.length} rows point at this one as their parent. They will keep a dangling parent_id. Delete anyway?`)) return;
          if (!confirm(`Delete “${t.title}” permanently from data.json?`)) return;
          mutate(d => { d.texts = d.texts.filter(x => x.id !== t.id); });
          location.hash = '#/queue';
        },
      }, 'Delete this text'),
    ),
  );
}

// ── pieces ──────────────────────────────────────────────────────────

function actionBar(t, set, ctx) {
  const btns = [];
  if (t.status === 'queued' || t.status === 'triage') {
    btns.push(h('button.primary', {
      onclick: () => set({ status: 'reading', date_started: t.date_started || todayISO() }),
    }, 'Start reading'));
  }
  if (t.status === 'reading' || t.status === 'queued') {
    // Only one primary at a time: from `queued` the expected next move is to
    // start, not to jump straight to finished.
    btns.push(h(t.status === 'reading' ? 'button.primary' : 'button', {
      onclick: () => {
        set({ status: 'read', date_finished: t.date_finished || todayISO(), date_started: t.date_started || todayISO() });
        setTimeout(() => {
          const v = document.getElementById('verdict');
          if (v) { v.scrollIntoView({ block: 'center' }); v.focus(); }
        }, 0);
      },
    }, 'Finish'));
  }
  if (t.status !== 'abandoned') {
    btns.push(h('button', { onclick: () => set({ status: 'abandoned' }) }, 'Abandon'));
  }
  if (t.status === 'read' || t.status === 'abandoned') {
    btns.push(h('button', { onclick: () => set({ status: 'queued' }) }, 'Return to queue'));
  }
  return h('div.actions', btns);
}

/**
 * The two-sided anchor (spec §4). One click, and the wording matters: this asks
 * whether the hours paid, not whether the text was enjoyed. Absence is a third
 * state and means "not evaluated" — never "average".
 */
/** The coarse link: this text belongs to this subject (§3). */
function subjectsCard(t, doc, set) {
  const on = new Set(t.subject_ids || []);
  return h('section.card',
    h('h2', 'Subjects'),
    h('div.checks', (doc.subjects || []).map(sub =>
      h('label.check',
        h('input', {
          type: 'checkbox', checked: on.has(sub.id),
          onchange: e => {
            const next = e.target.checked
              ? [...new Set([...(t.subject_ids || []), sub.id])]
              : (t.subject_ids || []).filter(x => x !== sub.id);
            set({ subject_ids: next });
          },
        }),
        h('span', sub.name)))),
    h('p.hint', 'Says this text belongs to the subject. To say it covers a particular topic, '
      + 'attach it from the subject instead — both are kept.'));
}

function assessmentCard(t, setAssessment) {
  const btn = (value, label) => h(`button${t.assessment === value ? '.primary' : ''}`, {
    onclick: () => setAssessment(t.assessment === value ? null : value),
  }, label);
  return h('section.card',
    h('h2', 'Was it worth the hours?'),
    h('div.actions',
      btn('good', 'Good'),
      btn('bad', 'Bad'),
      h('span.spacer'),
      h('span.hint.dim', t.assessment ? 'Click again to clear.' : 'Unmarked — not evaluated.')),
    h('p.hint', 'Good means you would have regretted missing it; bad means the hours did not pay. '
      + 'Not whether you enjoyed it — Begriffsschrift is a grind and belongs in good. '
      + 'Leaving it unmarked is fine and is not read as a middling score.'),
  );
}

function scoreSection(t, setIn, q) {
  const p = t.predicted || {};
  const r = t.realized || {};
  const l = t.latent || {};
  const scored = t.status === 'read' || t.status === 'abandoned';
  return h('section.card',
    h('h2', 'Value and cost'),
    h('p.hint', 'Predicted comes from an evaluation, or can be typed in. ',
      h('strong', 'Realized'), ' is yours to enter once the text is finished — what it '
      + 'actually turned out to be worth, on the same 0–10 scale. The gap between the two '
      + 'is the only check on whether the scoring is any good.'),
    h('div.scores',
      scoreRow('Predicted', p, (k, v) => setIn('predicted', k, v), true),
      scoreRow('Realized', r, (k, v) => setIn('realized', k, v), scored,
        scored ? null : 'Realized scores are for finished texts.'),
      scoreRow('Latent (fitted)', l, null, false,
        'Left over from the retired Bradley-Terry fit. Nothing writes here now.'),
    ),
    reasonLines(t.predicted || {}),
    scoreProvenance(t.predicted || {}),
    q ? h('div.quadrant', { dataset: { q: q.key } },
      h('strong', q.label), ' — ', q.note,
    ) : h('p.hint.dim', 'The read/card quadrant appears once both value axes have numbers.'),
  );
}

/**
 * After a relative-only pass the two axes come from different prompt versions,
 * so one line for the row would be false. Say each separately when they differ.
 */
function scoreProvenance(p) {
  if (!p.rubric_version && !p.abs_version && !p.rel_version) return null;
  const a = p.abs_version || p.rubric_version;
  const r = p.rel_version;
  if (r && a && r !== a) {
    return h('p.hint.dim',
      `Absolute scored ${p.abs_date || p.date || ''} under prompt v${a}; `
      + `relative rescored ${p.rel_date || ''} under v${r}.`);
  }
  return h('p.hint.dim', `Scored ${p.date || ''} under prompt version ${a || p.rubric_version}.`);
}

/** `reason` is the pre-split single line; keep showing it on rows that have one. */
function reasonLines(p) {
  const abs = p.reason_abs || p.reason;
  if (!abs && !p.reason_rel) return null;
  return h('div.eval-reasons',
    abs ? h('p.eval-reason', h('span.dim', 'absolute: '), abs) : null,
    p.reason_rel ? h('p.eval-reason', h('span.dim', 'relative: '), p.reason_rel) : null);
}

function scoreRow(label, block, onset, editable, note) {
  const cell = (key) => editable
    ? h('input.score.tabular', {
      type: 'number', min: 0, max: 10, step: 0.1, value: block[key] ?? '',
      'aria-label': `${label} ${key}`,
      onchange: e => onset(key, numOrNull(e.target.value)),
    })
    : h('span.score.tabular.readonly', block[key] == null ? h('span.absent', '·') : Number(block[key]).toFixed(1));
  return h('div.score-row',
    h('span.score-label', label),
    h('span.score-cells',
      h('label', h('span', 'abs'), cell('value_abs')),
      h('label', h('span', 'rel'), cell('value_rel')),
      h('label', h('span', 'cost'), cell('cost')),
    ),
    note ? h('span.hint.dim', note) : null,
  );
}

/**
 * Chapter number first where a chapter number is known, so an imported table of
 * contents reads in reading order rather than alphabetically — otherwise
 * chapter 10 sorts between 1 and 2.
 */
function childOrder(a, b) {
  const an = orderOf(a), bn = orderOf(b);
  if (an != null && bn != null && an !== bn) return an - bn;
  if (an != null && bn == null) return -1;
  if (an == null && bn != null) return 1;
  return sortKeyTitle(a).localeCompare(sortKeyTitle(b));
}

function childList(t, kids, ctx) {
  const find = t.type === 'book' && lookupEnabled()
    ? h('button.small', {
      type: 'button',
      onclick: () => chaptersDialog(t, ctx),
    }, kids.length ? 'Find more chapters' : 'Find chapters')
    : null;

  return h('section.card',
    h('div.card-head',
      h('h2', kids.length
        ? `Contains ${kids.length} row${kids.length === 1 ? '' : 's'}`
        : 'Chapters'),
      find),
    kids.length
      ? h('ul.child-list', kids.slice().sort(childOrder).map(k => h('li',
        k.chapter_no != null ? h('span.chapter-no', `${k.chapter_no}`) : null,
        h('a', { href: `#/text/${encodeURIComponent(k.id)}` }, k.title || '(untitled)'),
        h('span.dim', ` ${STATUS_LABEL[k.status] || k.status}`))))
      : h('p.hint', 'Nothing is nested under this book yet. Crossref can supply the table of '
        + 'contents for books deposited chapter by chapter — mostly academic titles from about '
        + '2005 on.'),
  );
}

/** The import block is provenance, not working state (spec §3): show, don't edit. */
function provenance(t) {
  const im = t.import || {};
  const entries = Object.entries(im).filter(([, v]) =>
    v != null && v !== '' && !(Array.isArray(v) && !v.length) && v !== false);
  if (!entries.length) return null;
  return h('details.card.provenance',
    h('summary', 'Provenance'),
    h('dl', entries.flatMap(([k, v]) => [
      h('dt', k),
      h('dd', Array.isArray(v) ? h('ul', v.map(x => h('li', String(x)))) : String(v)),
    ])),
    h('p.hint', 'Read-only. Records where this row came from and what was uncertain about it, so a bad row can be traced rather than silently trusted.'),
  );
}

// ── small helpers ───────────────────────────────────────────────────

function section(title, children) {
  return h('section.card', h('h2', title), h('div.fields', children));
}

function field(label, control, hint) {
  const id = `f-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  control.id = control.id || id;
  return h('div.field', h('label', { for: control.id }, label), control, hint ? h('p.hint', hint) : null);
}

function selectEl(options, value, onchange) {
  return h('select', { onchange: e => onchange(e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}

/**
 * Any row may be a parent now that nesting is arbitrary (book -> chapter ->
 * section). The one thing the picker must refuse is a row's own descendant:
 * a cycle would hang the queue renderer, so it is prevented at entry rather
 * than defended against on every read.
 */
function parentPicker(t, texts, children, set) {
  const banned = descendantIds(t.id, children);
  banned.add(t.id);
  return rowPicker({
    texts,
    value: t.parent_id || null,
    banned,
    placeholder: 'Type a book or article title...',
    onChange: (id) => set({ parent_id: id || null }),
  });
}

function dateInput(value, onchange) {
  return h('input', {
    type: 'date', value: value || '',
    onchange: e => onchange(e.target.value || null),
  });
}

function flags(list, t, set) {
  return h('div.field.wide', h('label', 'Flags'),
    h('div.checks', list.map(([key, label]) =>
      h('label.check',
        h('input', { type: 'checkbox', checked: !!t[key], onchange: e => set({ [key]: e.target.checked }) }),
        h('span', label)))),
    h('p.hint', 'Notes and cards are independent, not stages — a text can be carded without notes.'));
}

function numOrNull(v) {
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
