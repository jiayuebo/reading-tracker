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
import { state, savePrefs, mutate } from '../store.js';
import {
  childIndex, byIdIndex, containerName, unreadPrerequisites, groupKey, MAX_DEPTH, descendantIds,
  authorLine, priority, isScored, scores, sortKeyTitle, fold, matchesQuery, todayISO, orderOf,
  poolEligible, inPool,
} from '../model.js';
import { rowPicker } from './row-picker.js';

// Checkboxes, unioned — not a dropdown of preset combinations. A dropdown made
// "queued" and "queued + reading" look like two unrelated modes when one is a
// superset of the other, and it could not express "read and abandoned" at all.
// `triage` is deliberately absent: it has its own view and is not a reading state.
const STATUS_FILTERS = [
  ['queued', 'Queued'],
  ['reading', 'Reading'],
  ['read', 'Read'],
  ['abandoned', 'Abandoned'],
];

const DEFAULT_STATUSES = ['queued', 'reading'];

/**
 * Bulk selection (spec §5.1).
 *
 * Module-level so it survives the re-render every edit triggers, and pruned to
 * what is currently on screen at the top of each render. That pruning is the
 * safety property: a bulk action can only ever touch rows the filter and the
 * search are showing you, so there is no way to delete something you cannot
 * see because it was selected under a filter you have since changed.
 */
const selected = new Set();

/**
 * Which statuses are showing. Migrates the single-scope key this replaced, so a
 * saved preference from before the change still means what it used to.
 */
function statusesOf(f) {
  if (Array.isArray(f.statuses)) return f.statuses;
  const legacy = {
    active: ['queued', 'reading'], queued: ['queued'], reading: ['reading'],
    read: ['read'], abandoned: ['abandoned'],
    all: ['queued', 'reading', 'read', 'abandoned'],
  };
  return legacy[f.status] || DEFAULT_STATUSES;
}

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

  const statuses = statusesOf(f);
  const inScope = t => statuses.includes(t.status);
  const visible = texts.filter(inScope).filter(t => matches(t, f, byId));
  const ordered = sortRows(visible, prefs);

  const cols = visibleColumns(ordered, prefs);
  const anyScored = texts.some(isScored);
  const readingCount = texts.filter(t => t.status === 'reading').length;
  const triageCount = texts.filter(t => t.status === 'triage').length;
  const inScopeTotal = texts.filter(inScope).length;
  const showsFinished = statuses.includes('read') || statuses.includes('abandoned');

  // Prune first: `ordered` is exactly what is on screen.
  const visibleIds = new Set(ordered.map(t => t.id));
  for (const id of [...selected]) if (!visibleIds.has(id)) selected.delete(id);
  const picked = ordered.filter(t => selected.has(t.id));

  const sel = {
    has: id => selected.has(id),
    toggle: (id, on) => { if (on) selected.add(id); else selected.delete(id); ctx.rerender(); },
  };

  const drag = { byId, children, enabled: prefs.group !== false };
  const forest = prefs.group === false ? null : buildForest(ordered, byId, children);
  const leafCount = forest ? countLeaves(forest) : ordered.length;
  const groupCount = forest ? forest.filter(n => n.children.length).length : 0;

  mount(root,
    h('header.view-head',
      h('h1', 'Queue'),
      h('p.counts',
        statuses.length
          ? `${leafCount} of ${inScopeTotal} ${statuses.join(', ')}`
          : 'no statuses selected',
        groupCount ? ` · ${groupCount} grouped under a parent` : null,
        triageCount ? [' · ', h('a', { href: '#/triage' }, `${triageCount} in triage`)] : null,
      ),
    ),

    controls(prefs, statuses, doc, ctx),

    readingCount > 4 ? h('p.notice.quiet',
      `${readingCount} texts are open at once. Not a rule, just worth noticing.`) : null,

    showsFinished
      ? (() => {
        const readable = texts.filter(t => t.status === 'read' || t.status === 'abandoned');
        const marked = readable.filter(t => t.assessment).length;
        return h('p.notice.quiet',
          `${marked} of ${readable.length} read texts carry a good/bad mark. `,
          h('kbd', '1'), ' good · ', h('kbd', '2'), ' bad · ', h('kbd', '0'), ' clear, on the focused row. ',
          'Good means the hours paid, not that you enjoyed it. Unmarked means not evaluated, and is never read as average.');
      })()
      : null,

    !anyScored ? h('p.notice.quiet',
      'No scores yet. Sorted by date added; value and cost can be typed in by hand on any text, and the priority sort switches on by itself once they exist.',
    ) : null,

    anyScored ? sliders(prefs) : null,

    prefs.group !== false ? unnestZone() : null,

    ordered.length ? selectionBar(ordered, picked, byId, children, texts, doc, ctx) : null,

    ordered.length
      ? (forest
        ? h('ol.rows', { role: 'list' }, forest.map(n => renderNode(n, { cols, prefs, byId, children, drag, ctx, sel }, 0)))
        : h('ol.rows', { role: 'list' },
          ordered.map(t => h('li.group', row(t, { cols, prefs, byId, children, drag, ctx, sel }, 0)))))
      : emptyState(f, statuses, inScopeTotal, ctx),
  );
}

