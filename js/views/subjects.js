// Subjects (spec §3, §5.6, phase 3).
//
// A subject is not a reading list, and the whole reason it is a separate entity
// is that reading cannot satisfy it: mastery of information theory is not "read
// Shannon" and is not measured in pages. So the two things this view refuses to
// do are the two that would quietly turn it back into a reading list — showing
// progress as a percentage bar, and inferring mastery from what has been read.
// Progress is a count, and mastery is asserted by the reader or not at all.

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import {
  MASTERY, masteryLabel, subjectProgress, textsForSubject, nextSubItemId,
  authorLine, sortKeyTitle, slugify, uniqueId, STATUS_LABEL,
} from '../model.js';
import { rowPicker } from './row-picker.js';

const RESOURCE_KINDS = ['exercise', 'lecture', 'writing', 'other'];

function editSubject(id, fn) {
  mutate(d => {
    const sub = (d.subjects || []).find(s => s.id === id);
    if (sub) fn(sub);
  });
}

// ── list ────────────────────────────────────────────────────────────

export function renderSubjects(root, ctx) {
  const doc = state.doc;
  const subjects = doc.subjects || [];
  const texts = doc.texts || [];

  mount(root,
    h('header.view-head',
      h('h1', 'Subjects'),
      h('p.counts', subjects.length
        ? `${subjects.filter(s => s.status !== 'background').length} active of ${subjects.length}`
        : 'None yet'),
    ),

    h('p.notice.quiet',
      'Bodies of knowledge to master, which are never finished — as opposed to texts, which get '
      + 'consumed. A subject is not satisfied by reading alone, which is why it holds resources '
      + 'as well as texts and why progress is a count of topics rather than a bar.'),

    h('div.actions',
      h('button.primary', { onclick: () => addSubject(ctx) }, 'New subject')),

    subjects.length
      ? h('div.subject-list', subjects.map(sub => subjectCard(sub, texts)))
      : h('div.empty',
        h('p', 'No subjects yet. A subject is something you want to become competent at, '
          + 'with a goal specific enough to tell you when you are done.'),
        h('button', { onclick: () => addSubject(ctx) }, 'Add one')),
  );
}

function subjectCard(sub, texts) {
  const p = subjectProgress(sub);
  const goal = (sub.goal || '').trim();
  const linked = textsForSubject(sub, texts);
  return h('article.subject-card',
    h('div.subject-head',
      h('a.subject-title', { href: `#/subject/${encodeURIComponent(sub.id)}` }, sub.name),
      h('span.tag.soft', sub.status || 'active'),
    ),
    goal
      ? h('p.subject-goal', goal)
      : h('p.subject-goal.missing',
        'No goal recorded — so nothing says when this is done. Two sentences is enough.'),
    h('p.counts',
      p.total
        ? `${p.at} of ${p.total} topics at target (${p.target} · ${masteryLabel(p.target)})`
        : 'No topics yet',
      linked.length ? ` · ${linked.length} text${linked.length === 1 ? '' : 's'}` : null,
      (sub.resources || []).length
        ? ` · ${(sub.resources || []).filter(r => r.done).length} of ${sub.resources.length} resources done`
        : null,
    ),
    p.total ? h('div.mastery-strip', (sub.topics || []).map(t =>
      h(`span.pip.m${Number(t.mastery || 0)}`, { title: `${t.name} — ${masteryLabel(t.mastery)}` }))) : null,
  );
}

function addSubject(ctx) {
  const name = prompt('Subject name');
  if (!name || !name.trim()) return;
  const id = uniqueId(slugify(name), new Set((state.doc.subjects || []).map(s => s.id)));
  mutate(d => {
    d.subjects = d.subjects || [];
    d.subjects.push({
      id, name: name.trim(), goal: '', status: 'active',
      target_mastery: 2, topics: [], resources: [],
    });
  });
  ctx.go(`#/subject/${encodeURIComponent(id)}`);
}

// ── detail ──────────────────────────────────────────────────────────

