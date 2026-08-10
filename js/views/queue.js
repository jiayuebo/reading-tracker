// Queue view (spec §5.1).
//
// TWO CONSTRAINTS SHAPE THIS FILE.
//
// 1. Almost nothing is scored, and `pages` / `est_hours` / `familiarity` are
//    null on nearly every row too. So the view cannot lean on any number: it
//    computes priority as null rather than NaN, hides any column no visible row
//    has a value for, and falls back to date added, tie-broken on title so the
//    order never jitters. Scored rows simply sort above unscored ones, which
//    means the arrival of the first score is an ordinary case, not a mode.
//
// 2. Rows nest to arbitrary depth (book -> chapter -> section). Nesting must not
//    fight the ordering. So the flat order is computed FIRST, by exactly the
//    comparator a flat list would use, and each group is then positioned at its
//    best-ranked member. Hierarchy clusters the list; it never reorders it.

import { h, mount } from '../dom.js';
import { state, savePrefs } from '../store.js';
import {
  childIndex, byIdIndex, containerName, unreadPrerequisites, groupKey, MAX_DEPTH,
  authorLine, priority, isScored, scores, sortKeyTitle, fold,
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
};

export function renderQueue(root, ctx) {
  const doc = state.doc;
  const prefs = state.prefs;
  const f = prefs.filters;
  const texts = doc.texts || [];
  const children = childIndex(texts);
  const byId = byIdIndex(texts);

  const scope = SCOPES[f.status] ? f.status : 'active';
  const visible = texts.filter(SCOPES[scope].test).filter(t => matches(t, f, byId));
  const ordered = sortRows(visible, prefs);

  const cols = visibleColumns(ordered, prefs);
  const anyScored = texts.some(isScored);
  const readingCount = texts.filter(t => t.status === 'reading').length;
  const triageCount = texts.filter(t => t.status === 'triage').length;
  const inScopeTotal = texts.filter(SCOPES[scope].test).length;

  const forest = prefs.group === false ? null : buildForest(ordered, byId, children);
  const leafCount = forest ? countLeaves(forest) : ordered.length;
  const groupCount = forest ? forest.filter(n => n.children.length).length : 0;

  mount(root,
    h('header.view-head',
      h('h1', 'Queue'),
      h('p.counts',
        `${leafCount} of ${inScopeTotal} ${SCOPES[scope].label.toLowerCase()}`,
        groupCount ? ` · ${groupCount} grouped under a parent` : null,
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

    ordered.length
      ? (forest
        ? h('ol.rows', { role: 'list' }, forest.map(n => renderNode(n, { cols, prefs, byId, children }, 0)))
        : h('ol.rows', { role: 'list' },
          ordered.map(t => h('li.group', row(t, { cols, prefs, byId, children }, 0)))))
      : emptyState(f, scope, inScopeTotal, ctx),
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
      (t.shelves || []).join(' '),
      (t.import || {}).raw_title,
      (t.import || {}).also_known_as,
      t.year,
    ].filter(Boolean).join('  '));
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

function sortRows(rows, prefs) {
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
      case 'smart':
      default: {
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
  return {
    value: any(t => { const s = scores(t); return s.value_abs != null || s.value_rel != null; }),
    cost: any(t => scores(t).cost != null),
    priority: any(t => priority(t, prefs.w, prefs.alpha) != null),
    est: any(t => t.est_hours != null),
  };
}

// ── hierarchy ───────────────────────────────────────────────────────

/**
 * Turn the already-ordered flat list into a forest.
 *
 * A node is `ghost` when it exists only to hold children — a parent row that is
 * out of the current scope (a finished book whose chapters are still queued), or
 * a container named in free text with no row of its own. Ghosts are structure,
 * not readings, and are not counted or scored.
 */
function buildForest(ordered, byId, children) {
  const nodes = new Map();
  const rankOf = new Map();
  ordered.forEach((t, i) => rankOf.set(t.id, i));

  const nodeForRow = (t, ghost) => {
    const key = `id:${t.id}`;
    if (!nodes.has(key)) {
      nodes.set(key, { key, row: t, label: t.title, ghost, children: [], rank: Infinity });
    } else if (!ghost) {
      nodes.get(key).ghost = false;
    }
    return nodes.get(key);
  };
  const nodeForText = (label) => {
    const key = `text:${fold(label)}`;
    if (!nodes.has(key)) {
      nodes.set(key, { key, row: null, label, ghost: true, children: [], rank: Infinity });
    }
    return nodes.get(key);
  };

  const roots = [];
  const rooted = new Set();
  const placed = new Set();
  const pushRoot = (node) => {
    if (rooted.has(node.key)) return;
    rooted.add(node.key);
    roots.push(node);
  };

  // A parent that is also a row in its own right is reached twice — once as
  // somebody's parent, once on its own pass through the list. `placed` makes
  // linking idempotent so the group is not emitted (and counted) twice.
  const attach = (node, t, depth) => {
    if (placed.has(node.key)) return;
    placed.add(node.key);
    if (depth > MAX_DEPTH) { pushRoot(node); return; }   // cycle or absurd nesting
    const gk = groupKey(t, byId);
    if (!gk) { pushRoot(node); return; }
    if (gk.startsWith('text:')) {
      const parent = nodeForText(t.container);
      parent.children.push(node);
      pushRoot(parent);
      return;
    }
    const parentRow = byId.get(gk.slice(3));
    const parent = nodeForRow(parentRow, !rankOf.has(parentRow.id));
    parent.children.push(node);
    attach(parent, parentRow, depth + 1);
  };

  for (const t of ordered) attach(nodeForRow(t, false), t, 0);

  // A group sits where its best member sits. Computed bottom-up so a chapter
  // ranked first pulls its whole book to the top of the page.
  const rank = (n, depth = 0) => {
    if (depth > MAX_DEPTH) return Infinity;
    const own = n.row && rankOf.has(n.row.id) ? rankOf.get(n.row.id) : Infinity;
    n.rank = Math.min(own, ...n.children.map(c => rank(c, depth + 1)), Infinity);
    return n.rank;
  };
  const sortTree = (list, depth = 0) => {
    if (depth > MAX_DEPTH) return list;
    list.sort((a, b) => a.rank - b.rank);
    for (const n of list) sortTree(n.children, depth + 1);
    return list;
  };
  roots.forEach(n => rank(n));
  return sortTree(roots);
}

function countLeaves(forest) {
  let n = 0;
  const walk = (list, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const node of list) {
      if (!node.ghost) n++;
      walk(node.children, depth + 1);
    }
  };
  walk(forest, 0);
  return n;
}

function renderNode(node, ctx, depth) {
  const kids = node.children.length
    ? h('ol.subrows', { role: 'list' }, node.children.map(c => renderNode(c, ctx, depth + 1)))
    : null;

  if (node.ghost) {
    return h('li.group',
      node.row
        ? h('a.group-head', { href: `#/text/${encodeURIComponent(node.row.id)}` },
          h('span.group-title', node.label),
          h('span.group-note', `${node.row.type} · not in this view`))
        : h('div.group-head.plain',
          h('span.group-title', node.label),
          h('span.group-note', 'no record of its own')),
      kids);
  }
  return h('li.group', row(node.row, ctx, depth, node.children.length), kids);
}

// ── row ─────────────────────────────────────────────────────────────

function row(t, { cols, prefs, byId, children }, depth = 0, childCount = 0) {
  const s = scores(t);
  const p = priority(t, prefs.w, prefs.alpha);
  const author = authorLine(t);
  const blocked = unreadPrerequisites(t, byId);
  const cont = depth === 0 ? containerName(t, byId) : null;

  const meta = [author, t.year || null, t.type !== 'article' ? t.type : null].filter(Boolean);

  return h('div.row', { dataset: { id: t.id } },
    h('a.row-main', { href: `#/text/${encodeURIComponent(t.id)}` },
      h('span.title', t.title || '(untitled)'),
      meta.length ? h('span.meta', meta.join(' · ')) : null,
      cont ? h('span.container-of', 'in ', h('em', cont)) : null,
      childCount ? h('span.container-of', `${childCount} inside`) : null,
    ),
    h('div.row-tags',
      t.status === 'reading' ? h('span.tag.reading', 'Reading') : null,
      t.status === 'read' ? h('span.tag.read', 'Read') : null,
      t.status === 'abandoned' ? h('span.tag.abandoned', 'Abandoned') : null,
      t.reread_wanted ? h('span.tag', 'Reread wanted') : null,
      t.notes_written ? h('span.tag.soft', 'Notes') : null,
      t.carded ? h('span.tag.soft', 'Cards') : null,
      (t.project_ids || []).length ? h('span.tag.soft', 'Project') : null,
      (t.shelves || []).map(sh => h('span.tag.soft', { title: sh }, sh.length > 22 ? sh.slice(0, 21) + '…' : sh)),
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
    select('Show', scope, Object.entries(SCOPES).map(([k, v]) => [k, v.label]), v => setF({ status: v })),
    select('Sort', prefs.sort, Object.entries(SORTS), v => savePrefs({ sort: v })),
    types.length > 1
      ? select('Type', f.type, [['', 'Any type'], ...types.map(t => [t, t])], v => setF({ type: v }))
      : null,
    projects.length
      ? select('Project', f.project, [['', 'Any project'], ...projects.map(p => [p.id, p.title])],
        v => setF({ project: v }))
      : null,
    h('label.check',
      h('input', {
        type: 'checkbox', checked: prefs.group !== false,
        onchange: e => savePrefs({ group: e.target.checked }),
      }),
      h('span', 'Nest under parents')),
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