// ── bulk selection ──────────────────────────────────────────────────

/**
 * Apply one change to every selected row that it actually makes sense for, in
 * a single mutation so it is one save and one undo step.
 *
 * Actions report what they skipped rather than silently applying to everything:
 * "Start" on a row already read is not a no-op the user meant, it is a row the
 * action does not fit, and saying so is how you notice you selected too much.
 */
function applyToPicked(picked, { fits, change, did, verb }, ctx) {
  const hits = picked.filter(fits);
  if (!hits.length) {
    ctx.toast(`Nothing to ${verb}: none of the ${picked.length} selected `
      + `row${picked.length === 1 ? ' is' : 's are'} in a state for it.`);
    return;
  }
  const ids = new Set(hits.map(t => t.id));
  mutate(d => { for (const row of d.texts) if (ids.has(row.id)) change(row); });
  const skipped = picked.length - hits.length;
  ctx.toast(`${did} ${hits.length} row${hits.length === 1 ? '' : 's'}`
    + (skipped ? `; left ${skipped} alone as ${skipped === 1 ? 'it was' : 'they were'} not in a state for it.` : '.'));
}

/**
 * Delete the selected rows and every reference to them.
 *
 * A row id is pointed at from four places, and leaving any of them behind
 * leaves the file quietly inconsistent: a child's `parent_id`, another text's
 * `prerequisite_ids`, and a subject topic's `text_ids`. Children of a deleted
 * row that are not themselves selected are promoted to top level rather than
 * left pointing at nothing.
 */
function deletePicked(picked, byId, children, ctx) {
  const ids = new Set(picked.map(t => t.id));
  const orphans = [];
  for (const t of picked) {
    for (const k of children.get(t.id) || []) if (!ids.has(k.id)) orphans.push(k);
  }
  const lines = [
    `Delete ${picked.length} row${picked.length === 1 ? '' : 's'}?`,
    '',
    ...picked.slice(0, 12).map(t => `  · ${t.title || '(untitled)'}`),
    picked.length > 12 ? `  · …and ${picked.length - 12} more` : null,
    '',
    orphans.length
      ? (orphans.length === 1
        ? '1 row nested under them is not selected. It will be moved to the top level rather '
          + 'than left pointing at a row that no longer exists.'
        : `${orphans.length} rows nested under them are not selected. They will be moved to the `
          + 'top level rather than left pointing at a row that no longer exists.')
      : null,
    'This cannot be undone from inside the app. The previous version stays in the repository history.',
  ].filter(x => x !== null);
  if (!confirm(lines.join('\n'))) return;

  mutate(d => {
    d.texts = d.texts.filter(t => !ids.has(t.id));
    for (const t of d.texts) {
      if (t.parent_id && ids.has(t.parent_id)) t.parent_id = null;
      if ((t.prerequisite_ids || []).some(x => ids.has(x))) {
        t.prerequisite_ids = t.prerequisite_ids.filter(x => !ids.has(x));
      }
    }
    for (const sub of d.subjects || []) {
      for (const tp of sub.topics || []) {
        if ((tp.text_ids || []).some(x => ids.has(x))) {
          tp.text_ids = tp.text_ids.filter(x => !ids.has(x));
        }
      }
    }
  });
  selected.clear();
  ctx.toast(`Deleted ${picked.length} row${picked.length === 1 ? '' : 's'}`
    + (orphans.length ? `; moved ${orphans.length} to the top level.` : '.')
    + ' Save when ready.');
}