export function renderSubjectDetail(root, ctx, id) {
  const doc = state.doc;
  const sub = (doc.subjects || []).find(s => s.id === id);
  if (!sub) {
    mount(root, h('div.empty',
      h('p', `No subject with id “${id}”.`),
      h('a.button', { href: '#/subjects' }, 'Back to subjects')));
    return;
  }
  const texts = doc.texts || [];
  const p = subjectProgress(sub);
  const set = patch => { editSubject(id, s => Object.assign(s, patch)); ctx.rerender(); };

  mount(root,
    h('header.view-head',
      h('nav.crumbs', h('a', { href: '#/subjects' }, '← Subjects')),
      h('h1.detail-title', sub.name),
      h('p.counts',
        p.total
          ? `${p.at} of ${p.total} topics at target (${p.target} · ${masteryLabel(p.target)})`
          : 'No topics yet',
        ' · ', sub.status || 'active'),
    ),

    h('section.card',
      h('h2', 'Goal'),
      h('textarea', {
        rows: 3, value: sub.goal || '',
        placeholder: 'Enough to … — specific enough that you could tell when it is met.',
        onchange: e => set({ goal: e.target.value.trim() }),
      }),
      h('p.hint', 'A subject without a goal is a label. "Learn modal logic" has no completion '
        + 'condition; "enough to follow the possible-worlds semantics in the indexicality '
        + 'literature" does.'),
      h('div.fields',
        h('div.field',
          h('label', { for: 'sub-status' }, 'Status'),
          h('select#sub-status', { onchange: e => set({ status: e.target.value }) },
            ['active', 'background'].map(v =>
              h('option', { value: v, selected: (sub.status || 'active') === v }, v))),
          h('p.hint', 'Background records a deliberate deprioritisation, which is itself worth '
            + 'telling an evaluation.')),
        h('div.field',
          h('label', { for: 'sub-target' }, 'Target mastery'),
          h('select#sub-target', { onchange: e => set({ target_mastery: Number(e.target.value) }) },
            MASTERY.map(([v, label]) =>
              h('option', { value: v, selected: (sub.target_mastery ?? 2) === v }, `${v} · ${label}`))),
          h('p.hint', 'The level at which a topic counts as done for this subject.')),
      ),
    ),

    topicsCard(sub, texts, ctx),
    resourcesCard(sub, ctx),
    textsCard(sub, texts, ctx),

    h('section.card.danger',
      h('h2', 'Remove'),
      h('button.danger', {
        onclick: () => {
          if (!confirm(`Delete the subject “${sub.name}”? Texts linked to it keep their other data.`)) return;
          mutate(d => {
            d.subjects = (d.subjects || []).filter(s => s.id !== id);
            for (const t of d.texts) {
              if ((t.subject_ids || []).includes(id)) {
                t.subject_ids = t.subject_ids.filter(x => x !== id);
              }
            }
          });
          ctx.go('#/subjects');
        },
      }, 'Delete this subject')),
  );
}

function topicsCard(sub, texts, ctx) {
  const topics = sub.topics || [];
  const byId = new Map(texts.map(t => [t.id, t]));
  return h('section.card',
    h('h2', `Topics${topics.length ? ` — ${topics.length}` : ''}`),
    h('p.hint', 'Granularity is yours: a topic can be broad ("channel capacity") or as specific '
      + 'as a competency ("can derive the source coding theorem"). §3 deliberately has no second '
      + 'layer beneath this — varying the grain of a topic does that job.'),
    topics.length
      ? h('ul.topic-list', topics.map(topic => topicRow(sub, topic, texts, byId, ctx)))
      : h('p.hint.dim', 'None yet.'),
    h('div.actions',
      h('button', {
        onclick: () => {
          const name = prompt('Topic');
          if (!name || !name.trim()) return;
          editSubject(sub.id, s => {
            s.topics = s.topics || [];
            s.topics.push({
              id: nextSubItemId(s.topics, 't'), name: name.trim(),
              mastery: 0, note: '', text_ids: [],
            });
          });
          ctx.rerender();
        },
      }, 'Add topic')),
  );
}

function topicRow(sub, topic, texts, byId, ctx) {
  const update = fn => {
    editSubject(sub.id, s => {
      const tp = (s.topics || []).find(x => x.id === topic.id);
      if (tp) fn(tp);
    });
    ctx.rerender();
  };
  const linked = (topic.text_ids || []).map(id => byId.get(id)).filter(Boolean);

  return h('li.topic-row',
    h('div.topic-main',
      h('input.topic-name', {
        type: 'text', value: topic.name, 'aria-label': 'Topic name',
        onchange: e => update(tp => { tp.name = e.target.value.trim() || tp.name; }),
      }),
      h('span.mastery-control',
        MASTERY.map(([v, label]) =>
          h(`button.mark.mastery${Number(topic.mastery || 0) === v ? '.on' : ''}`, {
            type: 'button', title: `${v} · ${label}`,
            'aria-pressed': Number(topic.mastery || 0) === v ? 'true' : 'false',
            onclick: () => update(tp => { tp.mastery = v; }),
          }, String(v)))),
      h('span.dim.small', masteryLabel(topic.mastery)),
      h('button.link.small', {
        onclick: () => {
          if (!confirm(`Remove the topic “${topic.name}”?`)) return;
          editSubject(sub.id, s => { s.topics = (s.topics || []).filter(x => x.id !== topic.id); });
          ctx.rerender();
        },
      }, 'remove'),
    ),
    h('input.topic-note', {
      type: 'text', value: topic.note || '', placeholder: 'Note — what is still unclear, what would settle it',
      'aria-label': 'Topic note',
      onchange: e => update(tp => { tp.note = e.target.value.trim(); }),
    }),
    linked.length
      ? h('p.topic-texts', h('span.dim', 'covers: '), linked.map((t, i) => [
        i ? ', ' : null,
        h('a', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title),
        h('button.link.small', {
          onclick: () => update(tp => { tp.text_ids = (tp.text_ids || []).filter(x => x !== t.id); }),
        }, '×'),
      ]))
      : null,
    h('details.topic-attach',
      h('summary.small', 'Attach a text to this topic'),
      rowPicker({
        texts, value: null, banned: new Set(topic.text_ids || []),
        placeholder: 'Type a title…',
        onChange: (id) => { if (id) update(tp => { tp.text_ids = [...(tp.text_ids || []), id]; }); },
      })),
  );
}

