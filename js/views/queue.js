// Queue view (spec §5.1).
//
// THE CONSTRAINT THAT SHAPES THIS FILE: nothing in data.json is scored, and
// nothing will be until phase 2. Not the value blocks, and not `pages`,
// `est_hours` or `familiarity` either — those are null on all 71 queued rows.
// So this view cannot lean on any number. It:
//
//   * computes priority as null rather than NaN when inputs are missing,
//   * hides a column entirely when no visible row has a value for it, so the
//     page shows data instead of a grid of em dashes,
//   * sorts unscored rows by date added, deterministically, tie-broken on
//     title so the order never jitters between renders,
//   * and treats the arrival of the first score as an ordinary case, not a
//     mode switch: scored rows simply sort above unscored ones.

import { h, mount } from '../dom.js';
import { state, savePrefs } from '../store.js';
import {
  childIndex, byIdIndex, isContainer, containerName, unreadPrerequisites,
  authorLine, priority, isScored, scores, sortKeyTitle, fold, STATUS_LABEL,
} from '../model.js';

const SCOPES = {
  active: { label: 'Active', test: t => t.status === 'queued' || t.status === 'reading' },
  queued: { label: 'Queued', test: t => t.status === 'queued' },
  reading: { label: 'Reading', test: t => t.status === 'reading' },
  read: { label: 'Read', test: t => t.status === 'read' },
  abandoned: { label: 'Abandoned', test: t => t.status === 'abandoned' },
  all: { label: 'All', test: t => t.status !== 'triage' },
};

const SORTS = {
  smart: 'Priority, then date added',
  'added-desc': 'Date added — newest',
  'added-asc': 'Date added — oldest',
  title: 'Title',
  author: 'Author',
  container: 'Container',
};

export function renderQueue(root, ctx) {
  const doc = state.doc;
  const prefs = state.prefs;
  const f = prefs.filters;
  const texts = doc.texts || [];
  const children = childIndex(texts);
  const byId = byIdIndex(texts);

  const scope = SCOPES[f.status] ? f.status : 'active';
  const inScope = texts.filter(SCOPES[scope].test);

  // Containers are shelves, never queue items (spec §3). They are listed
  // separately rather than dropped, or the user loses the ability to reach
  // the Hieronymi block and its 26 children at all.
  const containers = inScope.filter(t => isContainer(t, children));
  const items = inScope.filter(t => !isContainer(t, children));

  const filtered = items.filter(t => matches(t, f, byId));
  const rows = sortRows(filtered, prefs, byId);

  const cols = visibleColumns(rows, prefs);
  const anyScored = texts.some(isScored);
  const readingCount = texts.filter(t => t.status === 'reading').length;
  const triageCount = texts.filter(t => t.status === 'triage').length;

  mount(root,
    h('header.view-head',
      h('h1', 'Queue'),
      h('p.counts',
        `${rows.length} of ${items.length} ${SCOPES[scope].label.toLowerCase()}`,
        containers.length ? ` · ${containers.length} container${containers.length === 1 ? '' : 's'}` : null,
        triageCount ? [' · ', h('a', { href: '#/triage' }, `${triageCount} in triage`)] : null,
      ),
    ),

    controls(prefs, scope, doc, ctx),

    readingCount > 4 ? h('p.notice.quiet',
      `${readingCount} texts are open at once. Not a rule, just worth noticing.`) : null,

    !anyScored ? h('p.notice.quiet',
      'No scores yet. Sorted by date added; value and cost can be typed in by hand on any text, and the priority sort switches on by itself once they exist.',
    ) : null,

    anyScored ? sliders(prefs) : null,

    containers.length ? containerStrip(containers, children) : null,

    rows.length
      ? h('ol.rows', { role: 'list' }, rows.map(t => row(t, { cols, prefs, byId, children })))
      : emptyState(f, scope, items.length, ctx),
  );
}

// ── filtering ───────────────────────────────────────────────────────

function matches(t, f, byId) {
  if (f.type && t.type !== f.type) return false;
  if (f.project && !(t.project_ids || []).includes(f.project)) return false;
  if (f.familiarity !== '' && f.familiarity != null && String(t.familiarity ?? '') !== String(f.familiarity)) return false;
  if (f.q) {
    const q = fold(f.q);
    const hay = fold([
      t.title,
      (t.authors || []).join(' '),
      t.container,
      containerName(t, byId),
      (t.import || {}).raw_title,
      (t.import || {}).also_known_as,
      t.year,
    ].filter(Boolean).join('  '));
    if (!hay.includes(q)) return false;
  }
  return true;
}