/**
 * Re-parent every selected row at once.
 *
 * The banned set is the whole point: a parent cannot be one of the rows being
 * moved, nor a descendant of one, or the move builds a cycle and the queue's
 * forest walk hits its depth guard instead of drawing anything.
 */
function nestPicked(picked, texts, children, ctx) {
  const ids = new Set(picked.map(t => t.id));
  const banned = new Set(ids);
  for (const t of picked) for (const d of descendantIds(t.id, children)) banned.add(d);

  const status = h('p.hint');
  let choice = null;
  const apply = () => {
    if (!choice) { status.className = 'hint bad'; status.textContent = 'Pick a parent first.'; return; }
    mutate(d => {
      for (const row of d.texts) {
        if (!ids.has(row.id)) continue;
        row.parent_id = choice;
        // A linked parent wins over the free-text one, so leaving the old
        // string behind would only ever be confusing.
        if (row.container) row.container = null;
      }
    });
    const title = (texts.find(x => x.id === choice) || {}).title || 'it';
    dlg.destroy();
    selected.clear();
    ctx.toast(`Nested ${picked.length} row${picked.length === 1 ? '' : 's'} under “${title}”.`);
    ctx.rerender();
  };

  const body = h('div',
    h('h2', `Nest ${picked.length} row${picked.length === 1 ? '' : 's'} under…`),
    h('p.hint', 'The rows being moved, and anything already nested under them, are not offered — '
      + 'a row cannot become its own ancestor.'),
    rowPicker({
      texts, value: null, banned,
      placeholder: 'Type to find a parent…',
      onChange: (id) => { choice = id; status.textContent = ''; status.className = 'hint'; },
    }),
    status,
    h('div.actions',
      h('button.primary', { type: 'button', onclick: apply }, 'Nest them'),
      h('button', { type: 'button', onclick: () => dlg.destroy() }, 'Cancel')));
  const dlg = openBareDialog(body);
  return dlg;
}

/**
 * A dialog without importing the whole dialogs module, which would be circular:
 * dialogs.js already imports from the model and the lookup, and the queue is
 * what dialogs.js opens onto.
 */
function openBareDialog(...content) {
  const dlg = h('dialog.modal', h('div.modal-body', content));
  dlg.destroy = () => {
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
    document.dispatchEvent(new CustomEvent('modal-closed'));
  };
  document.body.append(dlg);
  dlg.addEventListener('cancel', () => setTimeout(() => dlg.destroy(), 0));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.destroy(); });
  dlg.showModal();
  const first = dlg.querySelector('input, textarea, select, button');
  if (first) first.focus();
  return dlg;
}

/**
 * Subjects as a select rather than a button per subject: the bar is already
 * crowded, and the list grows as subjects are added. Selecting acts at once and
 * snaps back, because there is nothing to "confirm" — the action is the choice.
 */
function subjectAdder(picked, doc, ctx) {
  const subjects = doc.subjects || [];
  if (!subjects.length) return null;
  const sel = h('select.small', { 'aria-label': 'Add the selected rows to a subject' },
    h('option', { value: '' }, 'Add to subject…'),
    subjects.map(sub => h('option', { value: sub.id }, sub.name)));
  sel.onchange = (e) => {
    const id = e.target.value;
    e.target.value = '';
    if (!id) return;
    const ids = new Set(picked.map(t => t.id));
    let added = 0;
    mutate(d => {
      for (const row of d.texts) {
        if (!ids.has(row.id)) continue;
        const cur = row.subject_ids || [];
        if (cur.includes(id)) continue;
        row.subject_ids = [...cur, id];
        added++;
      }
    });
    const name = (subjects.find(x => x.id === id) || {}).name || 'the subject';
    ctx.toast(added
      ? `Added ${added} row${added === 1 ? '' : 's'} to ${name}`
        + (added < picked.length ? `; ${picked.length - added} were already on it.` : '.')
      : `All ${picked.length} were already on ${name}.`);
  };
  return sel;
}

/**
 * The pool is the read corpus an evaluation is handed as context, so only rows
 * that are actually eligible can go in — a queued row has nothing to say about
 * what reading was worth. Ineligible selections are reported, not silently
 * dropped.
 */
