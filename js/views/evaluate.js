// Evaluate (spec §5.5a, phase 2). Export a document, paste the scores back.
//
// The discipline is Backfill's: nothing is written that was not shown first.
// A paste that scores 68 rows at once is exactly where a silent mistake would
// do the most damage, so the diff is not a courtesy.

import { h, mount } from '../dom.js';
import { state, mutate } from '../store.js';
import {
  buildExport, parseScores, scoreDiff, predictedBlock, promptOf, rubricVersion,
  DEFAULT_PROMPT, CORPUS_SCOPES, TARGET_SCOPES,
} from '../evaluate.js';
import { todayISO } from '../model.js';

let corpusScope = 'pool';
let targetScope = 'unscored';
let parsed = null;          // { rows, errors, warnings } awaiting confirmation
let pasteText = '';
let editingPrompt = false;

export function renderEvaluate(root, ctx) {
  const doc = state.doc;
  const texts = doc.texts || [];
  const corpusN = texts.filter(CORPUS_SCOPES[corpusScope].test).length;
  const targetN = texts.filter(TARGET_SCOPES[targetScope].test).length;
  const version = rubricVersion(doc);

  mount(root,
    h('header.view-head',
      h('h1', 'Evaluate'),
      h('p.counts',
        `${targetN} rows to score · ${corpusN} texts of context · prompt v${version}`),
    ),

    h('p.notice.quiet',
      'Scoring happens in a chat, not in this page. Putting a model API key in localStorage on '
      + 'a publicly served site would be a second credential, and unlike the GitHub token it '
      + 'cannot be scoped down to one private repo. Export, paste into a conversation, paste the '
      + 'result back.'),

    contextWarnings(doc),
    promptCard(doc, version, ctx),
    exportCard(doc, corpusN, targetN, ctx),
    pasteCard(doc, version, ctx),
  );
}

/** The evaluation is only as good as what it is told; say so before exporting. */
function contextWarnings(doc) {
  const problems = [];
  const projects = doc.projects || [];
  if (!projects.length) {
    problems.push('No projects recorded, so relative value will come back null for every row.');
  } else {
    const noSummary = projects.filter(p => !(p.summary || '').trim());
    if (noSummary.length) {
      problems.push(`${noSummary.length} project(s) have no summary — a title and a list of ids `
        + 'says nothing about what a candidate text would contribute.');
    }
  }
  const reader = doc.reader || {};
  if (!reader.standing_interests) problems.push('No standing interests recorded for the reader.');
  const marked = (doc.texts || []).filter(t => t.assessment).length;
  if (!marked) {
    problems.push('No texts carry a good/bad mark yet, so the scale has nothing anchoring it to '
      + 'your judgment. A handful at each end is worth more than a hundred in the middle.');
  }
  if (!problems.length) return null;
  return h('div.notice.warn',
    h('p', h('strong', 'Context gaps.'), ' The evaluation can only reason from what it is given:'),
    h('ul', problems.map(p => h('li', p))));
}

function promptCard(doc, version, ctx) {
  const current = promptOf(doc);
  const stored = ((doc.rubric || {}).prose || '').trim();
  const unsaved = !stored;
  if (!editingPrompt) {
    return h(`details.card${unsaved ? '.unsaved-prompt' : ''}`, { open: unsaved },
      h('summary', `Prompt — version ${version}${unsaved ? ' · NOT SAVED' : ''}`),
      unsaved
        ? h('p.notice.warn',
          'This is the built-in default and nothing is stored in the file, so any score written '
          + `as version ${version} points at text that could change under it. Save it to pin the `
          + 'version — that is what makes a later pass commensurable with an earlier one.',
          h('div.actions',
            h('button.primary', {
              onclick: () => {
                mutate(d => {
                  d.rubric = { version: rubricVersion(d), date: todayISO(), prose: promptOf(d) };
                });
                ctx.toast(`Prompt pinned as version ${rubricVersion(state.doc)}.`);
                ctx.rerender();
              },
            }, `Save this as version ${version}`)))
        : null,
      h('p.hint', 'The instrument, not a passing instruction: the same text every pass, so ten '
        + 'rows scored in March are commensurable with sixty scored in January. Edit it when an '
        + 'audit or the calibration view gives you a named bias to write against — not because a '
        + 'single score looked wrong.'),
      h('pre.dump', current),
      h('div.actions',
        h('button', { onclick: () => { editingPrompt = true; ctx.rerender(); } }, 'Edit prompt')));
  }
  const box = h('textarea.dump', { rows: 20, value: current });
  return h('section.card',
    h('h2', `Prompt — version ${version}`),
    box,
    h('p.hint', 'Saving bumps the version. Every score already written keeps the version it was '
      + 'produced under, so the calibration view can tell generations apart.'),
    h('div.actions',
      h('button.primary', {
        onclick: () => {
          const text = box.value.trim();
          if (!text) { alert('The prompt cannot be empty.'); return; }
          // Compare against what is STORED, not against what is displayed. They
          // differ on the first save, when the box shows the built-in default
          // and the file holds nothing: comparing to the displayed text made
          // "open the editor and press save" a silent no-op, which is precisely
          // how someone pins version 1.
          const stored = ((state.doc.rubric || {}).prose || '').trim();
          if (text === stored) { editingPrompt = false; ctx.rerender(); return; }
          // First save is version 1, not 2 — scores already written under the
          // default carry rubric_version 1 and must keep pointing at real text.
          mutate(d => {
            const next = stored ? rubricVersion(d) + 1 : rubricVersion(d);
            d.rubric = { version: next, date: todayISO(), prose: text };
          });
          editingPrompt = false;
          ctx.toast(`Prompt saved as version ${rubricVersion(state.doc)}.`);
          ctx.rerender();
        },
      }, 'Save prompt'),
      h('button', { onclick: () => { editingPrompt = false; ctx.rerender(); } }, 'Cancel'),
      h('button', {
        onclick: () => { box.value = DEFAULT_PROMPT; },
      }, 'Reset to the default text')));
}

