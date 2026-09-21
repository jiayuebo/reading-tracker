// Courses view: records with dated sessions, and syllabus import (see courses.js).

import { h, mount } from '../dom.js';
import { state, mutate, savePrefs } from '../store.js';
import { authorLine, STATUS_LABEL, byIdIndex, nextSubItemId, TYPES } from '../model.js';
import { rowPicker } from './row-picker.js';
import { lookupPanel, lookupEnabled } from './lookup-ui.js';
import {
  courseCandidates, applyCandidates, courseTextIds, buildSyllabusExport, parseSyllabus,
  applySyllabus, formatDay, nextSession, sortSessions, autoMatch, fillFromCandidate, revertToAI,
} from '../courses.js';

let importOpen = false;
let exportText = '';
let pasteText = '';
let parsed = null;
// Lookup panels opened by hand, kept across re-renders: automatic lookups
// re-render as each result lands, and rebuilding an open panel would throw away
// whatever was typed into it.
let openLookups = new Set();
let panels = new Map();

function dismissed() {
  return state.prefs.dismissedCourseKeys || [];
}

function editCourse(id, fn) {
  mutate(d => {
    const c = (d.courses || []).find(x => x.id === id);
    if (c) fn(c);
  });
}

function editSession(courseId, sessionId, fn) {
  editCourse(courseId, c => {
    const s = (c.sessions || []).find(x => x.id === sessionId);
    if (s) fn(s, c);
  });
}

// ── list ────────────────────────────────────────────────────────────

export function renderCourses(root, ctx) {
  const doc = state.doc;
  const courses = doc.courses || [];
  const byId = byIdIndex(doc.texts || []);
  const legacy = courseCandidates(doc, dismissed());
  const upcoming = courses.filter(c => nextSession(c)).length;

  mount(root,
    h('header.view-head',
      h('h1', 'Courses'),
      h('p.counts', courses.length
        ? `${courses.length} course${courses.length === 1 ? '' : 's'}`
          + (upcoming ? ` · ${upcoming} with a session coming up` : '')
        : 'none recorded yet')),

    legacy.length ? h('div.notice.quiet.course-legacy',
      h('p', `${legacy.length} course${legacy.length === 1 ? ' is' : 's are'} implied by your readings `
        + 'but not recorded:'),
      h('ul', legacy.map(c => h('li',
        h('strong', c.name),
        h('span.dim', ` — ${c.text_ids.length} reading${c.text_ids.length === 1 ? '' : 's'}, `
          + (c.source === 'shelf'
            ? `from the shelf “${c.shelf}”, which is removed once the course exists`
            : 'from the 2025–26 syllabus tags'))))),
      h('div.actions',
        h('button.primary', {
          onclick: () => {
            mutate(d => { applyCandidates(d, legacy); });
            ctx.toast(`Created ${legacy.length} course record${legacy.length === 1 ? '' : 's'}. Rename as you like.`);
          },
        }, `Create ${legacy.length} record${legacy.length === 1 ? '' : 's'}`),
        h('button', {
          onclick: () => savePrefs({ dismissedCourseKeys: [...dismissed(), ...legacy.map(c => c.key)] }),
        }, 'Not now'))) : null,

    importCard(ctx),

    courses.length
      ? h('div.course-list', courses.map(c => courseCard(c, byId)))
      : h('div.empty', h('p', 'No courses yet. Import a syllabus above, or create the records from your existing readings.')),
  );
}

function courseCard(c, byId) {
  const ids = courseTextIds(c);
  const read = ids.filter(id => { const t = byId.get(id); return t && (t.status === 'read' || t.status === 'abandoned'); }).length;
  const next = nextSession(c);
  return h('a.card.course-card', { href: `#/course/${encodeURIComponent(c.id)}` },
    h('div.card-head',
      h('h2', c.name || c.id),
      h('span.dim.small', [c.code, c.term].filter(Boolean).join(' · '))),
    h('p.dim.small',
      `${(c.sessions || []).length} session${(c.sessions || []).length === 1 ? '' : 's'} · `
      + `${read} of ${ids.length} readings finished`,
      next ? ` · next: ${formatDay(next.date)}${next.label ? `, ${next.label}` : ''}` : ''));
}

// ── syllabus import ─────────────────────────────────────────────────