function poolButtons(picked, ctx) {
  const eligible = picked.filter(poolEligible);
  const addable = eligible.filter(t => !inPool(t));
  const removable = picked.filter(t => inPool(t));
  const set = (rows, on, verb) => {
    const ids = new Set(rows.map(t => t.id));
    mutate(d => {
      for (const row of d.texts) {
        if (!ids.has(row.id)) continue;
        if (on) row.in_pool = true; else delete row.in_pool;
      }
    });
    ctx.toast(`${verb} ${rows.length} row${rows.length === 1 ? '' : 's'}`
      + (picked.length - rows.length
        ? `; left ${picked.length - rows.length} alone.`
        : '.'));
  };
  return [
    addable.length
      ? h('button.small', {
        type: 'button', title: 'Add the eligible read rows to the comparison pool',
        onclick: () => set(addable, true, 'Added to the pool:'),
      }, `Pool +${addable.length}`)
      : null,
    removable.length
      ? h('button.small', {
        type: 'button', title: 'Take these out of the comparison pool',
        onclick: () => set(removable, false, 'Removed from the pool:'),
      }, `Pool −${removable.length}`)
      : null,
  ];
}

function selectionBar(ordered, picked, byId, children, texts, doc, ctx) {
  const all = picked.length === ordered.length && ordered.length > 0;
  const master = h('input', {
    type: 'checkbox', checked: all,
    'aria-label': `Select all ${ordered.length} shown`,
    onchange: (e) => {
      selected.clear();
      if (e.target.checked) for (const t of ordered) selected.add(t.id);
      ctx.rerender();
    },
  });
  // Neither on nor off when the selection is a subset — the tri-state is the
  // only honest rendering of "some".
  master.indeterminate = picked.length > 0 && !all;

  if (!picked.length) {
    return h('div.bulk-bar.quiet',
      h('label.check', master, h('span', `Select all ${ordered.length} shown`)),
      h('span.hint.dim', 'Or press ', h('kbd', 'x'), ' on a focused row.'));
  }

  const act = (label, title, spec) =>
    h('button.small', { type: 'button', title, onclick: () => applyToPicked(picked, spec, ctx) }, label);

  const n = picked.length;
  return h('div.bulk-bar',
    h('label.check', master, h('span.strong', `${n} selected`)),
    h('span.bulk-actions',
      act('Start', 'Move queued rows to reading and stamp today as the start date', {
        did: 'Started', verb: 'start', fits: t => t.status === 'queued',
        change: (r) => { r.status = 'reading'; if (!r.date_started) r.date_started = todayISO(); },
      }),
      act('Finish', 'Move reading rows to read and stamp today as the finish date', {
        did: 'Finished', verb: 'finish', fits: t => t.status === 'reading' || t.status === 'queued',
        change: (r) => {
          r.status = 'read';
          if (!r.date_finished) r.date_finished = todayISO();
        },
      }),
      act('Back to queue', 'Return to queued', {
        did: 'Requeued', verb: 'requeue', fits: t => t.status !== 'queued',
        change: (r) => { r.status = 'queued'; },
      }),
      act('Good', 'Mark read rows good — the hours paid', {
        did: 'Marked good', verb: 'mark good', fits: t => t.status === 'read' || t.status === 'abandoned',
        change: (r) => { r.assessment = 'good'; },
      }),
      act('Bad', 'Mark read rows bad', {
        did: 'Marked bad', verb: 'mark bad', fits: t => t.status === 'read' || t.status === 'abandoned',
        change: (r) => { r.assessment = 'bad'; },
      }),
      act('Unmark', 'Clear the good/bad mark — back to not evaluated', {
        did: 'Unmarked', verb: 'unmark', fits: t => !!t.assessment,
        change: (r) => { delete r.assessment; },
      }),
      act('Un-nest', 'Detach from the parent, leaving each row at the top level', {
        did: 'Un-nested', verb: 'un-nest', fits: t => !!t.parent_id || !!t.container,
        change: (r) => { r.parent_id = null; r.container = null; },
      }),
      h('button.small', {
        type: 'button', title: 'Move all of these under one parent row',
        onclick: () => nestPicked(picked, texts, children, ctx),
      }, 'Nest under…'),
      subjectAdder(picked, doc, ctx),
      poolButtons(picked, ctx),
      h('button.small.danger', {
        type: 'button', title: 'Delete these rows and every reference to them',
        onclick: () => deletePicked(picked, byId, children, ctx),
      }, 'Delete'),
      h('button.small', { type: 'button', onclick: () => { selected.clear(); ctx.rerender(); } },
        'Clear'),
    ),
  );
}