// ── sorting ─────────────────────────────────────────────────────────

function dateCmp(a, b, dir) {
  const da = a.date_added || '', db = b.date_added || '';
  if (da === db) return 0;
  if (!da) return 1;               // rows with no date always sort last,
  if (!db) return -1;              // whichever direction is chosen
  return dir === 'asc' ? (da < db ? -1 : 1) : (da > db ? -1 : 1);
}

function titleCmp(a, b) {
  return sortKeyTitle(a).localeCompare(sortKeyTitle(b));
}

function sortRows(rows, prefs, byId) {
  const { sort, w, alpha } = prefs;
  const out = rows.slice();
  out.sort((a, b) => {
    switch (sort) {
      case 'added-desc': return dateCmp(a, b, 'desc') || titleCmp(a, b);
      case 'added-asc': return dateCmp(a, b, 'asc') || titleCmp(a, b);
      case 'title': return titleCmp(a, b);
      case 'author': {
        const aa = fold(authorLine(a) || '\uffff'), bb = fold(authorLine(b) || '\uffff');
        return aa.localeCompare(bb) || titleCmp(a, b);
      }
      case 'container': {
        const ca = fold(containerName(a, byId) || '\uffff'), cb = fold(containerName(b, byId) || '\uffff');
        return ca.localeCompare(cb) || titleCmp(a, b);
      }
      case 'smart':
      default: {
        // Scored rows first, best priority at the top. Everything unscored
        // falls through to date added — which today is every single row.
        const pa = priority(a, w, alpha), pb = priority(b, w, alpha);
        if (pa != null && pb == null) return -1;
        if (pa == null && pb != null) return 1;
        if (pa != null && pb != null && pa !== pb) return pb - pa;
        return dateCmp(a, b, 'desc') || titleCmp(a, b);
      }
    }
  });
  return out;
}

/** A column appears only if some visible row has something to put in it. */
function visibleColumns(rows, prefs) {
  const any = fn => rows.some(fn);
  const hasValue = any(t => { const s = scores(t); return s.value_abs != null || s.value_rel != null; });
  const hasCost = any(t => scores(t).cost != null);
  return {
    value: hasValue,
    cost: hasCost,
    priority: any(t => priority(t, prefs.w, prefs.alpha) != null),
    est: any(t => t.est_hours != null),
    pages: any(t => t.pages != null),
  };
}

// ── chrome ──────────────────────────────────────────────────────────

function controls(prefs, scope, doc, ctx) {
  const f = prefs.filters;
  const setF = patch => savePrefs({ filters: { ...f, ...patch } });
  const projects = doc.projects || [];
  const types = [...new Set((doc.texts || []).map(t => t.type))].sort();

  return h('div.controls',
    h('input.search', {
      type: 'search', id: 'q', placeholder: 'Search title, author, container…',
      value: f.q, 'aria-label': 'Search',
      oninput: e => setF({ q: e.target.value }),
    }),
    select('Show', f.status || 'active', Object.entries(SCOPES).map(([k, v]) => [k, v.label]),
      v => setF({ status: v })),
    select('Sort', prefs.sort, Object.entries(SORTS), v => savePrefs({ sort: v })),
    types.length > 1
      ? select('Type', f.type, [['', 'Any type'], ...types.map(t => [t, t])], v => setF({ type: v }))
      : null,
    projects.length
      ? select('Project', f.project, [['', 'Any project'], ...projects.map(p => [p.id, p.title])],
        v => setF({ project: v }))
      : null,
    (f.q || f.type || f.project || f.familiarity !== '')
      ? h('button.link', { onclick: () => setF({ q: '', type: '', project: '', familiarity: '' }) }, 'Clear filters')
      : null,
    h('span.spacer'),
    h('button', { onclick: () => ctx.newText() }, 'New text'),
    h('button', { onclick: () => ctx.quickLog() }, 'Quick-log'),
  );
}

function select(label, value, options, onchange) {
  return h('label.sel', h('span.sr-only', label),
    h('select', { value, onchange: e => onchange(e.target.value), 'aria-label': label },
      options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l))));
}

function sliders(prefs) {
  return h('div.sliders',
    slider('Absolute weight', 'w', prefs.w, 0, 1, 0.05,
      v => `${Math.round(v * 100)}% absolute / ${Math.round((1 - v) * 100)}% relative`),
    slider('Cost exponent', 'alpha', prefs.alpha, 0, 1.5, 0.05, v => `alpha ${v.toFixed(2)}`),
  );
}

