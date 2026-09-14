// Log view (spec §5.9): finished and abandoned texts by date, with verdicts.
// "The view that will matter most in three years."
//
// THE CONSTRAINT THAT SHAPES THIS FILE. Only 88 of 301 finished rows carry a
// finish date; the rest came from a bulk import that never had one. A time
// series drawn from a third of the corpus would be a lie told confidently, so
// the undated rows are counted in the header, listed at the bottom, and named
// under every chart. What is charted is what is dated, and the view says so.

import { h, mount } from '../dom.js';
import { state } from '../store.js';
import { authorLine, sortKeyTitle, STATUS_LABEL, childIndex, REREAD_KINDS } from '../model.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SOURCE_ORDER = ['queue', 'off-list', 'coursework'];
const SOURCE_LABEL = {
  queue: 'From the queue',
  'off-list': 'Off-list',
  coursework: 'Coursework',
  reread: 'Reread',
};

/** Inclusive list of YYYY-MM between two dates, gaps included. */
function monthSpan(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Months a bar chart can show without the labels colliding. */
function labelEvery(n) {
  return n <= 12 ? 1 : Math.ceil(n / 12);
}

/**
 * A stacked bar chart, hand-drawn.
 *
 * No chart library, for the same reason as everywhere else: a third-party
 * script on a page holding a GitHub token changes the security picture (§9).
 * Colours come from CSS classes rather than fill attributes so that both
 * themes work without redrawing.
 */
function barChart({ months, stacks, keys, labelOf, summary, valueLabel }) {
  const W = 720, H = 170, padL = 44, padR = 8, padT = 10, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...months.map(k => keys.reduce((s, key) => s + (stacks[key][k] || 0), 0)));
  // A round number above the tallest bar, so the axis reads as a scale rather
  // than as whatever this month happened to be.
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const bw = Math.min(38, (plotW / months.length) * 0.66);
  const x = i => padL + (plotW / months.length) * (i + 0.5) - bw / 2;
  const y = v => padT + plotH - (v / top) * plotH;
  const every = labelEvery(months.length);

  const ticks = [0, top / 2, top].map(v => svg('g', { class: 'chart-tick' },
    svg('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v) }),
    svg('text', { x: padL - 6, y: y(v) + 3, 'text-anchor': 'end' }, fmt(v))));

  const bars = months.map((k, i) => {
    let acc = 0;
    const segs = keys.map((key) => {
      const v = stacks[key][k] || 0;
      if (!v) return null;
      const yTop = y(acc + v);
      const hgt = y(acc) - yTop;
      acc += v;
      return svg('rect', {
        class: `bar bar-${key}`, x: x(i), y: yTop, width: bw, height: Math.max(1, hgt),
      }, svg('title', {}, `${labelOf(k)} · ${SOURCE_LABEL[key] || key}: ${fmt(v)}`));
    }).filter(Boolean);
    const lab = i % every === 0
      ? svg('text', { class: 'chart-x', x: x(i) + bw / 2, y: H - 8, 'text-anchor': 'middle' },
        labelOf(k).replace(' 20', ' ’'))
      : null;
    return svg('g', {}, ...segs, lab);
  });

  return svg('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `${valueLabel} per month. ${summary}`,
  }, ...ticks, ...bars);
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(0);
}