// ── filtering ───────────────────────────────────────────────────────

function matches(t, f, byId) {
  // A restriction, not part of the status union: it narrows whatever statuses
  // are showing rather than adding to them.
  if (f.rereadOnly && !t.reread_wanted) return false;
  if (f.type && t.type !== f.type) return false;
  if (f.project && !(t.project_ids || []).includes(f.project)) return false;
  if (f.subject && !(t.subject_ids || []).includes(f.subject)) return false;
  if (f.familiarity !== '' && f.familiarity != null && String(t.familiarity ?? '') !== String(f.familiarity)) return false;
  if (f.q) {
    const hay = [
      t.title,
      (t.authors || []).join(' '),
      t.container,
      containerName(t, byId),
      t.journal,
      (t.shelves || []).join(' '),
      (t.import || {}).raw_title,
      (t.import || {}).also_known_as,
      t.year,
    ].filter(Boolean).join(' ');
    if (!matchesQuery(hay, f.q)) return false;
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
        const aa = authorLine(a), bb = authorLine(b);
        if (!aa && !bb) return titleCmp(a, b);
        if (!aa) return 1;                       // rows with no author sort last
        if (!bb) return -1;
        return fold(aa).localeCompare(fold(bb)) || titleCmp(a, b);
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
  /**
   * The chosen sort decides where a group sits on the page; inside a group,
   * a book that has a reading order is shown in it. Nobody reads chapter 7
   * before chapter 3 because it scored higher, and the two orderings were
   * never really in competition — they answer different questions.
   *
   * Top level is left alone: that is what the sort dropdown is for. This only
   * runs when nesting is on, because the forest is only built then.
   */
  const orderKey = (n) => {
    const o = n.row ? orderOf(n.row) : null;
    return o == null ? [1, 0, n.rank] : [0, o, n.rank];
  };
  const sortTree = (list, depth = 0) => {
    if (depth > MAX_DEPTH) return list;
    if (depth > 0 && list.some(n => n.row && orderOf(n.row) != null)) {
      // A composite key rather than a chain of tests: mixing numbered chapters
      // with unnumbered front matter pairwise is exactly the non-transitive
      // comparator that scrambled the importer's own list.
      list.sort((a, b) => {
        const ka = orderKey(a); const kb = orderKey(b);
        return (ka[0] - kb[0]) || (ka[1] - kb[1]) || (ka[2] - kb[2]);
      });
    } else {
      list.sort((a, b) => a.rank - b.rank);
    }
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

/**
 * Drag a row onto another to nest it there; drop it on the zone above the list
 * to bring it back to the top level.
 *
 * Dragging is a pointer gesture: no keyboard can perform it, and HTML5 drag and
 * drop does not fire on touch at all. So this is an accelerator, never the only
 * route — the parent picker on the detail view does the same job, and is the one
 * that works on a phone.
 */
function makeDraggable(el, t, drag) {
  if (!drag || !drag.enabled) return el;
  el.draggable = true;

  // An <a href> is draggable by default, and the title link is the obvious
  // place to grab a row. Without this the browser starts a *link* drag from
  // the anchor instead of a row drag, which looks exactly like "dragging does
  // not work". Opting the anchor out lets the row's own draggable win; the
  // link still clicks normally.
  el.querySelectorAll('a').forEach(a => { a.draggable = false; });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', t.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
    document.body.classList.add('row-dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.body.classList.remove('row-dragging');
    document.querySelectorAll('.drop-into').forEach(n => n.classList.remove('drop-into'));
  });

  const wouldCycle = (draggedId) =>
    draggedId === t.id || descendantIds(draggedId, drag.children).has(t.id);

  el.addEventListener('dragover', (e) => {
    const id = dragPayload(e);
    if (!id || wouldCycle(id)) return;   // no preventDefault => cursor shows "not allowed"
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-into');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-into'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-into');
    const id = e.dataTransfer.getData('text/plain');
    if (!id || wouldCycle(id)) return;
    mutate(d => {
      const row = d.texts.find(x => x.id === id);
      if (!row) return;
      row.parent_id = t.id;
      // A linked parent wins over the free-text one, so stale text would only
      // ever be confusing. See the note on `container` in the data model.
      if (row.container) row.container = null;
    });
  });
  return el;
}

/**
 * During a drag the payload is unreadable in dragover on most engines, so the
 * id is stashed alongside. It is only used to reject invalid targets early.
 */
let draggingId = null;
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest && e.target.closest('.row');
  draggingId = el ? el.dataset.id : null;
});
document.addEventListener('dragend', () => { draggingId = null; });
function dragPayload() { return draggingId; }

