// Modals: quick-log, new text, conflict. Native <dialog> gives the focus trap
// and Esc handling without a library.

import { h } from '../dom.js';
import { state, mutate, serialize, resolveConflictTakeRemote, resolveConflictForceLocal, save } from '../store.js';
import { newText, slugify, uniqueId, todayISO, TYPES } from '../model.js';
import { lookupPanel } from './lookup-ui.js';

/**
 * Not all engines fire `close` when close() is called from script rather than
 * by the user, so removal cannot hang off that event: dialogs would pile up in
 * the DOM, and one left behind in the open state would silently swallow every
 * keyboard shortcut (app.js suppresses them while a modal is up). Teardown is
 * therefore explicit, and `close`/`cancel` are only a backstop for Esc.
 */
function openDialog(...content) {
  const dlg = h('dialog.modal', h('div.modal-body', content));
  dlg.destroy = () => {
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
    document.dispatchEvent(new CustomEvent('modal-closed'));
  };
  document.body.append(dlg);
  dlg.addEventListener('cancel', () => setTimeout(() => dlg.destroy(), 0));
  dlg.addEventListener('close', () => dlg.destroy());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.destroy(); });
  dlg.showModal();
  const first = dlg.querySelector('input, textarea, select, button');
  if (first) first.focus();
  return dlg;
}

function addText(partial) {
  const taken = new Set((state.doc.texts || []).map(t => t.id));
  const id = uniqueId(slugify(partial.title), taken);
  const row = newText({ ...partial, id });
  mutate(d => { d.texts.push(row); });
  return row;
}

/**
 * Quick-log (spec §5.3). Two fields, and everything else backfillable.
 *
 * This is the smallest screen in the app and the spec argues it carries the
 * most weight: off-list reads were never scored by the model, so they are the
 * only calibration data not selected by the thing being tested. If it takes
 * longer than two fields it will not happen at the moment of capture.
 */
export function quickLog(ctx) {
  const title = h('input', { type: 'text', required: true, placeholder: 'Title', 'aria-label': 'Title' });
  const author = h('input', { type: 'text', placeholder: 'Author (optional)', 'aria-label': 'Author' });

  const submit = () => {
    const v = title.value.trim();
    if (!v) { title.focus(); return; }
    const row = addText({
      title: v,
      authors: author.value.trim() ? [author.value.trim()] : [],
      status: 'read',
      source: 'off-list',
      date_added: todayISO(),
      date_finished: todayISO(),
      source_notes: 'quick-log',
    });
    dlg.destroy();
    ctx.go(`#/text/${encodeURIComponent(row.id)}`);
  };

  const form = h('form', { onsubmit: e => { e.preventDefault(); submit(); } },
    h('h2', 'Log something you read'),
    h('p.hint', 'Two fields. Everything else can be filled in later — or never.'),
    h('div.fields', h('div.field.wide', title), h('div.field.wide', author)),
    h('p.hint', 'Saved as ', h('code', 'read'), ' / ', h('code', 'off-list'),
      ' — reading the model never ranked, which makes it the most useful calibration data you have.'),
    h('div.actions',
      h('button.primary', { type: 'submit' }, 'Log it'),
      h('button', { type: 'button', onclick: () => dlg.destroy() }, 'Cancel')),
  );
  const dlg = openDialog(form);
  return dlg;
}

