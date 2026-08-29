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
import { authorLine, sortKeyTitle, STATUS_LABEL } from '../model.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SOURCE_ORDER = ['queue', 'off-list', 'coursework'];
const SOURCE_LABEL = {
  queue: 'From the queue',
  'off-list': 'Off-list',
  coursework: 'Coursework',
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

export function renderLog(root, ctx) {
  const texts = (state.doc && state.doc.texts) || [];
  const finished = texts.filter(t => t.status === 'read' || t.status === 'abandoned');
  const dated = finished.filter(t => t.date_finished);
  const undated = finished.filter(t => !t.date_finished);
  const reading = texts.filter(t => t.status === 'reading');

  if (!finished.length) {
    mount(root,
      h('header.view-head', h('h1', 'Log')),
      h('div.empty', h('p', 'Nothing is finished yet. This fills up as you mark things read.')));
    return;
  }

  const byMonth = new Map();
  for (const t of dated) {
    const k = t.date_finished.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(t);
  }
  const monthKeys = dated.length
    ? monthSpan([...byMonth.keys()].sort()[0], [...byMonth.keys()].sort().at(-1))
    : [];

  const counts = {};
  const pages = {};
  for (const key of SOURCE_ORDER) { counts[key] = {}; pages[key] = {}; }
  for (const t of dated) {
    const k = t.date_finished.slice(0, 7);
    const src = SOURCE_ORDER.includes(t.source) ? t.source : 'queue';
    counts[src][k] = (counts[src][k] || 0) + 1;
    pages[src][k] = (pages[src][k] || 0) + (t.pages || 0);
  }

  const pagesTotal = dated.reduce((s, t) => s + (t.pages || 0), 0);
  const withPages = dated.filter(t => t.pages).length;
  const good = finished.filter(t => t.assessment === 'good').length;
  const bad = finished.filter(t => t.assessment === 'bad').length;
  const perMonth = monthKeys.length ? (dated.length / monthKeys.length) : 0;

  mount(root,
    h('header.view-head',
      h('h1', 'Log'),
      h('p.counts',
        `${finished.length} finished · ${dated.length} with a date · `,
        undated.length ? `${undated.length} without` : 'all dated'),
    ),

    h('div.log-stats',
      stat(dated.length, 'dated', monthKeys.length ? `over ${monthKeys.length} months` : null),
      stat(perMonth ? perMonth.toFixed(1) : '—', 'per month', 'average across the span'),
      stat(pagesTotal ? pagesTotal.toLocaleString() : '—', 'pages',
        withPages ? `from ${withPages} rows that record them` : 'none recorded'),
      stat(`${good}/${bad}`, 'good / bad', `${finished.length - good - bad} unmarked`),
    ),

    dated.length ? h('section.card',
      h('div.card-head', h('h2', 'Texts finished'), legend()),
      barChart({
        months: monthKeys, stacks: counts, keys: SOURCE_ORDER, labelOf: monthLabel,
        valueLabel: 'Texts finished',
        summary: `${dated.length} texts across ${monthKeys.length} months.`,
      }),
    ) : null,

    withPages ? h('section.card',
      h('div.card-head', h('h2', 'Pages finished'), legend()),
      barChart({
        months: monthKeys, stacks: pages, keys: SOURCE_ORDER, labelOf: monthLabel,
        valueLabel: 'Pages finished',
        summary: `${pagesTotal} pages across ${monthKeys.length} months.`,
      }),
      h('p.hint', `Only ${withPages} of ${dated.length} dated rows record a page count, so this `
        + 'is a floor, not a total.'),
    ) : null,

    reading.length ? h('section.card',
      h('h2', `Open now — ${reading.length}`),
      h('ul.log-list', reading
        .slice().sort((a, b) => (a.date_started || '9999').localeCompare(b.date_started || '9999'))
        .map(t => logRow(t, { showOpenFor: true }))),
    ) : null,

    ...[...byMonth.keys()].sort().reverse().map(k => h('section.card',
      h('div.card-head',
        h('h2', monthLabel(k)),
        h('span.dim.small', `${byMonth.get(k).length} · ${byMonth.get(k).reduce((s, t) => s + (t.pages || 0), 0) || '—'} pp`)),
      h('ul.log-list', byMonth.get(k)
        .slice().sort((a, b) => (b.date_finished || '').localeCompare(a.date_finished || '')
          || sortKeyTitle(a).localeCompare(sortKeyTitle(b)))
        .map(t => logRow(t))),
    )),

    undated.length ? h('details.card.log-undated',
      h('summary', `${undated.length} finished with no date`),
      h('p.hint', 'Mostly the original import, which never had one. They are real reading and '
        + 'count in the totals above; they simply cannot be placed on the chart. Add a finish '
        + 'date on any row and it moves up into its month.'),
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

function legend() {
  return h('span.chart-legend', SOURCE_ORDER.map(k =>
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