function unnestZone() {
  const zone = h('div.unnest-zone', 'Drop here to move a row back to the top level');
  zone.addEventListener('dragover', (e) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('drop-into');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop-into'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drop-into');
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    mutate(d => {
      const row = d.texts.find(x => x.id === id);
      if (row) { row.parent_id = null; row.container = null; }
    });
  });
  return zone;
}

function row(t, { cols, prefs, byId, children, drag, ctx, sel }, depth = 0, childCount = 0) {
  const s = scores(t);
  const p = priority(t, prefs.w, prefs.alpha);
  const author = authorLine(t);
  const blocked = unreadPrerequisites(t, byId);
  const cont = depth === 0 ? containerName(t, byId) : null;

  const finished = t.status === 'read' || t.status === 'abandoned';
  const meta = [author, t.year || null, t.journal || null,
    t.type !== 'article' ? t.type : null].filter(Boolean);

  const box = sel
    ? h('label.row-select', {
      title: 'Select for a bulk action',
      // A checkbox inside a draggable row: without this, pressing it starts a
      // row drag instead of ticking the box.
      onmousedown: e => e.stopPropagation(),
      onclick: e => e.stopPropagation(),
    },
      h('input', {
        type: 'checkbox', checked: sel.has(t.id), draggable: false,
        'aria-label': `Select ${t.title || 'untitled'}`,
        onchange: e => sel.toggle(t.id, e.target.checked),
      }))
    : null;

  return makeDraggable(h(`div.row${sel && sel.has(t.id) ? '.picked' : ''}`, { dataset: { id: t.id } },
    box,
    drag && drag.enabled
      ? h('span.drag-handle', { 'aria-hidden': 'true', title: 'Drag onto another row to nest it' }, '\u283F')
      : null,
    // The id is what lets app.js restore focus across the re-render that every
    // edit triggers. Without it, marking a row with the keyboard drops focus and
    // the next `j` jumps back to the top of the list — which defeats running
    // down the read list marking as you go.
    h('a.row-main', { id: `row-${t.id}`, href: `#/text/${encodeURIComponent(t.id)}` },
      h('span.title', t.title || '(untitled)'),
      meta.length ? h('span.meta', meta.join(' · ')) : null,
      cont ? h('span.container-of', 'in ', h('em', cont)) : null,
      childCount ? h('span.container-of', `${childCount} inside`) : null,
    ),
    h('div.row-tags',
      rowActions(t, ctx),
      t.status === 'reading' ? h('span.tag.reading', 'Reading') : null,
      t.status === 'read' ? h('span.tag.read', 'Read') : null,
      t.status === 'abandoned' ? h('span.tag.abandoned', 'Abandoned') : null,
      finished ? flagToggles(t) : [
        t.reread_wanted ? h('span.tag', 'Reread wanted') : null,
        t.notes_written ? h('span.tag.soft', 'Notes') : null,
        t.carded ? h('span.tag.soft', 'Cards') : null,
      ],
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
  ), t, drag);
}

/**
 * The good/bad mark, inline (spec §4).
 *
 * It lives here and not only on the detail view because the marks are the one
 * input an outside evaluation cannot get anywhere else, and they only get made
 * if making one costs a single click from the list. Sparse: clearing removes the
 * key rather than storing `false`, because absence is a real third state —
 * "not evaluated", never "average".
 */
export function setAssessment(id, value) {
  mutate(d => {
    const row = d.texts.find(x => x.id === id);
    if (!row) return;
    if (value) row.assessment = value;
    else delete row.assessment;
  });
}

/**
 * One action slot per row, whose content follows the status: advance while a
 * text is in flight, mark it once it has landed. They never both apply, so the
 * row gains a control rather than a cluster.
 */
function rowActions(t, ctx) {
  if (t.status === 'queued') {
    return h('span.mark-control',
      h('button.mark.act', {
        type: 'button', title: 'Move to reading, and record today as the start date',
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          mutate(d => {
            const row = d.texts.find(x => x.id === t.id);
            row.status = 'reading';
            if (!row.date_started) row.date_started = todayISO();
          });
        },
      }, 'Start'));
  }
  if (t.status === 'reading') {
    return h('span.mark-control',
      h('button.mark.act', {
        type: 'button', title: 'Move to read, and record today as the finish date',
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          mutate(d => {
            const row = d.texts.find(x => x.id === t.id);
            row.status = 'read';
            if (!row.date_finished) row.date_finished = todayISO();
            if (!row.date_started) row.date_started = todayISO();
          });
          ctx.toast(`Finished “${(t.title || '').slice(0, 40)}”. Tick Read above to mark it good or bad.`);
        },
      }, 'Finish'));
  }
  return markControl(t);
}

