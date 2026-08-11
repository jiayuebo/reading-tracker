// Comparison pool (spec §4, phase 1.5).
//
// §4 says to sample pairs adaptively but never says which texts are in the pool
// to begin with, and the arithmetic makes that the load-bearing decision. At
// 4-6 comparisons per item per dimension, the 149-text read corpus is roughly
// 1,100 comparisons across the three dimensions — an hour of clicking, and
// exactly the "scoring becomes a procrastination object" risk §9 names.
//
// The comparisons exist to train the rubric, not to rank the shelf. Forty to
// sixty well-chosen texts carry nearly the same signal, and the rubric
// extrapolates to everything else — which is the whole point of extrapolating.
// So: choose the pool deliberately, see what it costs while choosing, and let
// Backfill work on that subset instead of the whole corpus.

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import {
  poolEligible, inPool, poolCost, authorLine, sortKeyTitle, matchesQuery, STATUS_LABEL,
} from '../model.js';

const FILTERS = {
  all: { label: 'All eligible', test: () => true },
  in: { label: 'In the pool', test: t => inPool(t) },
  out: { label: 'Not in the pool', test: t => !inPool(t) },
};

let filter = 'all';
let query = '';

function setPool(ids, value) {
  const want = new Set(ids);
  mutate(d => {
    for (const t of d.texts) {
      if (!want.has(t.id)) continue;
      if (value) t.in_pool = true;
      else delete t.in_pool;      // sparse: absent rather than false
    }
  });
}

export function renderPool(root, ctx) {
  const texts = (state.doc && state.doc.texts) || [];
  const eligible = texts.filter(poolEligible);
  const chosen = eligible.filter(inPool);
  const cost = poolCost(chosen.length);

  const shown = eligible
    .filter(FILTERS[filter].test)
    .filter(t => !query || matchesQuery(`${t.title} ${(t.authors || []).join(' ')}`, query))
    .sort((a, b) => {
      const da = a.date_finished || '', db = b.date_finished || '';
      if (da !== db) { if (!da) return 1; if (!db) return -1; return da > db ? -1 : 1; }
      return sortKeyTitle(a).localeCompare(sortKeyTitle(b));
    });

  const missingYear = chosen.filter(t => t.year == null);
  const projectLinked = eligible.filter(t => (t.project_ids || []).length && !inPool(t));
  const dated = eligible.filter(t => t.date_finished && !inPool(t));

  mount(root,
    h('header.view-head',
      h('h1', 'Comparison pool'),
      h('p.counts',
        `${chosen.length} of ${eligible.length} eligible`,
        chosen.length ? ` · target 40–60` : null),
    ),

    h('p.notice.quiet',
      'Comparisons train the rubric; they do not rank the shelf directly. A sampled 40–60 '
      + 'carries nearly the signal of the whole corpus, and the rubric extrapolates to the rest. '
      + 'Texts read but never confirmed from a syllabus are excluded automatically (spec §10).'),

    chosen.length ? costPanel(chosen.length, cost) : null,
    chosen.length ? readiness(chosen, missingYear, ctx) : null,

    h('div.controls',
      h('input.search', {
        type: 'search', id: 'q', placeholder: 'Search title or author…', value: query,
        'aria-label': 'Search',
        oninput: e => { query = e.target.value; ctx.rerender(); },
      }),
      h('label.sel', h('span.sr-only', 'Filter'),
        h('select', { 'aria-label': 'Filter', onchange: e => { filter = e.target.value; ctx.rerender(); } },
          Object.entries(FILTERS).map(([k, v]) =>
            h('option', { value: k, selected: k === filter }, `${v.label} ${eligible.filter(v.test).length}`)))),
      h('span.spacer'),
      projectLinked.length
        ? h('button', { onclick: () => setPool(projectLinked.map(t => t.id), true) },
          `Add ${projectLinked.length} project-linked`)
        : null,
      dated.length
        ? h('button', { onclick: () => setPool(dated.map(t => t.id), true) },
          `Add ${dated.length} with a finish date`)
        : null,
      chosen.length
        ? h('button.danger', {
          onclick: () => {
            if (!confirm(`Remove all ${chosen.length} texts from the pool?`)) return;
            setPool(chosen.map(t => t.id), false);
          },
        }, 'Clear pool')
        : null,
    ),

    shown.length
      ? h('ul.pool-list', shown.map(t => poolRow(t)))
      : h('div.empty', h('p', 'Nothing matches.')),
  );
}

function costPanel(n, c) {
  const heavy = n > 70;
  return h(`div.cost-panel${heavy ? '.warn' : ''}`,
    h('p',
      h('strong', `${n} texts`), ' → about ',
      h('strong.tabular', String(c.perDimension)), ' comparisons per dimension, ',
      h('strong.tabular', String(c.total)), ' in all — ',
      `${c.batches} batches of 20, roughly ${c.minutes} minutes of clicking.`),
    heavy
      ? h('p.hint', 'That is a lot to sit through in one stretch, and an unfinished pass is worth '
        + 'less than a smaller finished one. Consider trimming toward 60.')
      : null);
}

function readiness(chosen, missingYear, ctx) {
  if (!missingYear.length) {
    return h('p.notice.quiet',
      `All ${chosen.length} have a year. The rubric has features to regress on for every text in the pool.`);
  }
  return h('p.notice.warn',
    `${missingYear.length} of ${chosen.length} still have no year, so the rubric would have `
    + 'nothing but the author to learn from for those. ',
    h('a', { href: '#/backfill' }, 'Backfill them'),
    ' — the Backfill scope selector has a "Comparison pool" option.');
}

function poolRow(t) {
  const ready = t.year != null;
  return h('li.pool-row',
    h('label.pool-label',
      h('input', {
        type: 'checkbox', checked: inPool(t),
        onchange: e => setPool([t.id], e.target.checked),
      }),
      h('span.pool-main',
        h('span.title', t.title || '(untitled)'),
        h('span.meta',
          [authorLine(t), t.year || null, t.date_finished ? `finished ${t.date_finished}` : null]
            .filter(Boolean).join(' · ')),
      ),
    ),
    h('div.row-tags',
      (t.project_ids || []).length ? h('span.tag.soft', 'Project') : null,
      t.source && t.source !== 'queue' ? h('span.tag.soft', t.source) : null,
      ready ? null : h('span.tag.warn', 'no year'),
    ),
  );
}