function resourcesCard(sub, ctx) {
  const resources = sub.resources || [];
  const update = (rid, fn) => {
    editSubject(sub.id, s => {
      const r = (s.resources || []).find(x => x.id === rid);
      if (r) fn(r);
    });
    ctx.rerender();
  };
  return h('section.card',
    h('h2', `Resources${resources.length ? ` — ${resources.filter(r => r.done).length} of ${resources.length} done` : ''}`),
    h('p.hint', 'The non-text work: problem sets, lecture series, "write a one-page summary from '
      + 'memory". This is the part a reading list cannot hold, and the reason a subject is a '
      + 'separate thing from a text.'),
    resources.length
      ? h('ul.resource-list', resources.map(r =>
        h('li.resource-row',
          h('label.check',
            h('input', {
              type: 'checkbox', checked: !!r.done,
              onchange: e => update(r.id, x => { x.done = e.target.checked; }),
            }),
            h('span', r.name)),
          h('span.tag.soft', r.kind || 'other'),
          h('button.link.small', {
            onclick: () => {
              if (!confirm(`Remove “${r.name}”?`)) return;
              editSubject(sub.id, s => { s.resources = (s.resources || []).filter(x => x.id !== r.id); });
              ctx.rerender();
            },
          }, 'remove'))))
      : h('p.hint.dim', 'None yet.'),
    h('div.actions',
      h('button', {
        onclick: () => {
          const name = prompt('Resource — e.g. "Work the exercises in Part I"');
          if (!name || !name.trim()) return;
          const kind = prompt(`Kind: ${RESOURCE_KINDS.join(' / ')}`, 'exercise');
          editSubject(sub.id, s => {
            s.resources = s.resources || [];
            s.resources.push({
              id: nextSubItemId(s.resources, 'r'), name: name.trim(),
              kind: RESOURCE_KINDS.includes(kind) ? kind : 'other', done: false,
            });
          });
          ctx.rerender();
        },
      }, 'Add resource')),
  );
}

function textsCard(sub, texts, ctx) {
  const linked = textsForSubject(sub, texts)
    .sort((a, b) => sortKeyTitle(a).localeCompare(sortKeyTitle(b)));
  const attached = new Set(linked.map(t => t.id));
  return h('section.card',
    h('h2', `Reading — ${linked.length}`),
    linked.length
      ? h('ul.child-list', linked.map(t =>
        h('li',
          h('a', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title || '(untitled)'),
          h('span.dim', ` — ${[authorLine(t), STATUS_LABEL[t.status] || t.status].filter(Boolean).join(' · ')}`),
          (t.subject_ids || []).includes(sub.id)
            ? h('button.link.small', {
              onclick: () => {
                mutate(d => {
                  const row = d.texts.find(x => x.id === t.id);
                  row.subject_ids = (row.subject_ids || []).filter(x => x !== sub.id);
                });
                ctx.rerender();
              },
            }, 'detach')
            : h('span.dim.small', ' via a topic'))))
      : h('p.hint.dim', 'Nothing attached yet.'),
    h('div.field.wide',
      h('label', 'Attach a text to the subject as a whole'),
      rowPicker({
        texts, value: null, banned: attached, placeholder: 'Type a title…',
        onChange: (id) => {
          if (!id) return;
          mutate(d => {
            const row = d.texts.find(x => x.id === id);
            row.subject_ids = [...new Set([...(row.subject_ids || []), sub.id])];
          });
          ctx.rerender();
        },
      }),
      h('p.hint', 'Attach to a topic instead when the text covers that topic specifically — '
        + 'both are recorded and the list above is the union.')),
  );
}