/** dom.js `h` builds HTML elements; SVG needs the namespaced constructor. */
function svg(tag, attrs, ...kids) {
  // Everything inside an <svg> must be namespaced. Building a <g> with the
  // HTML `h()` produces an element that sits in the DOM and never paints,
  // which looks exactly like a chart with no data in it.
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/**
 * Which reading the log shows. Rereads are separable because they answer a
 * different question: new reads measure how the corpus grows, rereads measure
 * where time went back. Mixed without a way apart, a month of rereading would
 * look like a month of discovery.
 */
let lens = 'both';
const LENSES = [['both', 'Everything'], ['new', 'New reads'], ['rereads', 'Rereads']];

export function renderLog(root, ctx) {
  const texts = (state.doc && state.doc.texts) || [];
  const finished = texts.filter(t => t.status === 'read' || t.status === 'abandoned');
  const dated = finished.filter(t => t.date_finished);

  /**
   * Finishing a book by finishing its chapters logs both, and counting both
   * says you read the thing twice.
   *
   * A work is counted at the outermost dated row. Pages net out instead of
   * collapsing, so each month keeps the share it earned: a row contributes its
   * own page count minus the pages of its dated descendants.
   */
  const kids = childIndex(texts);
  const byId = new Map(texts.map(t => [t.id, t]));
  const isDated = new Set(dated.map(t => t.id));

  const subsumed = (t) => {
    let p = t.parent_id, guard = 0;
    while (p && guard++ < 12) {
      if (isDated.has(p)) return true;
      p = (byId.get(p) || {}).parent_id;
    }
    return false;
  };
  const datedDescendantPages = (t, guard = 0) => {
    if (guard > 12) return 0;
    return (kids.get(t.id) || []).reduce((sum, k) =>
      sum + (isDated.has(k.id) ? (k.pages || 0) : 0) + datedDescendantPages(k, guard + 1), 0);
  };
  const netPages = (t) => Math.max(0, (t.pages || 0) - datedDescendantPages(t));

  const works = dated.filter(t => !subsumed(t));
  const rolledUp = dated.length - works.length;
  const undated = finished.filter(t => !t.date_finished);
  const reading = texts.filter(t => t.status === 'reading');

  // Rereads are events on a row (§4.5). They never change status, so they
  // never reach the queue or the priority sort; here they are only counted.
  const rereads = [];
  for (const t of texts) {
    for (const e of t.reread_log || []) if (e && e.date) rereads.push({ t, e });
  }

  const showNew = lens !== 'rereads';
  const showRe = lens !== 'new';

  const lensBar = h('div.lens', { role: 'group', 'aria-label': 'Which reading to show' },
    LENSES.map(([k, label]) => h(`button.small${lens === k ? '.primary' : ''}`, {
      type: 'button', 'aria-pressed': lens === k ? 'true' : 'false',
      onclick: () => { lens = k; ctx.rerender(); },
    }, k === 'rereads' && rereads.length ? `${label} ${rereads.length}` : label)));

  if (!finished.length && !rereads.length) {
    mount(root,
      h('header.view-head', h('h1', 'Log')),
      h('div.empty', h('p', 'Nothing is finished yet. This fills up as you mark things read.')));
    return;
  }

  const byMonth = new Map();
  const slot = (k) => {
    if (!byMonth.has(k)) byMonth.set(k, { reads: [], rereads: [] });
    return byMonth.get(k);
  };
  if (showNew) for (const t of dated) slot(t.date_finished.slice(0, 7)).reads.push(t);
  if (showRe) for (const r of rereads) slot(r.e.date.slice(0, 7)).rereads.push(r);
  const sortedKeys = [...byMonth.keys()].sort();
  const monthKeys = sortedKeys.length ? monthSpan(sortedKeys[0], sortedKeys.at(-1)) : [];

  const stackKeys = [...(showNew ? SOURCE_ORDER : []), ...(showRe ? ['reread'] : [])];
  const counts = {};
  const pages = {};
  for (const key of stackKeys) { counts[key] = {}; pages[key] = {}; }
  const srcOf = t => (SOURCE_ORDER.includes(t.source) ? t.source : 'queue');
  if (showNew) {
    for (const t of works) {
      const k = t.date_finished.slice(0, 7);
      counts[srcOf(t)][k] = (counts[srcOf(t)][k] || 0) + 1;
    }
    for (const t of dated) {
      const n = netPages(t);
      if (!n) continue;
      const k = t.date_finished.slice(0, 7);
      pages[srcOf(t)][k] = (pages[srcOf(t)][k] || 0) + n;
    }
  }
  if (showRe) {
    for (const { t, e } of rereads) {
      const k = e.date.slice(0, 7);
      counts.reread[k] = (counts.reread[k] || 0) + 1;
      if (t.pages) pages.reread[k] = (pages.reread[k] || 0) + t.pages;
    }
  }

  const newPages = showNew ? dated.reduce((s, t) => s + netPages(t), 0) : 0;
  const rePages = showRe ? rereads.reduce((s, r) => s + (r.t.pages || 0), 0) : 0;
  const pagesTotal = newPages + rePages;
  const withPages = (showNew ? dated.filter(t => netPages(t) > 0).length : 0)
    + (showRe ? rereads.filter(r => r.t.pages).length : 0);
  const reHours = rereads.reduce((s, r) => s + (Number(r.e.hours) || 0), 0);
  const reTexts = new Set(rereads.map(r => r.t.id)).size;
  const good = finished.filter(t => t.assessment === 'good').length;
  const bad = finished.filter(t => t.assessment === 'bad').length;
  const events = (showNew ? works.length : 0) + (showRe ? rereads.length : 0);
  const perMonth = monthKeys.length ? (events / monthKeys.length) : 0;

  const countsTitle = lens === 'rereads' ? 'Rereads' : 'Works finished';
  const pagesTitle = lens === 'rereads' ? 'Pages reread' : 'Pages finished';

  mount(root,
    h('header.view-head',
      h('h1', 'Log'),
      h('p.counts',
        `${finished.length} finished · ${dated.length} with a date · `,
        undated.length ? `${undated.length} without` : 'all dated',
        rolledUp ? ` · ${rolledUp} counted under a parent` : null,
        rereads.length ? ` · ${rereads.length} reread${rereads.length === 1 ? '' : 's'}` : null),
    ),

    lensBar,

    h('div.log-stats',
      showNew ? stat(works.length, 'works',
        rolledUp ? `${rolledUp} chapters counted in their book` : 'nothing nested') : null,
      showRe ? stat(rereads.length, 'rereads',
        rereads.length
          ? `${reTexts} text${reTexts === 1 ? '' : 's'} · ${reHours ? `${reHours}h logged` : 'no hours logged'}`
          : 'none logged yet') : null,
      stat(perMonth ? perMonth.toFixed(1) : '—', 'per month',
        lens === 'both' && rereads.length ? 'reads and rereads together' : 'average across the span'),
      stat(pagesTotal ? pagesTotal.toLocaleString() : '—', 'pages',
        withPages ? `from ${withPages} that record them` : 'none recorded'),
      showNew ? stat(`${good}/${bad}`, 'good / bad', `${finished.length - good - bad} unmarked`) : null,
    ),

    monthKeys.length ? h('section.card',
      h('div.card-head', h('h2', countsTitle), legend(stackKeys)),
      barChart({
        months: monthKeys, stacks: counts, keys: stackKeys, labelOf: monthLabel,
        valueLabel: countsTitle,
        summary: `${events} across ${monthKeys.length} months.`,
      }),
    ) : (lens === 'rereads' ? h('div.empty',
      h('p', 'No rereads logged yet. Use “Log a reread” on any finished text, or the Reread button '
        + 'on rows flagged for one.')) : null),

    withPages ? h('section.card',
      h('div.card-head', h('h2', pagesTitle), legend(stackKeys)),
      barChart({
        months: monthKeys, stacks: pages, keys: stackKeys, labelOf: monthLabel,
        valueLabel: pagesTitle,
        summary: `${pagesTotal} pages across ${monthKeys.length} months.`,
      }),
      h('p.hint', `A floor, not a total: only ${withPages} contribute a page count. `
        + (showNew ? 'Chapters of a book you also marked finished are netted out. ' : '')
        + (showRe ? 'A reread counts the whole text’s pages.' : '')),
    ) : null,

    showNew && reading.length ? h('section.card',
      h('h2', `Open now — ${reading.length}`),
      h('ul.log-list', reading
        .slice().sort((a, b) => (a.date_started || '9999').localeCompare(b.date_started || '9999'))
        .map(t => logRow(t, { showOpenFor: true }))),
    ) : null,

    ...[...byMonth.keys()].sort().reverse().map((k) => {
      const m = byMonth.get(k);
      const items = [
        ...m.reads.map(t => ({ date: t.date_finished, node: logRow(t) })),
        ...m.rereads.map(r => ({ date: r.e.date, node: rereadRow(r) })),
      ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const n = m.reads.filter(x => !subsumed(x)).length;
      const pp = m.reads.reduce((s, t) => s + netPages(t), 0)
        + m.rereads.reduce((s, r) => s + (r.t.pages || 0), 0);
      const bits = [
        showNew ? `${n} new` : null,
        showRe && m.rereads.length ? `${m.rereads.length} reread` : null,
        `${pp || '—'} pp`,
      ].filter(Boolean);
      return h('section.card',
        h('div.card-head', h('h2', monthLabel(k)), h('span.dim.small', bits.join(' · '))),
        h('ul.log-list', items.map(x => x.node)));
    }),

    showNew && undated.length ? h('details.card.log-undated',
      h('summary', `${undated.length} finished with no date`),
      h('p.hint', 'Mostly the original import, which never had one. They count in the totals above '
        + 'but cannot be placed on the chart. Add a finish date and a row moves into its month.'),
      h('ul.log-list', undated
        .slice().sort((a, b) => (b.date_added || '').localeCompare(a.date_added || ''))
        .map(t => logRow(t, { showAdded: true }))),
    ) : null,
  );
}

function stat(value, label, note) {
  return h('div.log-stat',
    h('span.log-stat-v.tabular', String(value)),
    h('span.log-stat-l', label),
    note ? h('span.log-stat-n', note) : null);
}

function legend(keys = SOURCE_ORDER) {
  return h('span.chart-legend', keys.map(k =>
    h('span.legend-item', h('span', { class: `swatch bar-${k}` }), SOURCE_LABEL[k])));
}

function daysSince(iso) {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 86400000));
}

