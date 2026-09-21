// Courses view: records with dated sessions, and syllabus import (see courses.js).

import { h, mount } from '../dom.js';
import { state, mutate, savePrefs } from '../store.js';
import { authorLine, STATUS_LABEL, byIdIndex, nextSubItemId } from '../model.js';
import { rowPicker } from './row-picker.js';
import {
  legacyCourseKeys, recordsFromTags, courseTextIds, buildSyllabusExport, parseSyllabus,
  applySyllabus, formatDay, nextSession, sortSessions,
} from '../courses.js';

let importOpen = false;
let exportText = '';
let pasteText = '';
let parsed = null;
let choices = new Map();

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
  const legacy = legacyCourseKeys(doc, dismissed());
  const upcoming = courses.filter(c => nextSession(c)).length;

  mount(root,
    h('header.view-head',
      h('h1', 'Courses'),
      h('p.counts', courses.length
        ? `${courses.length} course${courses.length === 1 ? '' : 's'}`
          + (upcoming ? ` · ${upcoming} with a session coming up` : '')
        : 'none recorded yet')),

    legacy.length ? h('div.notice.quiet.course-legacy',
      h('p', `${legacy.length} course${legacy.length === 1 ? '' : 's'} from your 2025–26 syllabi `
        + 'are tagged on readings but have no record: ', h('span.dim', legacy.join(', ')), '.'),
      h('div.actions',
        h('button.primary', {
          onclick: () => {
            mutate(d => { d.courses = [...(d.courses || []), ...recordsFromTags(d, legacy)]; });
            ctx.toast(`Created ${legacy.length} course records. Rename them as you like.`);
          },
        }, `Create ${legacy.length} records`),
        h('button', {
          onclick: () => savePrefs({ dismissedCourseKeys: [...dismissed(), ...legacy] }),
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
              choices = new Map(parsed.fresh.map(f => [f.key, f.match ? f.match.id : 'create']));
              ctx.rerender();
            },
          }, 'Check')))),
    parsed ? review(ctx) : null,
  );
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

  const toCreate = fresh.filter(f => choices.get(f.key) === 'create').length;
  const toLink = fresh.filter(f => { const c = choices.get(f.key); return c && c !== 'create' && c !== 'skip'; }).length;

  return h('div.review',
    h('p', existingCourse
      ? ['Adds to the existing course ', h('strong', existingCourse.name), '.']
      : ['New course: ', h('strong', course.name), [course.code, course.term].filter(Boolean).length ? ` (${[course.code, course.term].filter(Boolean).join(', ')})` : '', '.']),
    warnings.length ? h('ul.warnings', warnings.map(w => h('li', w))) : null,

    fresh.length ? h('div.fresh',
      h('h3', `${fresh.length} reading${fresh.length === 1 ? '' : 's'} not matched to your tracker`),
      h('p.hint', 'Created as queued coursework unless you change it. Where one looks like a text you already have, that text is chosen instead.'),
      h('ul.fresh-list', fresh.map(f => h('li',
        h('div.fresh-main',
          h('strong', f.title),
          h('span.dim.small', ` — ${[f.authors.join(', '), f.year, f.type !== 'article' ? f.type : null].filter(Boolean).join(' · ')}`),
          f.sessions > 1 ? h('span.dim.small', ` · in ${f.sessions} sessions`) : null),
        h('select', {
          'aria-label': `What to do with ${f.title}`,
          onchange: e => { choices.set(f.key, e.target.value); ctx.rerender(); },
        },
          h('option', { value: 'create', selected: choices.get(f.key) === 'create' }, 'Create it'),
          f.match ? h('option', { value: f.match.id, selected: choices.get(f.key) === f.match.id }, `Use existing: ${f.match.title}`) : null,
          h('option', { value: 'skip', selected: choices.get(f.key) === 'skip' }, 'Leave it out')))))) : null,

    h('div.sessions-preview',
      h('h3', `${sessions.length} session${sessions.length === 1 ? '' : 's'}`),
      h('ol', sessions.map(s => h('li',
        h('span.session-date.tabular', s.date ? formatDay(s.date) : 'no date'),
        h('span', ` ${s.label}`),
        h('ul.session-readings', s.items.map(it => {
          if (it.kind === 'existing') {
            const t = byId.get(it.id);
            return h('li', t.title, h('span.dim.small', ' — already tracked'), it.optional ? h('span.tag.soft', 'optional') : null);
          }
          const f = freshByKey.get(it.key);
          const c = choices.get(it.key);
          return h(`li${c === 'skip' ? '.skipped' : ''}`, f.title,
            h('span.dim.small', c === 'create' ? ' — new' : c === 'skip' ? ' — left out' : ' — existing'),
            it.optional ? h('span.tag.soft', 'optional') : null);
        })))))),

    h('div.actions',
      h('button.primary', {
        onclick: () => {
          let result = null;
          mutate(d => { result = applySyllabus(d, parsed, choices); });
          importOpen = false; parsed = null; pasteText = '';
          ctx.toast(`${result.isNew ? 'Created' : 'Updated'} the course: ${result.linked} readings linked`
            + (result.created ? `, ${result.created} new texts queued` : '') + '.');
          ctx.go(`#/course/${encodeURIComponent(result.courseId)}`);
        },
      }, `Apply — ${sessions.length} sessions${toCreate ? `, ${toCreate} new texts` : ''}${toLink ? `, ${toLink} matched` : ''}`)),
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
          if (texts.some(t => ((t.import || {}).courses || []).includes(id))) savePrefs({ dismissedCourseKeys: [...dismissed(), id] });
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