/** New queued text, with optional metadata lookup. */
export function newTextDialog(ctx) {
  const title = h('input', { type: 'text', required: true, placeholder: 'Title', 'aria-label': 'Title' });
  const author = h('input', { type: 'text', placeholder: 'Authors, comma separated', 'aria-label': 'Authors' });
  const year = h('input', { type: 'number', min: 0, max: 3000, placeholder: 'Year', 'aria-label': 'Year' });
  const type = h('select', { 'aria-label': 'Type' }, TYPES.map(t => h('option', { value: t }, t)));

  // Anything the lookup knows that the four visible fields cannot hold.
  let extra = {};

  const panel = lookupPanel((c) => {
    title.value = c.title || title.value;
    if (c.authors && c.authors.length) author.value = c.authors.join(', ');
    if (c.year) year.value = c.year;
    if (c.type) type.value = c.type;
    extra = {};
    if (c.container) extra.container = c.container;
    if (c.journal) extra.journal = c.journal;
    if (c.pages) extra.pages = c.pages;
    if (c.doi) extra.doi = c.doi;
    if (c.isbn) extra.isbn = c.isbn;
    title.focus();
  }, {
    // Whatever is already typed into the author box narrows the search, which is
    // what lets a book's Crossref record and its OpenLibrary page count merge.
    authorHint: () => (author.value.split(',')[0] || '').trim(),
  });

  const submit = () => {
    const v = title.value.trim();
    if (!v) { title.focus(); return; }
    const row = addText({
      title: v,
      authors: author.value.split(',').map(x => x.trim()).filter(Boolean),
      year: year.value ? Number(year.value) : null,
      type: type.value,
      status: 'queued',
      source: 'queue',
      container: extra.container || null,
      extra: Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'container')),
    });
    dlg.destroy();
    ctx.go(`#/text/${encodeURIComponent(row.id)}`);
  };

  const form = h('form', { onsubmit: e => { e.preventDefault(); submit(); } },
    h('h2', 'Add to the queue'),
    panel,
    h('p.hint', 'Or type it in directly.'),
    h('div.fields',
      h('div.field.wide', title),
      h('div.field.wide', author),
      h('div.field', year),
      h('div.field', type)),
    h('div.actions',
      h('button.primary', { type: 'submit' }, 'Add'),
      h('button', { type: 'button', onclick: () => dlg.destroy() }, 'Cancel')),
  );
  const dlg = openDialog(form);
  return dlg;
}

/**
 * Conflict (spec §2). Refetch, say plainly what happened, hand over the pending
 * edits as copyable JSON. No automatic merge is offered because none is safe.
 */
export function conflictDialog(ctx) {
  const c = state.conflict;
  if (!c) return null;
  const dump = h('textarea.dump', { readonly: true, rows: 10, value: c.localText || serialize() });

  const dlg = openDialog(
    h('h2', 'This file changed on another device'),
    h('p', 'GitHub rejected the save because ', h('code', 'data.json'),
      ' has moved on since this device loaded it. Nothing has been overwritten, and nothing has been merged automatically — a wrong merge on a single-file store loses rows silently.'),
    c.remoteText
      ? h('p.hint', `The copy now on GitHub has ${countTexts(c.remoteText)} texts; this device has ${(state.doc.texts || []).length}.`)
      : h('p.hint', 'The current remote copy could not be fetched, so only your local version is shown below.'),
    h('p', h('strong', 'Your unsaved version, in full:')),
    dump,
    h('div.actions',
      h('button', {
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(dump.value);
            ctx.toast('Copied your version to the clipboard.');
          } catch {
            dump.select();
            ctx.toast('Select-all and copy — the clipboard was blocked.');
          }
        },
      }, 'Copy my version'),
      h('button', {
        onclick: () => { downloadText(dump.value, 'data-local-conflict.json'); },
      }, 'Download my version'),
      h('span.spacer'),
      c.remoteText
        ? h('button', {
          onclick: () => {
            if (!confirm('Discard this device’s edits and load the copy from GitHub?')) return;
            resolveConflictTakeRemote();
            dlg.destroy();
            ctx.rerender();
          },
        }, 'Discard mine, take GitHub’s')
        : null,
      h('button.danger', {
        onclick: async () => {
          if (!confirm('Overwrite the copy on GitHub with this device’s version?')) return;
          resolveConflictForceLocal();
          dlg.destroy();
          await save({ message: 'Overwrite after conflict (local version kept)' });
          ctx.rerender();
        },
      }, 'Keep mine, overwrite GitHub'),
    ),
  );
  return dlg;
}

function countTexts(text) {
  try { return (JSON.parse(text).texts || []).length; } catch { return '?'; }
}

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Keyboard help. */
export function helpDialog() {
  const keys = [
    ['g then q', 'Queue'], ['g then t', 'Triage'], ['g then b', 'Backfill'], ['g then p', 'Pool'], ['g then e', 'Evaluate'],
    ['g then s', 'Settings'],
    ['/', 'Focus search'], ['n', 'New text'], ['l', 'Quick-log'],
    ['j / k', 'Move down / up the list'], ['Enter', 'Open the focused row'],
    ['1 / 2 / 0', 'Queue: mark the focused read row good / bad / unmarked'],
    ['1 – 5', 'Backfill: accept that match'], ['s / x / u', 'Backfill: skip / nothing to find / undo'],
    ['Cmd/Ctrl S', 'Save now'], ['?', 'This help'], ['Esc', 'Close'],
  ];
  return openDialog(
    h('h2', 'Keyboard'),
    h('dl.keys', keys.flatMap(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])),
    h('div.actions', h('button.primary', { onclick: e => e.target.closest('dialog').destroy() }, 'Close')),
  );
}
