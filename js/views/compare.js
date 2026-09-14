// Compare (spec §5.5). One question, two texts, a keypress.
//
// The question is §4's operational definition of absolute value — which would
// you more regret never having read? — asked of two texts at a time, because
// that is answerable where a number out of ten is not. Answers are appended to
// `comparisons`; the ranking in the results is recomputed from them on every
// render and never written to the file (see compare.js).
//
// What the cards leave out matters as much as what they show. The evaluator's
// predicted scores never appear while you are answering: seeing them would pull
// your answer toward them, and these answers are what those scores get audited
// against. They appear only in the results, behind their own disclosure.

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import { authorLine, poolEligible, inPool, byIdIndex } from '../model.js';
import {
  DIMENSION, fitBT, nextPair, pairKey, percentiles, suggestedTotal, newComparison,
  agreement, rankCorrelation,
} from '../compare.js';

/** §9: comparing is pleasanter than reading, so sessions are short and end cleanly. */
const SESSION_LENGTH = 20;
const RECENT = 8;

const SCOPES = {
  // Exactly the Pool view's own set. `in_pool` alone is not enough: a text can
  // keep the flag after it stops being eligible — returned to the queue, say —
  // and the two screens then disagreed about how many texts the pool holds.
  pool: { label: 'Comparison pool', test: t => poolEligible(t) && inPool(t) },
  read: { label: 'Everything read', test: t => poolEligible(t) },
};

let scope = 'pool';
let round = 0;
let current = null;           // [leftId, rightId]
let made = [];                // [{ id, pair }] written this session, newest last
let sessionStart = 0;
let recent = [];
let resultsOpen = false;

function comparisons() {
  return (state.doc.comparisons || []).filter(c => c.dimension === DIMENSION);
}

function candidates() {
  return (state.doc.texts || []).filter(SCOPES[scope].test);
}

function remember(key) {
  recent = [...recent.filter(k => k !== key), key].slice(-RECENT);
}

function sessionCount() {
  return made.length - sessionStart;
}

function record(result, ctx) {
  if (!current) return;
  const [a, b] = current;
  let entry = null;
  mutate(d => {
    d.comparisons = d.comparisons || [];
    const c = result === 'tie'
      ? newComparison(d.comparisons, a, b, true)
      : result === 'left'
        ? newComparison(d.comparisons, a, b)
        : newComparison(d.comparisons, b, a);
    d.comparisons.push(c);
    entry = { id: c.id, pair: [a, b] };
  });
  if (entry) made.push(entry);
  remember(pairKey(a, b));
  round += 1;
  current = null;
  ctx.rerender();
}

function skip(ctx) {
  if (!current) return;
  remember(pairKey(current[0], current[1]));
  round += 1;
  current = null;
  ctx.rerender();
}

/**
 * Undo the last answer given in this session, and only that.
 *
 * §3 says comparisons are append-only and a changed mind is a new comparison
 * with a later date. A mis-keyed answer seconds ago is not a changed mind, and
 * leaving it in would record a judgement nobody made. Anything older stays.
 */
function undo(ctx) {
  const last = made.pop();
  if (!last) return;
  mutate(d => {
    d.comparisons = (d.comparisons || []).filter(c => c.id !== last.id);
  });
  current = last.pair;
  recent = recent.filter(k => k !== pairKey(last.pair[0], last.pair[1]));
  round = Math.max(0, round - 1);
  ctx.rerender();
}

export function compareKeys(e, ctx) {
  if (sessionCount() >= SESSION_LENGTH) {
    if (e.key === 'Enter') { e.preventDefault(); sessionStart = made.length; ctx.rerender(); return true; }
    if (e.key === 'u') { e.preventDefault(); undo(ctx); return true; }
    return false;
  }
  const map = {
    1: () => record('left', ctx), ArrowLeft: () => record('left', ctx),
    3: () => record('right', ctx), ArrowRight: () => record('right', ctx),
    2: () => record('tie', ctx), '=': () => record('tie', ctx),
    s: () => skip(ctx), u: () => undo(ctx),
  };
  const fn = map[e.key];
  if (!fn) return false;
  e.preventDefault();
  fn();
  return true;
}