function importCard(ctx) {
  const doc = state.doc;
  if (!importOpen) {
    return h('div.actions',
      h('button', { onclick: () => { importOpen = true; exportText = buildSyllabusExport(doc); ctx.rerender(); } },
        'Import a syllabus'));
  }

  const exportBox = h('textarea.dump', { rows: 6, readonly: true, value: exportText });
  const paste = h('textarea.dump', {
    rows: 8, value: pasteText,
    placeholder: 'Paste the JSON the chat returned.',
    oninput: e => { pasteText = e.target.value; },
  });

  return h('section.card.syllabus-import',
    h('div.card-head',
      h('h2', 'Import a syllabus'),
      h('button.small.linkish', { onclick: () => { importOpen = false; parsed = null; pasteText = ''; ctx.rerender(); } }, 'Close')),
    h('ol.steps',
      h('li',
        h('p', 'Copy this prompt into a chat, paste the syllabus where it says, and send.'),
        exportBox,
        h('div.actions',
          h('button', {
            onclick: async () => {
              try { await navigator.clipboard.writeText(exportText); ctx.toast('Prompt copied.'); }
              catch { exportBox.select(); ctx.toast('Select-all and copy — the clipboard was blocked.'); }
            },
          }, 'Copy prompt'),
          h('span.dim.small', `${Math.round(exportText.length / 1000)} KB, including your ${(doc.texts || []).length} texts so it can match them.`))),
      h('li',
        h('p', 'Paste what comes back, and check it.'),
        paste,
        h('div.actions',
          h('button.primary', {
            onclick: () => {
              parsed = parseSyllabus(pasteText, state.doc);
              openLookups = new Set();
              panels = new Map();
              ctx.rerender();
              if (!parsed.errors.length && lookupEnabled()) runLookups(parsed, ctx);
            },
          }, 'Check')))),
    parsed ? review(ctx) : null,
  );
}

/**
 * Look up every new reading, two at a time. A result for an entry the
 * reader has already edited is not applied over their edit.
 */
async function runLookups(p, ctx, only = null) {
  const todo = (only || p.fresh).filter(f => f.include && !(f.useExisting && f.match));
  if (!todo.length) return;
  todo.forEach(f => { f.crossref = { status: 'looking' }; });
  ctx.rerender();
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++];
      const r = await autoMatch(f);
      if (parsed !== p) return;   // checked again, or applied, meanwhile
      if (r.status === 'matched' && !f.touched) {
        fillFromCandidate(f, r.candidate);
        f.crossref = { status: 'filled', source: r.candidate.source || 'Crossref', doi: r.candidate.doi || null };
      } else if (r.status === 'matched') {
        f.crossref = { status: 'unsure', reason: 'you edited it while it was being looked up' };
      } else {
        f.crossref = r;
      }
      ctx.rerender();
    }
  };
  // Two at a time: each lookup asks Crossref and OpenLibrary, and Crossref
  // started refusing requests in testing when pressed harder.
  await Promise.all([worker(), worker()]);
}

function lookupNote(f) {
  const c = f.crossref;
  if (!c) return null;
  const text = {
    looking: 'Looking it up…',
    filled: `Filled from ${c.source}${c.doi ? ` · DOI ${c.doi}` : ''}. Check it is the right work.`,
    picked: `Filled from your choice${c.doi ? ` · DOI ${c.doi}` : ''}.`,
    unsure: `Not filled — ${c.reason}. Look it up again to choose a record.`,
    none: 'No catalogue record found; it will be added as typed.',
    error: `Lookup failed: ${c.message}`,
    reverted: 'Back to the version the chat gave.',
  }[c.status];
  const cls = { unsure: '.warn', error: '.bad' }[c.status] || '';
  return text ? h(`p.hint${cls}`, text) : null;
}

/**
 * A reading that starts out matched to an existing text, or left out, is never
 * looked up at Check. Unticking either of those makes it a new text, and a new
 * text is looked up then — once.
 */
function lookUpIfNew(f, ctx) {
  if (!f.crossref && f.include && !(f.useExisting && f.match) && lookupEnabled()) {
    runLookups(parsed, ctx, [f]);
  }
}