function logRow(t, { showOpenFor = false, showAdded = false } = {}) {
  const meta = [authorLine(t), t.year || null, t.type !== 'article' ? t.type : null,
    t.pages ? `${t.pages} pp` : null].filter(Boolean);
  const open = showOpenFor && t.date_started ? daysSince(t.date_started) : null;
  const verdict = (t.verdict || '').trim();
  return h('li.log-item',
    h('div.log-main',
      h('a', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title || '(untitled)'),
      meta.length ? h('span.meta', meta.join(' · ')) : null,
      verdict ? h('p.log-verdict', verdict) : null),
    h('div.log-side',
      t.assessment === 'good' ? h('span.tag.good', 'Good') : null,
      t.assessment === 'bad' ? h('span.tag.bad', 'Bad') : null,
      t.status === 'abandoned' ? h('span.tag.abandoned', 'Abandoned') : null,
      h('span.dim.small.tabular',
        open != null ? `open ${open}d`
          : showAdded ? `added ${t.date_added || '—'}`
            : (t.date_finished || '')),
    ));
}

const REREAD_KIND_LABEL = Object.fromEntries(REREAD_KINDS);

function rereadRow({ t, e }) {
  const meta = [authorLine(t), t.year || null, t.pages ? `${t.pages} pp` : null,
    e.hours != null ? `${e.hours}h` : null].filter(Boolean);
  return h('li.log-item.log-reread',
    h('div.log-main',
      h('a', { href: `#/text/${encodeURIComponent(t.id)}` }, t.title || '(untitled)'),
      meta.length ? h('span.meta', meta.join(' · ')) : null,
      e.reason ? h('p.log-verdict', e.reason) : null),
    h('div.log-side',
      h('span.tag.reread', e.kind && e.kind !== 'other' ? `Reread · ${REREAD_KIND_LABEL[e.kind]}` : 'Reread'),
      h('span.dim.small.tabular', e.date)));
}