export function renderCompare(root, ctx) {
  const texts = state.doc.texts || [];
  const byId = byIdIndex(texts);
  const pool = candidates();
  const ids = pool.map(t => t.id);
  const idSet = new Set(ids);
  const all = comparisons();
  const inScope = all.filter(c => idSet.has(c.winner_id) && idSet.has(c.loser_id));
  const fit = fitBT(ids, inScope);
  const target = suggestedTotal(ids.length);

  const scopeSelect = h('label.sel', h('span.sr-only', 'Which texts'),
    h('select', {
      'aria-label': 'Which texts',
      onchange: (e) => { scope = e.target.value; current = null; recent = []; ctx.rerender(); },
    }, Object.entries(SCOPES).map(([k, v]) =>
      h('option', { value: k, selected: k === scope }, `${v.label} (${texts.filter(v.test).length})`))));

  const head = h('header.view-head.compare-head',
    h('p.crumb', h('a', { href: '#/pool' }, '← Pool')),
    h('div.compare-meta',
      scopeSelect,
      h('span.dim.small.tabular',
        `${inScope.length} answered · about ${target} to settle ${ids.length} texts`)),
  );

  if (ids.length < 2) {
    mount(root, head, h('div.empty',
      h('p', scope === 'pool'
        ? 'The pool needs at least two texts before there is anything to compare.'
        : 'There need to be at least two read texts to compare.'),
      h('div.empty-actions', h('a.button', { href: '#/pool' }, 'Go to the pool'))));
    return;
  }

  if (current && !(idSet.has(current[0]) && idSet.has(current[1]))) current = null;
  if (!current) current = nextPair(fit, { round, avoid: new Set(recent) });

  const doneForNow = sessionCount() >= SESSION_LENGTH;

  mount(root,
    head,
    doneForNow
      ? h('section.compare-stop',
        h('p.compare-question', `${SESSION_LENGTH} answered this sitting.`),
        h('p.dim', 'A good place to stop. The ranking below has taken them in.'),
        h('div.actions',
          h('button.primary', { onclick: () => { sessionStart = made.length; ctx.rerender(); } }, 'Keep going'),
          h('a.button', { href: '#/pool' }, 'Back to the pool'),
          made.length ? h('button', { onclick: () => undo(ctx) }, 'Undo the last answer') : null),
        h('p.hint.dim', h('kbd', 'Enter'), ' keep going · ', h('kbd', 'u'), ' undo'))
      : current
        ? pairPanel(current, byId, ctx)
        : h('div.empty', h('p', 'Every nearby pair has been asked recently. Come back after some more reading.')),
    results(fit, pool, byId, inScope, ctx),
  );
}

function pairPanel([leftId, rightId], byId, ctx) {
  const left = byId.get(leftId);
  const right = byId.get(rightId);
  return h('section.compare-stage',
    h('p.compare-question', 'Which would you more regret never having read?'),
    h('div.compare-cards',
      card(left, 'left', '1', ctx),
      h('div.compare-or', 'or'),
      card(right, 'right', '3', ctx)),
    h('div.compare-actions',
      h('button', { onclick: () => record('tie', ctx) }, 'Can’t separate them'),
      h('button', { onclick: () => skip(ctx) }, 'Skip'),
      made.length ? h('button.linkish', { onclick: () => undo(ctx) }, 'Undo') : null),
    h('p.hint.dim.compare-keys',
      h('kbd', '1'), ' / ', h('kbd', '←'), ' left · ',
      h('kbd', '3'), ' / ', h('kbd', '→'), ' right · ',
      h('kbd', '2'), ' can’t separate · ', h('kbd', 's'), ' skip · ', h('kbd', 'u'), ' undo · ',
      `${sessionCount()} of ${SESSION_LENGTH} this sitting`),
  );
}