/**
 * The three post-reading flags, toggled from the list.
 *
 * §3 insists these are independent booleans and not stages — a text can be
 * carded without notes — so they are three separate toggles rather than a
 * sequence. They only appear once a text is finished, because that is when
 * there is anything to have written or carded.
 */
function flagToggles(t) {
  const toggle = (key, label, title) =>
    h(`button.mark.flag${t[key] ? '.on' : ''}`, {
      type: 'button', title,
      'aria-pressed': t[key] ? 'true' : 'false',
      onclick: (e) => {
        e.preventDefault(); e.stopPropagation();
        mutate(d => {
          const row = d.texts.find(x => x.id === t.id);
          if (row[key]) delete row[key];
          else row[key] = true;
        });
      },
    }, label);
  return [
    toggle('notes_written', 'Notes', 'Notes written on this'),
    toggle('carded', 'Cards', 'Flashcards made from this'),
    toggle('reread_wanted', 'Reread', 'Worth returning to — see spec §4.5'),
  ];
}

function markControl(t) {
  if (t.status !== 'read' && t.status !== 'abandoned') return null;
  const btn = (value, label, title) =>
    h(`button.mark${t.assessment === value ? '.on' : ''}`, {
      type: 'button',
      title,
      'aria-pressed': t.assessment === value ? 'true' : 'false',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        setAssessment(t.id, t.assessment === value ? null : value);
      },
    }, label);
  return h('span.mark-control',
    btn('good', 'Good', 'Worth the hours — you would have regretted missing it. Not whether you enjoyed it.'),
    btn('bad', 'Bad', 'The hours did not pay.'));
}

function num(v, cls) {
  return h(`span.n.tabular${cls ? '.' + cls : ''}`, v === '' || v == null ? h('span.absent', '·') : v);
}

function fmt1(v) { return v == null ? '' : Number(v).toFixed(1); }

/**
 * 1 / 2 / 0 mark the focused row, so a pass down the read list with j and k
 * never needs the mouse. Numeric keys to match Backfill's accept keys.
 */
export function queueKeys(e, ctx) {
  if (!'120x'.includes(e.key)) return false;
  const el = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('.row')
    : null;
  if (!el || !el.dataset.id) return false;
  if (e.key === 'x') {
    e.preventDefault();
    const id = el.dataset.id;
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    ctx.rerender();
    return true;
  }
  const t = (state.doc.texts || []).find(x => x.id === el.dataset.id);
  if (!t || (t.status !== 'read' && t.status !== 'abandoned')) return false;
  e.preventDefault();
  setAssessment(t.id, e.key === '1' ? 'good' : e.key === '2' ? 'bad' : null);
  ctx.rerender();
  return true;
}

// ── chrome ──────────────────────────────────────────────────────────

