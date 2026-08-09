// Text detail (spec §5.2). Every field editable, including the many the import
// left null. Scores are hand-enterable in phase 1 and optional (spec §6).

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import {
  TYPES, STATUSES, SOURCES, STATUS_LABEL, childIndex, byIdIndex, isContainer,
  containerName, unreadPrerequisites, quadrant, scores, todayISO, sortKeyTitle,
} from '../model.js';

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
  const container = isContainer(t, children);
  const set = (patch) => { mutate(d => { Object.assign(d.texts.find(x => x.id === t.id), patch); }); ctx.rerender(); };
  const setIn = (block, key, value) => {
    mutate(d => {
      const row = d.texts.find(x => x.id === t.id);
      row[block] = { ...(row[block] || {}), [key]: value };
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
        container ? ` · container of ${kids.length} item${kids.length === 1 ? '' : 's'}` : '',
      ),
    ),

    container ? h('p.notice.quiet',
      'This row is a container — a shelf holding other rows. Containers are never scored and never appear in the queue (spec §3).') : null,

    blocked.length ? h('p.notice.warn',
      `Prerequisites still unread: ${blocked.map(b => b.title).join('; ')}.`) : null,

    actionBar(t, set, ctx),

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
      field('Container (free text)', h('input', {
        type: 'text', value: t.container || '', placeholder: 'e.g. Beyond Concepts',
        onchange: e => set({ container: e.target.value.trim() || null }),
      })),
      field('Parent row', parentSelect(t, texts, children, v => set({ parent_id: v || null })),
        'Links this row to a container row that exists in the file.'),
    ]),

    section('State', [
      field('Status', selectEl(STATUSES.map(x => [x, STATUS_LABEL[x]]), t.status, v => set({ status: v }))),
      field('Source', selectEl(SOURCES.map(x => [x, x]), t.source || 'queue', v => set({ source: v })),
        'Anything but “queue” was never scored by the model — those are the calibration controls (spec §4).'),
      flags([
        ['notes_written', 'Notes written'],
        ['carded', 'Carded'],
        ['reread_wanted', 'Reread wanted'],
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

    container ? null : scoreSection(t, setIn, q),

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
    ]),

    section('Dates', [
      field('Added', dateInput(t.date_added, v => set({ date_added: v }))),
      field('Started', dateInput(t.date_started, v => set({ date_started: v }))),
      field('Finished', dateInput(t.date_finished, v => set({ date_finished: v }))),
    ]),

    kids.length ? childList(kids) : null,

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

function scoreSection(t, setIn, q) {
  const p = t.predicted || {};
  const r = t.realized || {};
  const l = t.latent || {};
  const scored = t.status === 'read' || t.status === 'abandoned';
  return h('section.card',
    h('h2', 'Value and cost'),
    h('p.hint', 'Optional in phase 1 and empty on every imported row. Type numbers in by hand if you want the queue to sort by priority before the comparison machinery exists.'),
    h('div.scores',
      scoreRow('Predicted', p, (k, v) => setIn('predicted', k, v), true),
      scoreRow('Realized', r, (k, v) => setIn('realized', k, v), scored,
        scored ? null : 'Realized scores are for finished texts.'),
      scoreRow('Latent (fitted)', l, null, false, 'Written by the Bradley-Terry fit in phase 2.'),
    ),
    q ? h('div.quadrant', { dataset: { q: q.key } },
      h('strong', q.label), ' — ', q.note,
    ) : h('p.hint.dim', 'The read/card quadrant appears once both value axes have numbers.'),
  );
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

function childList(kids) {
  return h('section.card',
    h('h2', `Contains ${kids.length} row${kids.length === 1 ? '' : 's'}`),
    h('ul.child-list', kids
      .slice().sort((a, b) => sortKeyTitle(a).localeCompare(sortKeyTitle(b)))
      .map(k => h('li',
        h('a', { href: `#/text/${encodeURIComponent(k.id)}` }, k.title || '(untitled)'),
        h('span.dim', ` ${STATUS_LABEL[k.status] || k.status}`)))));
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

function parentSelect(t, texts, children, onchange) {
  const candidates = texts
    .filter(x => x.id !== t.id && (isContainer(x, children) || x.type === 'book' || x.type === 'collection'))
    .sort((a, b) => sortKeyTitle(a).localeCompare(sortKeyTitle(b)));
  return selectEl([['', '— none —'], ...candidates.map(c => [c.id, c.title || c.id])], t.parent_id || '', onchange);
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