function card(t, side, key, ctx) {
  const meta = [authorLine(t), t.year || null, t.type !== 'article' ? t.type : null,
    t.pages ? `${t.pages} pp` : null].filter(Boolean);
  const verdict = (t.verdict || '').trim();
  return h(`button.compare-card.${side}`, {
    type: 'button',
    'aria-label': `${t.title || 'Untitled'} — choose (${key})`,
    onclick: () => record(side, ctx),
  },
    h('span.compare-title', t.title || '(untitled)'),
    meta.length ? h('span.compare-sub', meta.join(' · ')) : null,
    h('span.compare-tags',
      t.assessment === 'good' ? h('span.tag.good', 'Good') : null,
      t.assessment === 'bad' ? h('span.tag.bad', 'Bad') : null,
      t.date_finished ? h('span.dim.small', `finished ${t.date_finished}`) : null),
    verdict
      ? h('span.compare-verdict', verdict.length > 320 ? `${verdict.slice(0, 319)}…` : verdict)
      : h('span.compare-verdict.dim', 'No verdict written.'),
    h('span.compare-pick', h('kbd', key), ' this one'));
}

function certainty(se) {
  if (se < 0.7) return ['settled', 'Settled'];
  if (se < 1.3) return ['rough', 'Roughly placed'];
  return ['unsure', 'Barely placed'];
}

function results(fit, pool, byId, inScope, ctx) {
  const pct = percentiles(fit);
  const audit = agreement(inScope, byId);
  const rho = rankCorrelation(fit, byId);
  return h('details.card.compare-results', {
    open: resultsOpen,
    ontoggle: (e) => { resultsOpen = e.target.open; },
  },
    h('summary', `Ranking — ${fit.used} answer${fit.used === 1 ? '' : 's'} across ${pool.length} texts`),
    fit.used
      ? h('p.hint', 'Recomputed from your answers every time; nothing here is saved. Texts you have '
        + 'compared less sit nearer the middle until you do.')
      : h('p.hint', 'No answers yet. The order below is arbitrary until there are some.'),
    h('ol.compare-rank', fit.items.map((it) => {
      const t = byId.get(it.id);
      const p = pct.get(it.id);
      const [cls, label] = certainty(it.se);
      return h('li',
        h('span.rank-pos.tabular', `${p.rank}`),
        h('a', { href: `#/text/${encodeURIComponent(it.id)}` }, t.title || '(untitled)'),
        h('span.dim.small', ` ${authorLine(t) || ''}`),
        h('span.spacer'),
        h('span.dim.small.tabular', `top ${p.top}%`),
        h(`span.certainty.${cls}`, { title: `${it.games} comparison${it.games === 1 ? '' : 's'}` }, label));
    })),
    h('details.compare-audit',
      h('summary', 'Against the evaluator’s scores'),
      h('p.hint.warn', 'Looking at these before you have finished comparing will pull your answers '
        + 'toward them.'),
      audit.n
        ? h('p', `Its predicted absolute values agree with ${audit.agree} of ${audit.n} answers `
          + `(${Math.round((audit.agree / audit.n) * 100)}%) where both texts have one.`)
        : h('p.dim', 'No answered pair has predicted scores on both sides yet.'),
      rho ? h('p', `Order agreement over ${rho.n} texts: Spearman ρ = ${rho.rho.toFixed(2)}.`) : null,
      audit.disagreements.length
        ? h('ul.compare-disagree', audit.disagreements.map(({ winner, loser }) => h('li',
          h('strong', winner.title), ` over ${loser.title}`,
          h('span.dim.small', ` — predicted ${winner.predicted.value_abs} vs ${loser.predicted.value_abs}`))))
        : null),
  );
}