function freshRow(f, i, ctx) {
  const id = k => `sy-${i}-${k}`;
  const using = f.include && f.useExisting && f.match;
  const edit = (k, parse) => (e) => { f[k] = parse(e.target.value); f.touched = true; ctx.rerender(); };
  const lookupOpen = openLookups.has(f.key);

  return h(`li.fresh-item${f.include ? '' : '.excluded'}`,
    h('div.fresh-head',
      h('label.check',
        h('input', { type: 'checkbox', checked: f.include, onchange: e => { f.include = e.target.checked; ctx.rerender(); lookUpIfNew(f, ctx); } }),
        h('span', 'Add')),
      h('strong.fresh-title', f.title),
      f.sessions > 1 ? h('span.dim.small', ` · in ${f.sessions} sessions`) : null),
    f.include && f.match ? h('label.check.fresh-existing',
      h('input', { type: 'checkbox', checked: !!f.useExisting, onchange: e => { f.useExisting = e.target.checked; ctx.rerender(); lookUpIfNew(f, ctx); } }),
      h('span', 'Use the text you already have: ', h('em', f.match.title),
        (f.match.authors || []).length ? ` — ${authorLine(f.match)}` : '')) : null,
    f.include && !using ? h('div.fresh-edit',
      h('div.bib-row',
        field('Title', h('input', { id: id('title'), type: 'text', value: f.title, onchange: edit('title', v => v.trim() || f.title) }), 5),
        field('Authors', h('input', {
          id: id('authors'), type: 'text', value: f.authors.join('; '), placeholder: 'Separated by semicolons',
          onchange: edit('authors', v => v.split(';').map(x => x.trim()).filter(Boolean)),
        }), 3),
        field('Year', h('input', { id: id('year'), type: 'number', value: f.year ?? '', onchange: edit('year', v => (v ? Number(v) : null)) }), 1),
        field('Type', h('select', { id: id('type'), onchange: edit('type', v => v) },
          TYPES.map(t => h('option', { value: t, selected: f.type === t }, t))), 2),
        field('Pages', h('input', { id: id('pages'), type: 'number', value: f.pages ?? '', onchange: edit('pages', v => (v ? Number(v) : null)) }), 1)),
      lookupNote(f),
      lookupEnabled() ? h('div.actions',
        h('button.small', {
          type: 'button',
          onclick: () => {
            if (lookupOpen) { openLookups.delete(f.key); panels.delete(f.key); } else openLookups.add(f.key);
            ctx.rerender();
          },
        }, lookupOpen ? 'Close lookup' : 'Look up again'),
        f.ai ? h('button.small.linkish', {
          type: 'button',
          onclick: () => { revertToAI(f); f.crossref = { status: 'reverted' }; ctx.rerender(); },
        }, 'Undo the lookup') : null) : null,
      lookupOpen ? panelFor(f, ctx) : null) : null);
}

function panelFor(f, ctx) {
  if (!panels.has(f.key)) {
    panels.set(f.key, lookupPanel((c) => {
      fillFromCandidate(f, c);
      f.crossref = { status: 'picked', doi: c.doi || null };
      openLookups.delete(f.key);
      panels.delete(f.key);
      ctx.rerender();
    }, { compareTo: f, initial: f.title }));
  }
  return panels.get(f.key);
}

