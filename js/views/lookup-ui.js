// Shared lookup panel, used when adding a text and when enriching one.

import { h, mount } from '../dom.js';
import { state } from '../store.js';
import { lookup, describe, classifyQuery, authorsAgree, rankCandidates } from '../lookup.js';

export function lookupEnabled() {
  return state.prefs.lookup !== false;
}

/**
 * @param {(candidate: object) => void} onPick
 * @param {{placeholder?: string, compareTo?: object, authorHint?: () => string}} opts
 *
 * `compareTo` is the row being enriched. When it has authors and a candidate
 * does not share one, the candidate is marked: a review, reply or symposium
 * piece carries its subject's title and is otherwise indistinguishable in a
 * result list.
 */
export function lookupPanel(onPick, opts = {}) {
  if (!lookupEnabled()) {
    return h('p.hint', 'Metadata lookup is switched off in Settings.');
  }

  const status = h('p.hint.lookup-status');
  const results = h('div.lookup-results');
  const input = h('input.lookup-input', {
    type: 'text',
    placeholder: opts.placeholder || 'DOI, ISBN, JSTOR link, or title…',
    'aria-label': 'DOI, ISBN, or title to look up',
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); go(); } },
  });

  let seq = 0;
  async function go() {
    const raw = input.value.trim();
    const q = classifyQuery(raw);
    if (q.kind === 'empty') { input.focus(); return; }
    const mine = ++seq;
    mount(results);
    status.className = 'hint lookup-status';
    status.textContent = q.kind === 'title'
      ? 'Searching Crossref and OpenLibrary…'
      : q.via
        ? `${q.via} link → DOI ${q.value}…`
        : `Looking up ${q.kind.toUpperCase()} ${q.value}…`;
    let found;
    try {
      const author = opts.compareTo
        ? (opts.compareTo.authors || [])[0]
        : (opts.authorHint ? opts.authorHint() : '');
      found = await lookup(raw, { author });
      // Rank against the row being enriched when there is one, and against what
      // was typed when there is not — adding a new text has no existing row to
      // compare with, but the title just entered is a perfectly good hint, and
      // without it Crossref's own relevance order buries the obvious match.
      found = rankCandidates(found, opts.compareTo || { title: q.value, authors: author ? [author] : [] });
    } catch (err) {
      if (mine !== seq) return;
      status.className = 'hint lookup-status bad';
      status.textContent = `${err.message} Nothing was changed — you can still type the details in.`;
      return;
    }
    if (mine !== seq) return;
    if (!found.length) {
      status.className = 'hint lookup-status';
      status.textContent = q.kind === 'title'
        ? 'No match. Try the DOI or ISBN, or just type the details in.'
        : q.via === 'JSTOR'
          ? `No Crossref record for ${q.value}. Not every JSTOR item has a 10.2307 DOI — try the DOI printed on the article's JSTOR page.`
          : 'No record found for that identifier.';
      return;
    }
    const sources = [...new Set(found.flatMap(c => String(c.source).split(' + ')))].join(' and ');
    status.textContent = found.length === 1
      ? `One match from ${sources}.`
      : `${found.length} matches from ${sources} — pick the right one.`;
    mount(results, found.map(c => {
      const mismatch = opts.compareTo && !authorsAgree(opts.compareTo, c);
      return h(`button.lookup-hit${mismatch ? '.mismatch' : ''}`, {
        type: 'button',
        onclick: () => {
          if (mismatch && !confirm(
            `This record is by ${c.authors.join(', ')}, but the row is by ${(opts.compareTo.authors || []).join(', ')}.\n\n`
            + 'Reviews and replies share their subject\'s title, so this may describe a different work. Use it anyway?')) return;
          onPick(c);
          status.textContent = `Filled from ${c.source}.`;
          mount(results);
        },
      },
        h('span.lookup-title', c.title),
        h('span.lookup-meta', describe(c)),
        mismatch
          ? h('span.lookup-warn',
            'Different author from this row — likely a review or reply, not the work itself.')
          : null);
    }));
  }

  return h('div.lookup',
    h('div.lookup-bar', input, h('button', { type: 'button', onclick: go }, 'Look up')),
    status,
    results,
  );
}