function slider(label, key, value, min, max, step, fmt) {
  const out = h('output.tabular', fmt(value));
  return h('label.slider',
    h('span', label),
    h('input', {
      type: 'range', min, max, step, value,
      oninput: e => { out.textContent = fmt(Number(e.target.value)); },
      onchange: e => savePrefs({ [key]: Number(e.target.value) }),
    }),
    out);
}

function containerStrip(containers, children) {
  const total = containers.reduce((n, c) => n + (children.get(c.id) || []).length, 0);
  return h('details.containers',
    h('summary', `${containers.length} container${containers.length === 1 ? '' : 's'} holding ${total} item${total === 1 ? '' : 's'} — shelves, not readings`),
    h('ul', containers
      .slice()
      .sort((a, b) => (children.get(b.id) || []).length - (children.get(a.id) || []).length)
      .map(c => h('li',
        h('a', { href: `#/text/${encodeURIComponent(c.id)}` }, c.title || '(untitled)'),
        h('span.dim', ` ${(children.get(c.id) || []).length} item${(children.get(c.id) || []).length === 1 ? '' : 's'} · ${c.type}`),
      ))),
  );
}

// ── row ─────────────────────────────────────────────────────────────

function row(t, { cols, prefs, byId, children }) {
  const s = scores(t);
  const p = priority(t, prefs.w, prefs.alpha);
  const cont = containerName(t, byId);
  const author = authorLine(t);
  const blocked = unreadPrerequisites(t, byId);

  const meta = [
    author,
    t.year || null,
    t.type !== 'article' ? t.type : null,
  ].filter(Boolean);

  return h('li.row', { dataset: { id: t.id } },
    h('a.row-main', { href: `#/text/${encodeURIComponent(t.id)}` },
      h('span.title', t.title || '(untitled)'),
      meta.length ? h('span.meta', meta.join(' · ')) : null,
      cont ? h('span.container-of', 'in ', h('em', cont)) : null,
    ),
    h('div.row-tags',
      t.status === 'reading' ? h('span.tag.reading', 'Reading') : null,
      t.status === 'read' ? h('span.tag.read', 'Read') : null,
      t.status === 'abandoned' ? h('span.tag.abandoned', 'Abandoned') : null,
      t.reread_wanted ? h('span.tag', 'Reread wanted') : null,
      t.notes_written ? h('span.tag.soft', 'Notes') : null,
      t.carded ? h('span.tag.soft', 'Cards') : null,
      (t.project_ids || []).length ? h('span.tag.soft', 'Project') : null,
      blocked.length
        ? h('span.tag.warn', { title: blocked.map(x => x.title).join('; ') },
          `${blocked.length} prerequisite${blocked.length === 1 ? '' : 's'} unread`)
        : null,
    ),
    h('div.row-nums',
      cols.value ? num(fmt1(s.value_abs)) : null,
      cols.value ? num(fmt1(s.value_rel)) : null,
      cols.cost ? num(fmt1(s.cost)) : null,
      cols.priority ? num(p == null ? '' : p.toFixed(2), 'strong') : null,
      cols.est ? num(t.est_hours == null ? '' : `${t.est_hours}h`) : null,
      h('span.date.tabular', t.date_added || ''),
    ),
  );
}

function num(v, cls) {
  return h(`span.n.tabular${cls ? '.' + cls : ''}`, v === '' || v == null ? h('span.absent', '·') : v);
}

function fmt1(v) { return v == null ? '' : Number(v).toFixed(1); }

// ── empty ───────────────────────────────────────────────────────────

function emptyState(f, scope, total, ctx) {
  const filtering = f.q || f.type || f.project || f.familiarity !== '';
  if (filtering && total) {
    return h('div.empty',
      h('p', `Nothing matches. ${total} ${SCOPES[scope].label.toLowerCase()} texts are hidden by the current filters.`),
      h('button', { onclick: () => savePrefs({ filters: { ...f, q: '', type: '', project: '', familiarity: '' } }) },
        'Clear filters'));
  }
  return h('div.empty',
    h('p', `Nothing ${SCOPES[scope].label.toLowerCase()} yet.`),
    h('div.empty-actions',
      h('button', { onclick: () => ctx.newText() }, 'Add a text to the queue'),
      h('button', { onclick: () => ctx.quickLog() }, 'Log something you already read')));
}