function controls(prefs, statuses, doc, ctx) {
  const f = prefs.filters;
  const setF = patch => savePrefs({ filters: { ...f, ...patch } });
  const projects = doc.projects || [];
  const texts = doc.texts || [];
  const types = [...new Set(texts.map(t => t.type))].sort();

  const toggleStatus = (key, on) => {
    const next = on
      ? [...new Set([...statuses, key])]
      : statuses.filter(x => x !== key);
    setF({ statuses: next, status: undefined });
  };

  const statusBoxes = h('fieldset.status-filter',
    h('legend.sr-only', 'Statuses to show'),
    STATUS_FILTERS.map(([key, label]) => {
      const n = texts.filter(t => t.status === key).length;
      return h('label.check',
        h('input', {
          type: 'checkbox', checked: statuses.includes(key),
          onchange: e => toggleStatus(key, e.target.checked),
        }),
        h('span', label),
        h('span.dim.tabular', ` ${n}`));
    }));

  return h('div.controls',
    statusBoxes,
    h('input.search', {
      type: 'search', id: 'q', placeholder: 'Search title, author, parent…',
      value: f.q, 'aria-label': 'Search',
      oninput: e => setF({ q: e.target.value }),
    }),
    select('Sort', prefs.sort, Object.entries(SORTS), v => savePrefs({ sort: v })),
    types.length > 1
      ? select('Type', f.type, [['', 'Any type'], ...types.map(t => [t, t])], v => setF({ type: v }))
      : null,
    projects.length
      ? select('Project', f.project, [['', 'Any project'], ...projects.map(p => [p.id, p.title])],
        v => setF({ project: v }))
      : null,
    (doc.subjects || []).length
      ? select('Subject', f.subject, [['', 'Any subject'], ...doc.subjects.map(x => [x.id, x.name])],
        v => setF({ subject: v }))
      : null,
    h('label.check',
      h('input', {
        type: 'checkbox', checked: prefs.group !== false,
        onchange: e => savePrefs({ group: e.target.checked }),
      }),
      h('span', 'Nest under parents')),
    (() => {
      const n = texts.filter(t => t.reread_wanted).length;
      return h('label.check', { title: 'Only texts flagged as worth returning to' },
        h('input', {
          type: 'checkbox', checked: !!f.rereadOnly,
          onchange: e => setF({ rereadOnly: e.target.checked }),
        }),
        h('span', 'Reread wanted'),
        h('span.dim.tabular', ` ${n}`));
    })(),
    (f.q || f.type || f.project || f.subject || f.familiarity !== '' || f.rereadOnly)
      ? h('button.link', {
        onclick: () => setF({ q: '', type: '', project: '', subject: '', familiarity: '', rereadOnly: false }),
      }, 'Clear filters')
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
    slider('Cost exponent', 'alpha', prefs.alpha, 0, 1.5, 0.05, alphaLabel),
  );
}

/**
 * A bare exponent means nothing to read off a slider. What alpha actually
 * controls is the exchange rate between hours and value: at alpha, a text that
 * takes twice as long has to be 2^alpha times as valuable to rank equally.
 * That number is the intuitive one, so show it.
 */
export function alphaLabel(a) {
  const x = Math.pow(2, a);
  if (a === 0) return 'alpha 0 · cost ignored entirely';
  return `alpha ${a.toFixed(2)} · twice the hours needs ${x.toFixed(2)}x the value`;
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

function emptyState(f, statuses, total, ctx) {
  if (!statuses.length) {
    return h('div.empty',
      h('p', 'No statuses are selected, so nothing can show. Tick at least one above.'),
      h('button', {
        onclick: () => savePrefs({ filters: { ...f, statuses: DEFAULT_STATUSES } }),
      }, 'Show queued and reading'));
  }
  const filtering = f.q || f.type || f.project || f.subject || f.familiarity !== '' || f.rereadOnly;
  if (filtering && total) {
    return h('div.empty',
      h('p', `Nothing matches. ${total} ${statuses.join(' / ')} texts are hidden by the current filters.`),
      h('button', {
        onclick: () => savePrefs({ filters: { ...f, q: '', type: '', project: '', subject: '', familiarity: '', rereadOnly: false } }),
      }, 'Clear filters'));
  }
  return h('div.empty',
    h('p', `Nothing ${statuses.join(' or ')} yet.`),
    h('div.empty-actions',
      h('button', { onclick: () => ctx.newText() }, 'Add a text to the queue'),
      h('button', { onclick: () => ctx.quickLog() }, 'Log something you already read')));
}
