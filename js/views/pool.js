// Comparison pool (spec §4).
//
// Built to bound a fitting budget, resized when the 2026-08-11 revision retired
// the fit, and given a ranking back on 2026-09-14 — this time only over texts
// already read, where nothing is being extrapolated (see compare.js). The pool is
// the default set compared, and a ranking takes about n·log n answers to settle,
// so its size is once again a cost worth seeing before growing it.
//
// It keeps a second use that survives the revision, and may be the better one:
// it is a standing statement of which read texts actually matter, which makes it
// the right subset to hand an evaluator as corpus context when the whole read
// corpus would be noise.

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import {
  poolEligible, inPool, authorLine, sortKeyTitle, matchesQuery,
} from '../model.js';
import { DIMENSION, fitBT, percentiles, suggestedTotal } from '../compare.js';

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

  const shown = eligible
    .filter(FILTERS[filter].test)
    .filter(t => !query || matchesQuery(`${t.title} ${(t.authors || []).join(' ')}`, query))
    .sort((a, b) => {
      const da = a.date_finished || '', db = b.date_finished || '';
      if (da !== db) { if (!da) return 1; if (!db) return -1; return da > db ? -1 : 1; }
      return sortKeyTitle(a).localeCompare(sortKeyTitle(b));
    });

  const missingYear = chosen.filter(t => t.year == null);
  const poolIds = new Set(chosen.map(t => t.id));
  const answered = (state.doc.comparisons || []).filter(c =>
    c.dimension === DIMENSION && poolIds.has(c.winner_id) && poolIds.has(c.loser_id));
  const fit = fitBT(chosen.map(t => t.id), answered);
  const positions = fit.used ? percentiles(fit) : null;
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
      'Two uses. These are the read texts handed to an evaluation as corpus context, and the set '
      + 'you compare by default. Texts read but never confirmed from a syllabus are excluded '
      + 'automatically (spec §10).'),

    chosen.length ? comparePanel(chosen.length, answered.length) : null,
    chosen.length ? readiness(chosen, missingYear) : null,

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
      ? h('ul.pool-list', shown.map(t => poolRow(t, positions)))
      : h('div.empty', h('p', 'Nothing matches.')),
  );
}

function comparePanel(n, answered) {
  const target = suggestedTotal(n);
  return h('div.cost-panel',
    h('div.card-head',
      h('p',
        h('strong', `${n} texts`), ' · ',
        `${answered} comparison${answered === 1 ? '' : 's'} answered`,
        n > 1 ? ` · about ${target} to settle a ranking` : null),
      n > 1 ? h('a.button.primary', { href: '#/compare' }, answered ? 'Keep comparing' : 'Compare') : null),
    h('p.hint', 'Which would you more regret never having read? Asked of two texts at a time, in '
      + 'sittings of twenty. The ranking is recomputed from your answers and never saved, and each '
      + 'text added to the pool adds a few more to the total.'));
}

function readiness(chosen, missingYear) {
  const marked = chosen.filter(t => t.assessment).length;
  return h('p.notice.quiet',
    `${marked} of ${chosen.length} carry a good/bad mark. `,
    marked
      ? 'Those anchor what the top and bottom of the scale mean to you.'
      : 'Without any, an evaluation has nothing tying its scale to your judgment — a handful at '
        + 'each end is worth more than a hundred in the middle.',
    missingYear.length
      ? [' ', `${missingYear.length} have no year; `, h('a', { href: '#/backfill' }, 'Backfill'),
        ' can fill those, though year is no longer load-bearing.']
      : null);
}

function poolRow(t, positions) {
  const ready = t.year != null;
  const pos = positions && inPool(t) ? positions.get(t.id) : null;
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
      pos ? h('span.tag.soft.tabular', { title: `${pos.rank} of ${pos.of} by your comparisons` }, `top ${pos.top}%`) : null,
      (t.project_ids || []).length ? h('span.tag.soft', 'Project') : null,
      t.source && t.source !== 'queue' ? h('span.tag.soft', t.source) : null,
      ready ? null : h('span.tag.warn', 'no year'),
    ),
  );
}