function review(ctx) {
  const doc = state.doc;
  const byId = byIdIndex(doc.texts || []);
  const { course, sessions, fresh, errors, warnings, existingCourse } = parsed;
  const freshByKey = new Map(fresh.map(f => [f.key, f]));

  if (errors.length) {
    return h('div.review.bad',
      h('p', h('strong', 'Nothing can be applied yet.')),
      h('ul', errors.map(e => h('li', e))),
      warnings.length ? h('ul.dim', warnings.map(w => h('li', w))) : null);
  }

  const outcome = f => (!f.include ? 'skip' : (f.useExisting && f.match ? f.match.id : 'create'));
  const toCreate = fresh.filter(f => outcome(f) === 'create').length;
  const toLink = fresh.filter(f => !['create', 'skip'].includes(outcome(f))).length;
  const pending = fresh.filter(f => f.crossref && f.crossref.status === 'looking').length;

  return h('div.review',
    h('p', existingCourse
      ? ['Adds to the existing course ', h('strong', existingCourse.name), '.']
      : ['New course: ', h('strong', course.name), [course.code, course.term].filter(Boolean).length ? ` (${[course.code, course.term].filter(Boolean).join(', ')})` : '', '.']),
    warnings.length ? h('ul.warnings', warnings.map(w => h('li', w))) : null,

    fresh.length ? h('div.fresh',
      h('h3', `${fresh.length} reading${fresh.length === 1 ? '' : 's'} not matched to your tracker`),
      h('p.hint', 'Ticked ones are added as queued coursework. Every field can be corrected here; nothing is saved until you apply.'),
      h('ol.fresh-list', fresh.map((f, i) => freshRow(f, i, ctx)))) : null,

    h('div.sessions-preview',
      h('h3', `${sessions.length} session${sessions.length === 1 ? '' : 's'}`),
      h('ol.session-list', sessions.map((s, si) => h('li.session',
        h('div.session-head',
          h('input', {
            id: `sy-s${si}-date`, type: 'date', value: s.date || '', 'aria-label': 'Session date',
            onchange: e => { s.date = e.target.value || null; ctx.rerender(); },
          }),
          h('input.session-label', {
            id: `sy-s${si}-label`, type: 'text', value: s.label, 'aria-label': 'Session label',
            onchange: e => { s.label = e.target.value.trim() || s.label; ctx.rerender(); },
          })),
        h('ul.session-readings', s.items.map((it) => {
          let title; let note;
          if (it.kind === 'existing') {
            title = byId.get(it.id).title; note = ' — already tracked';
          } else {
            const f = freshByKey.get(it.key);
            const o = outcome(f);
            title = o === 'create' || o === 'skip' ? f.title : f.match.title;
            note = o === 'create' ? ' — new' : o === 'skip' ? ' — left out' : ' — already tracked';
          }
          const skipped = note === ' — left out';
          return h(`li${skipped ? '.skipped' : ''}`, title, h('span.dim.small', note),
            skipped ? null : h('label.check.small.inline-opt',
              h('input', { type: 'checkbox', checked: !!it.optional, onchange: e => { it.optional = e.target.checked; } }),
              h('span', 'optional')));
        })))))),

    h('div.actions',
      h('button.primary', {
        onclick: () => {
          const choice = new Map(fresh.map(f => [f.key, outcome(f)]));
          let result = null;
          mutate(d => { result = applySyllabus(d, parsed, choice); });
          importOpen = false; parsed = null; pasteText = ''; openLookups = new Set(); panels = new Map();
          ctx.toast(`${result.isNew ? 'Created' : 'Updated'} the course: ${result.linked} readings linked`
            + (result.created ? `, ${result.created} new texts queued` : '') + '.');
          ctx.go(`#/course/${encodeURIComponent(result.courseId)}`);
        },
      }, `Apply — ${sessions.length} sessions${toCreate ? `, ${toCreate} new texts` : ''}${toLink ? `, ${toLink} matched` : ''}`),
      pending ? h('span.dim.small', `Still looking up ${pending}; applying now adds those as typed.`) : null),
  );
}

// ── detail ──────────────────────────────────────────────────────────