function exportCard(doc, corpusN, targetN, ctx) {
  const text = buildExport(doc, { corpusScope, targetScope });
  const bytes = new TextEncoder().encode(text).length;
  return h('section.card',
    h('h2', 'Export'),
    h('div.controls',
      sel('Context', corpusScope, CORPUS_SCOPES, doc, v => { corpusScope = v; ctx.rerender(); }),
      sel('To score', targetScope, TARGET_SCOPES, doc, v => { targetScope = v; ctx.rerender(); }),
      h('span.spacer'),
      h('span.hint.dim', `${corpusN} context · ${targetN} to score · ${fmtBytes(bytes)}`),
    ),
    targetN === 0
      ? h('p.notice.quiet', 'Nothing to score in this scope.')
      : h('div.actions',
        h('button.primary', {
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(text);
              ctx.toast(`Copied ${fmtBytes(bytes)} to the clipboard.`);
            } catch {
              ctx.toast('Clipboard blocked — use Download instead.');
            }
          },
        }, 'Copy to clipboard'),
        h('button', {
          onclick: () => download(text, `evaluation-request-${todayISO()}.md`),
        }, 'Download'),
      ),
    h('details',
      h('summary.small', 'Preview'),
      h('pre.dump', text.slice(0, 4000) + (text.length > 4000 ? '\n\n…truncated in preview…' : ''))),
  );
}

function sel(label, value, scopes, doc, onchange) {
  return h('label.sel', h('span.sr-only', label),
    h('select', { 'aria-label': label, onchange: e => onchange(e.target.value) },
      Object.entries(scopes).map(([k, v]) =>
        h('option', { value: k, selected: k === value },
          `${label}: ${v.label} (${(doc.texts || []).filter(v.test).length})`))));
}

function pasteCard(doc, version, ctx) {
  const box = h('textarea.dump', {
    rows: 6, placeholder: 'Paste the JSON array back here…', value: pasteText,
    oninput: e => { pasteText = e.target.value; },
  });

  return h('section.card',
    h('h2', 'Paste the scores back'),
    box,
    h('div.actions',
      h('button.primary', {
        onclick: () => {
          parsed = parseScores(box.value, doc);
          ctx.rerender();
        },
      }, 'Check it'),
      parsed ? h('button', { onclick: () => { parsed = null; ctx.rerender(); } }, 'Clear') : null,
    ),
    parsed ? review(parsed, version, ctx) : null,
  );
}

function review({ rows, errors, warnings }, version, ctx) {
  const applicable = rows.filter(r => scoreDiff(r).length);
  return h('div.review',
    errors.length
      ? h('div.notice.warn',
        h('p', h('strong', `${errors.length} problem${errors.length === 1 ? '' : 's'}.`),
          ' Nothing will be written for these:'),
        h('ul', errors.slice(0, 12).map(e => h('li', e))),
        errors.length > 12 ? h('p.hint', `…and ${errors.length - 12} more.`) : null)
      : null,
    warnings.length
      ? h('details',
        h('summary.small', `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`),
        h('ul', warnings.map(w => h('li.hint', w))))
      : null,

    rows.length
      ? [
        h('p.hint', `${applicable.length} of ${rows.length} rows would change. `
          + 'Every field is shown before anything is written.'),
        h('ul.eval-rows', rows.slice(0, 60).map(r => {
          const diff = scoreDiff(r);
          return h('li.eval-row',
            h('div.eval-head',
              h('a', { href: `#/text/${encodeURIComponent(r.id)}` }, r.row.title || r.id),
              diff.length ? null : h('span.dim.small', ' — no change')),
            r.reasonAbs ? h('p.eval-reason', h('span.dim', 'abs: '), r.reasonAbs) : null,
            r.reasonRel ? h('p.eval-reason', h('span.dim', 'rel: '), r.reasonRel) : null,
            // Only complain about a missing reason for an axis that was actually scored;
            // a relative-only pass is not silent about absolute, it is not asked.
            (r.given.value_abs && !r.reasonAbs) ? h('p.hint.dim', 'no absolute reason given') : null,
            diff.length
              ? h('ul.diff', diff.map(d => h('li',
                h('span.diff-field', d.field), ' ',
                h('span.diff-from', d.from == null ? '—' : String(d.from)),
                ' → ', h('span.diff-to', String(d.to)))))
              : null);
        })),
        rows.length > 60 ? h('p.hint', `…and ${rows.length - 60} more not previewed.`) : null,
        h('div.actions',
          h('button.primary', {
            disabled: !applicable.length,
            onclick: () => {
              if (!confirm(`Write scores to ${applicable.length} rows, as prompt version ${version}?`)) return;
              mutate(d => {
                for (const entry of applicable) {
                  const row = d.texts.find(x => x.id === entry.id);
                  if (row) row.predicted = predictedBlock(entry, version);
                }
              });
              const n = applicable.length;
              parsed = null;
              pasteText = '';
              ctx.toast(`Wrote ${n} score${n === 1 ? '' : 's'}. The queue now sorts by priority.`);
              ctx.rerender();
            },
          }, `Apply ${applicable.length} row${applicable.length === 1 ? '' : 's'}`)),
      ]
      : null,
  );
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
