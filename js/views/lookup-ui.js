// Shared lookup panel, used when adding a text and when enriching one.

import { h, mount } from '../dom.js';
import { state } from '../store.js';
import { lookup, describe, classifyQuery, authorsAgree } from '../lookup.js';

export function lookupEnabled() {
  return state.prefs.lookup !== false;
}

/**
 * @param {(candidate: object) => void} onPick
 * @param {{placeholder?: string, compareTo?: object}} opts
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
    placeholder: opts.placeholder || 'DOI, ISBN, or title…',
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
      ? 'Searching Crossref by title…'
      : `Looking up ${q.kind.toUpperCase()} ${q.value}…`;
    let found;
    try {
      found = await lookup(raw);
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
        ? 'No match. Try the DOI, or just type the details in.'
        : 'No record found for that identifier.';
      return;
    }
    status.textContent = found.length === 1
      ? `One match from ${found[0].source}.`
      : `${found.length} matches from ${found[0].source} — pick the right one.`;
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
