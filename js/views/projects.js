// Projects (spec §5.7, phase 4). Open questions with provenance.
//
// WHY THIS VIEW EXISTS AT ALL. `value_rel` — half the scoring axis — asks how
// much a text serves what you are working on now, and the evaluation export
// answers that from `project.summary` and the open questions. Until this view
// existed those were hand-written into data.json, so in practice there was one
// project and the relative axis was judged against it or against nothing.
//
// The summary is therefore not decoration. It is the only description of the
// work an outside evaluator ever sees, and a project without one makes
// `value_rel` unanswerable — which is why the export says so in as many words
// rather than quietly returning null.

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import {
  authorLine, sortKeyTitle, slugify, uniqueId, nextSubItemId, STATUS_LABEL,
} from '../model.js';
import { rowPicker } from './row-picker.js';

const STATUSES = ['planned', 'drafting', 'revising', 'submitted', 'done', 'shelved'];

function editProject(id, fn) {
  mutate(d => {
    const p = (d.projects || []).find(x => x.id === id);
    if (p) fn(p);
  });
}

/** Both directions of the link, kept together so they cannot drift apart. */
function attach(projectId, textId) {
  mutate(d => {
    const p = (d.projects || []).find(x => x.id === projectId);
    const row = d.texts.find(x => x.id === textId);
    if (!p || !row) return;
    p.text_ids = [...new Set([...(p.text_ids || []), textId])];
    row.project_ids = [...new Set([...(row.project_ids || []), projectId])];
  });
}
function detach(projectId, textId) {
  mutate(d => {
    const p = (d.projects || []).find(x => x.id === projectId);
    const row = d.texts.find(x => x.id === textId);
    if (p) p.text_ids = (p.text_ids || []).filter(x => x !== textId);
    if (row) row.project_ids = (row.project_ids || []).filter(x => x !== projectId);
    // A question can cite a text it no longer has; drop those too rather than
    // leaving a citation that resolves to nothing.
    for (const q of (p && p.questions) || []) {
      q.text_ids = (q.text_ids || []).filter(x => x !== textId);
    }
  });
}

/** Texts linked either way round, so a half-written link still shows up. */
function textsFor(p, texts) {
  const ids = new Set(p.text_ids || []);
  return texts.filter(t => ids.has(t.id) || (t.project_ids || []).includes(p.id));
}

// ── list ────────────────────────────────────────────────────────────

export function renderProjects(root, ctx) {
  const doc = state.doc;
  const projects = doc.projects || [];
  const texts = doc.texts || [];

  mount(root,
    h('header.view-head',
      h('h1', 'Projects'),
      h('p.counts', projects.length
        ? `${projects.length} project${projects.length === 1 ? '' : 's'} · `
          + `${projects.reduce((n, p) => n + openQuestions(p).length, 0)} open questions`
        : 'none yet'),
    ),
    h('p.notice.quiet',
      'Relative value is judged against these. A project with no summary cannot be scored '
      + 'against at all — the evaluation is told so rather than left to guess.'),
    h('div.actions',
      h('button.primary', { onclick: () => addProject(ctx) }, 'New project')),
    projects.length
      ? h('div.project-list', projects.map(p => projectCard(p, texts)))
      : h('div.empty', h('p', 'No projects yet. Relative value comes back null for every row until there is one.')),
  );
}

function openQuestions(p) {
  return (p.questions || []).filter(q => q.status !== 'resolved');
}

function projectCard(p, texts) {
  const open = openQuestions(p);
  const linked = textsFor(p, texts);
  const unread = linked.filter(t => t.status === 'queued' || t.status === 'reading').length;
  return h('a.card.project-card', { href: `#/project/${encodeURIComponent(p.id)}` },
    h('div.card-head',
      h('h2', p.title || '(untitled)'),
      h('span.tag.soft', p.status || 'planned')),
    (p.summary || '').trim()
      ? h('p.project-summary', truncate(p.summary, 220))
      : h('p.hint.warn', 'No summary — relative value cannot be judged for this project.'),
    h('p.dim.small',
      `${open.length} open question${open.length === 1 ? '' : 's'} · `
      + `${linked.length} text${linked.length === 1 ? '' : 's'}`
      + (unread ? `, ${unread} still to read` : '')),
  );
}