export function renderCourseDetail(root, ctx, id) {
  const doc = state.doc;
  const c = (doc.courses || []).find(x => x.id === id);
  if (!c) {
    mount(root, h('div.empty',
      h('p', `No course with id “${id}”.`),
      h('a.button', { href: '#/courses' }, 'Back to courses')));
    return;
  }
  const texts = doc.texts || [];
  const byId = byIdIndex(texts);
  const set = (patch) => { editCourse(id, x => Object.assign(x, patch)); ctx.rerender(); };
  const ids = courseTextIds(c);
  const read = ids.filter(i => { const t = byId.get(i); return t && (t.status === 'read' || t.status === 'abandoned'); }).length;

  mount(root,
    h('p.crumb', h('a', { href: '#/courses' }, '← Courses')),
    h('header.view-head',
      h('h1', c.name || c.id),
      h('p.counts', `${(c.sessions || []).length} sessions · ${read} of ${ids.length} readings finished`)),

    h('section.card',
      h('div.bib-row',
        field('Name', h('input', { type: 'text', value: c.name || '', onchange: e => set({ name: e.target.value.trim() }) }), 6),
        field('Code', h('input', { type: 'text', value: c.code || '', placeholder: 'PHIL 246', onchange: e => set({ code: e.target.value.trim() || null }) }), 3),
        field('Term', h('input', { type: 'text', value: c.term || '', placeholder: 'Fall 2026', onchange: e => set({ term: e.target.value.trim() || null }) }), 3))),

    h('section.card',
      h('div.card-head',
        h('h2', 'Sessions'),
        h('button.small', {
          onclick: () => {
            editCourse(id, x => { x.sessions = x.sessions || []; x.sessions.push({ id: nextSubItemId(x.sessions, 's'), date: null, label: '', text_ids: [], optional_ids: [] }); });
            ctx.rerender();
          },
        }, 'Add a session')),
      (c.sessions || []).length
        ? h('ol.session-list', (c.sessions || []).map(s => sessionRow(c, s, texts, byId, ctx)))
        : h('p.hint.dim', 'No sessions yet.')),

    h('section.card.danger',
      h('h2', 'Remove'),
      h('button.danger', {
        onclick: () => {
          if (!confirm(`Delete the course “${c.name}”?\n\nIts ${ids.length} readings stay in the tracker; only the course record and its dates go.`)) return;
          mutate(d => { d.courses = (d.courses || []).filter(x => x.id !== id); });
          // A course made from the 2025–26 tags would otherwise be offered again.
          savePrefs({ dismissedCourseKeys: [...new Set([...dismissed(), id])] });
          ctx.go('#/courses');
        },
      }, 'Delete this course')),
  );
}

function field(label, control, span) {
  control.id = control.id || `c-${label.toLowerCase()}`;
  return h(`div.grid-field.gf-${span}`, h('label', { for: control.id }, label), control);
}

function sessionRow(c, s, texts, byId, ctx) {
  const readings = (s.text_ids || []).map(i => byId.get(i)).filter(Boolean);
  const reorder = () => editCourse(c.id, x => { x.sessions = sortSessions(x.sessions || []); });
  return h('li.session',
    h('div.session-head',
      h('input', {
        type: 'date', value: s.date || '', 'aria-label': 'Session date',
        onchange: e => { editSession(c.id, s.id, x => { x.date = e.target.value || null; }); reorder(); ctx.rerender(); },
      }),
      h('input.session-label', {
        type: 'text', value: s.label || '', placeholder: 'What the session covers', 'aria-label': 'Session label',
        onchange: e => { editSession(c.id, s.id, x => { x.label = e.target.value.trim(); }); ctx.rerender(); },
      }),
      h('button.small.linkish', {
        onclick: () => {
          if (readings.length && !confirm(`Remove this session? Its ${readings.length} readings stay in the tracker.`)) return;
          editCourse(c.id, x => { x.sessions = (x.sessions || []).filter(y => y.id !== s.id); });
          ctx.rerender();
        },
      }, 'Remove')),
    readings.length ? h('ul.session-readings', readings.map(t => {
      const optional = (s.optional_ids || []).includes(t.id);
      return h('li',
        h('a', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title || '(untitled)'),
        h('span.dim.small', ` — ${[authorLine(t), STATUS_LABEL[t.status] || t.status].filter(Boolean).join(' · ')}`),
        h(`button.small.linkish${optional ? '.on' : ''}`, {
          title: optional ? 'Marked optional — click to make it required' : 'Mark as optional',
          onclick: () => {
            editSession(c.id, s.id, x => {
              const cur = x.optional_ids || [];
              x.optional_ids = cur.includes(t.id) ? cur.filter(y => y !== t.id) : [...cur, t.id];
            });
            ctx.rerender();
          },
        }, optional ? 'optional' : 'required'),
        h('button.small.linkish', {
          onclick: () => {
            editSession(c.id, s.id, x => {
              x.text_ids = (x.text_ids || []).filter(y => y !== t.id);
              x.optional_ids = (x.optional_ids || []).filter(y => y !== t.id);
            });
            ctx.rerender();
          },
        }, 'unlink'));
    })) : null,
    rowPicker({
      texts, value: null, banned: new Set(s.text_ids || []), placeholder: 'Add a reading…',
      onChange: (tid) => {
        if (!tid) return;
        editSession(c.id, s.id, x => { x.text_ids = [...new Set([...(x.text_ids || []), tid])]; });
        ctx.rerender();
      },
    }),
  );
}