function truncate(s, n) {
  const t = String(s).trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function addProject(ctx) {
  const title = prompt('Project title');
  if (!title || !title.trim()) return;
  const id = uniqueId(slugify(title), new Set((state.doc.projects || []).map(p => p.id)));
  mutate(d => {
    d.projects = d.projects || [];
    d.projects.push({
      id, title: title.trim(), status: 'planned', summary: '',
      questions: [], text_ids: [],
    });
  });
  ctx.go(`#/project/${encodeURIComponent(id)}`);
}

// ── detail ──────────────────────────────────────────────────────────

export function renderProjectDetail(root, ctx, id) {
  const doc = state.doc;
  const p = (doc.projects || []).find(x => x.id === id);
  if (!p) {
    mount(root, h('div.empty',
      h('p', `No project with id “${id}”.`),
      h('a.button', { href: '#/projects' }, 'Back to projects')));
    return;
  }
  const texts = doc.texts || [];
  const set = (patch) => { editProject(id, x => Object.assign(x, patch)); ctx.rerender(); };

  mount(root,
    h('p.crumb', h('a', { href: '#/projects' }, '← Projects')),
    h('header.view-head',
      h('h1', p.title || '(untitled)'),
      h('p.counts', `${openQuestions(p).length} open · ${textsFor(p, texts).length} texts`)),

    h('section.card',
      h('h2', 'What it is'),
      h('div.fields',
        h('div.field.wide',
          h('label', { for: 'p-title' }, 'Title'),
          h('input#p-title', {
            type: 'text', value: p.title || '',
            onchange: e => set({ title: e.target.value.trim() }),
          })),
        h('div.field',
          h('label', { for: 'p-status' }, 'Status'),
          h('select#p-status', {
            onchange: e => set({ status: e.target.value }),
          }, STATUSES.map(s => h('option', { value: s, selected: (p.status || 'planned') === s }, s)))),
        h('div.field.wide',
          h('label', { for: 'p-summary' }, 'Summary'),
          h('textarea#p-summary', {
            rows: 6,
            placeholder: 'What the project argues, and against what. This is what an evaluation reads.',
            value: p.summary || '',
            onchange: e => set({ summary: e.target.value.trim() }),
          }),
          (p.summary || '').trim()
            ? null
            : h('p.hint.warn', 'Without this, relative value comes back null for every row '
              + 'attached to this project.')))),

    questionsCard(p, texts, ctx),
    textsCard(p, texts, ctx),

    h('section.card',
      h('h2', 'Danger'),
      h('div.actions',
        h('button.danger', {
          onclick: () => {
            const n = textsFor(p, texts).length;
            if (!confirm(`Delete “${p.title}”?\n\n${n} text${n === 1 ? '' : 's'} will be unlinked `
              + 'from it. The texts themselves are not deleted.')) return;
            mutate(d => {
              d.projects = (d.projects || []).filter(x => x.id !== id);
              for (const row of d.texts) {
                if ((row.project_ids || []).includes(id)) {
                  row.project_ids = row.project_ids.filter(x => x !== id);
                }
              }
            });
            ctx.go('#/projects');
          },
        }, 'Delete project'))),
  );
}

// ── questions ───────────────────────────────────────────────────────

/**
 * Provenance is the point of the field: an open question that does not say
 * where it came from is indistinguishable a term later from one you invented
 * while tidying, and the two are worth very different amounts.
 */
function questionsCard(p, texts, ctx) {
  const qs = p.questions || [];
  const open = qs.filter(q => q.status !== 'resolved');
  const resolved = qs.filter(q => q.status === 'resolved');
  const byId = new Map(texts.map(t => [t.id, t]));

  return h('section.card',
    h('div.card-head',
      h('h2', `Open questions — ${open.length}`),
      h('button.small', { onclick: () => addQuestion(p.id, ctx) }, 'Add a question')),
    open.length
      ? h('ul.q-list', open.map(q => questionRow(p, q, texts, byId, ctx)))
      : h('p.hint.dim', 'None open.'),
    resolved.length
      ? h('details.q-resolved',
        h('summary.small', `${resolved.length} resolved`),
        h('ul.q-list', resolved.map(q => questionRow(p, q, texts, byId, ctx))))
      : null,
  );
}

function editQuestion(projectId, qid, fn, ctx) {
  editProject(projectId, p => {
    const q = (p.questions || []).find(x => x.id === qid);
    if (q) fn(q);
  });
  if (ctx) ctx.rerender();
}

function questionRow(p, q, texts, byId, ctx) {
  const cited = (q.text_ids || []).map(i => byId.get(i)).filter(Boolean);
  const isOpen = q.status !== 'resolved';
  return h(`li.q-item${isOpen ? '' : '.done'}`,
    h('div.field.wide',
      h('textarea', {
        rows: 2, value: q.text || '', placeholder: 'The question',
        onchange: e => editQuestion(p.id, q.id, x => { x.text = e.target.value.trim(); }),
      })),
    h('div.q-meta',
      h('label.q-prov',
        h('span', 'Where it came from'),
        h('input', {
          type: 'text', value: q.provenance || '',
          placeholder: 'e.g. raised by Millikan 1990 §3; supervisor, 12 Aug',
          onchange: e => editQuestion(p.id, q.id, x => { x.provenance = e.target.value.trim() || null; }),
        })),
      h('span.spacer'),
      h('button.small', {
        onclick: () => editQuestion(p.id, q.id, x => {
          x.status = isOpen ? 'resolved' : 'open';
        }, ctx),
      }, isOpen ? 'Resolve' : 'Reopen'),
      h('button.small.linkish', {
        onclick: () => {
          if (!confirm('Delete this question?')) return;
          editProject(p.id, x => { x.questions = (x.questions || []).filter(y => y.id !== q.id); });
          ctx.rerender();
        },
      }, 'Delete')),
    !isOpen
      ? h('div.field.wide',
        h('label', 'How it resolved'),
        h('textarea', {
          rows: 2, value: q.resolution || '', placeholder: 'What settled it.',
          onchange: e => editQuestion(p.id, q.id, x => { x.resolution = e.target.value.trim() || null; }),
        }))
      : null,
    cited.length
      ? h('ul.q-cites', cited.map(t => h('li',
        h('a', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title || '(untitled)'),
        h('button.link.small', {
          onclick: () => {
            editQuestion(p.id, q.id, x => { x.text_ids = (x.text_ids || []).filter(y => y !== t.id); }, ctx);
          },
        }, 'uncite'))))
      : null,
    h('div.field.wide',
      rowPicker({
        texts: textsFor(p, texts), value: null,
        banned: new Set(q.text_ids || []),
        placeholder: 'Cite one of the project’s texts…',
        onChange: (id) => {
          if (!id) return;
          editQuestion(p.id, q.id, x => { x.text_ids = [...new Set([...(x.text_ids || []), id])]; }, ctx);
        },
      })),
  );
}

function addQuestion(projectId, ctx) {
  editProject(projectId, p => {
    p.questions = p.questions || [];
    p.questions.push({
      id: nextSubItemId(p.questions, 'q'),
      text: '', status: 'open', provenance: null, resolution: null, text_ids: [],
    });
  });
  ctx.rerender();
}

// ── texts ───────────────────────────────────────────────────────────

function textsCard(p, texts, ctx) {
  const linked = textsFor(p, texts).sort((a, b) => sortKeyTitle(a).localeCompare(sortKeyTitle(b)));
  const attached = new Set(linked.map(t => t.id));
  const unread = linked.filter(t => t.status === 'queued' || t.status === 'reading');

  return h('section.card',
    h('div.card-head',
      h('h2', `Reading — ${linked.length}`),
      unread.length ? h('span.dim.small', `${unread.length} still to read`) : null),
    linked.length
      ? h('ul.child-list', linked.map(t => h('li',
        h('a', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title || '(untitled)'),
        h('span.dim', ` — ${[authorLine(t), STATUS_LABEL[t.status] || t.status].filter(Boolean).join(' · ')}`),
        h('button.link.small', {
          onclick: () => { detach(p.id, t.id); ctx.rerender(); },
        }, 'detach'))))
      : h('p.hint.dim', 'Nothing attached yet.'),
    h('div.field.wide',
      h('label', 'Attach a text'),
      rowPicker({
        texts, value: null, banned: attached, placeholder: 'Type a title…',
        onChange: (id) => { if (id) { attach(p.id, id); ctx.rerender(); } },
      })),
  );
}
