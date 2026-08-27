// Modals: quick-log, new text, conflict. Native <dialog> gives the focus trap
// and Esc handling without a library.

import { h, mount } from '../dom.js';
import { state, mutate, serialize, resolveConflictTakeRemote, resolveConflictForceLocal, save } from '../store.js';
import { newText, slugify, uniqueId, todayISO, TYPES, childIndex } from '../model.js';
import { lookupPanel, lookupEnabled } from './lookup-ui.js';
import { findChapters, alreadyHave } from '../lookup.js';

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
  const type = h('select', { 'aria-label': 'Type' }, TYPES.map(x => h('option', { value: x }, x)));
  type.value = 'article';

  // Whatever the lookup knows beyond the visible fields. Kept off-screen
  // rather than adding fields: §5.3's argument is that this screen has to stay
  // a two-field operation or the capture will not happen at all.
  let extra = {};
  const captured = h('p.hint.dim');
  // The field is singular, and philosophers write themselves surname-first, so
  // typed text is never split on commas — "Lewis, David" is one person. Only a
  // picked record has a real author list, and only while the box still holds it
  // verbatim.
  let picked = null;

  const panel = lookupPanel((c) => {
    title.value = c.title || title.value;
    if (c.authors && c.authors.length) {
      author.value = c.authors.join(', ');
      picked = { text: author.value, authors: c.authors };
    }
    if (c.type) type.value = c.type;
    extra = {};
    for (const k of ['year', 'pages', 'doi', 'isbn', 'journal', 'container']) {
      if (c[k] != null) extra[k] = c[k];
    }
    // Say what came along invisibly, or the row silently gains fields the
    // reader never saw and cannot check.
    const bits = [
      c.year, c.pages ? `${c.pages} pp` : null,
      c.journal || c.container, c.doi ? 'DOI' : (c.isbn ? 'ISBN' : null),
    ].filter(Boolean);
    captured.textContent = bits.length ? `Also captured: ${bits.join(' · ')}.` : '';
    title.focus();
  }, {
    authorHint: () => (author.value.split(',')[0] || '').trim(),
    placeholder: 'Optional — DOI, ISBN, JSTOR link, or title…',
  });

  const submit = () => {
    const v = title.value.trim();
    if (!v) { title.focus(); return; }
    const { container, ...rest } = extra;
    const typed = author.value.trim();
    const authors = picked && picked.text === author.value
      ? picked.authors
      : (typed ? [typed] : []);
    const row = addText({
      title: v,
      authors,
      type: type.value,
      container: container || null,
      status: 'read',
      source: 'off-list',
      date_added: todayISO(),
      date_finished: todayISO(),
      source_notes: 'quick-log',
      extra: rest,
    });
    dlg.destroy();
    ctx.go(`#/text/${encodeURIComponent(row.id)}`);
  };

  const form = h('form', { onsubmit: e => { e.preventDefault(); submit(); } },
    h('h2', 'Log something you read'),
    h('p.hint', 'Title, author, type. Everything else can be filled in later — or never.'),
    h('div.fields',
      h('div.field.wide', title),
      h('div.field.wide', author),
      h('div.field.wide', type)),
    captured,
    h('details.quicklog-lookup',
      h('summary.small', 'Look it up instead'),
      h('p.hint', 'Fills the two fields and quietly carries the year, length and identifiers '
        + 'with them. Skip it — a logged row with a bare title beats one you did not log.'),
      panel),
    h('p.hint', 'Saved as ', h('code', 'read'), ' / ', h('code', 'off-list'),
      ' — reading the model never ranked, which makes it the most useful calibration data you have.'),
    h('div.actions',
      h('button.primary', { type: 'submit' }, 'Log it'),
      h('button', { type: 'button', onclick: () => dlg.destroy() }, 'Cancel')),
  );
  // Focus lands on `title` on its own: it is the first control in document
  // order, and the collapsed <details> keeps the lookup box out of the way.
  const dlg = openDialog(form);
  return dlg;
}


/**
 * Pull a book's table of contents from Crossref (spec §5.2).
 *
 * Deliberately a button rather than something that fires on every book: the
 * request only succeeds for books deposited chapter by chapter, and adding a
 * dozen rows to the queue is not a side effect anyone should get by accident.
 * Nothing is written until the confirm; what is already recorded is shown and
 * pre-unticked rather than hidden, so a partial import stays legible.
 */
export function chaptersDialog(book, ctx) {
  const kids = childIndex(state.doc.texts || []).get(book.id) || [];
  const status = h('p.hint', 'Asking Crossref…');
  const list = h('div.chapter-list');
  const countLine = h('p.hint.dim');
  const addBtn = h('button.primary', { type: 'button', disabled: true }, 'Add selected');

  let found = [];
  let boxes = [];

  const refreshCount = () => {
    const n = boxes.filter(b => b.checked).length;
    addBtn.disabled = !n;
    addBtn.textContent = n ? `Add ${n} row${n === 1 ? '' : 's'}` : 'Add selected';
  };

  const add = () => {
    const picked = boxes.filter(b => b.checked).map(b => found[Number(b.dataset.i)]);
    if (!picked.length) return;
    const taken = new Set((state.doc.texts || []).map(t => t.id));
    const made = [];
    mutate(d => {
      for (const c of picked) {
        const id = uniqueId(slugify(c.title), taken);
        taken.add(id);
        const row = newText({
          id,
          title: c.title,
          authors: c.authors && c.authors.length ? c.authors : (book.authors || []),
          year: c.year != null ? c.year : book.year,
          type: c.type === 'section' ? 'section' : 'chapter',
          parent_id: book.id,
          // Chapters of a book you have read are read; of a queued book, queued.
          // Anything else would quietly distort both the queue and the corpus.
          status: book.status,
          source: book.source || 'queue',
          date_added: todayISO(),
          date_finished: book.status === 'read' ? (book.date_finished || todayISO()) : null,
          source_notes: 'crossref-chapters',
          extra: {
            ...(c.pages != null ? { pages: c.pages } : {}),
            ...(c.doi ? { doi: c.doi } : {}),
            ...(c.chapter_no != null ? { chapter_no: c.chapter_no } : {}),
          },
        });
        d.texts.push(row);
        made.push(row);
      }
    });
    dlg.destroy();
    ctx.toast(`Added ${made.length} row${made.length === 1 ? '' : 's'} under ${book.title}.`);
    ctx.rerender();
  };

  const render = (via, candidates, certain) => {
    found = candidates;
    if (!candidates.length) {
      status.className = 'hint';
      status.textContent = book.isbn || book.title
        ? 'Crossref has no chapter records for this book. Most books published before about '
          + '2005, and most trade editions, were never deposited chapter by chapter — there is '
          + 'nothing to find, and the sections have to go in by hand.'
        : 'This row has no ISBN and no title to search with.';
      return;
    }
    status.className = certain ? 'hint' : 'hint warn';
    status.textContent = `${candidates.length} chapter${candidates.length === 1 ? '' : 's'} `
      + `from Crossref, matched on ${via}.`
      + (certain ? '' : ' A title is not an identifier, so check these belong to your edition '
        + 'before ticking any — nothing is selected for you.');

    const dupes = [];
    boxes = candidates.map((c, i) => {
      const have = alreadyHave(kids, c);
      if (have) dupes.push(have);
      const box = h('input', {
        type: 'checkbox', 'data-i': String(i), checked: certain && !have,
        onchange: refreshCount,
      });
      return box;
    });

    mount(list, candidates.map((c, i) => {
      const have = alreadyHave(kids, c);
      return h(`label.chapter-row${have ? '.have' : ''}`,
        boxes[i],
        h('span.chapter-title',
          c.chapter_no != null ? h('span.chapter-no', `${c.chapter_no}`) : null,
          c.title),
        h('span.dim.small',
          [c.pages ? `${c.pages} pp` : null, have ? 'already recorded' : null]
            .filter(Boolean).join(' · ')));
    }));

    countLine.textContent = dupes.length
      ? `${dupes.length} of these are already under this book and are unticked.`
      : '';
    refreshCount();
  };

  const form = h('div',
    h('h2', 'Find chapters'),
    h('p.hint', 'For ', h('strong', book.title || '(untitled)'), '. New rows are nested under it '
      + 'and inherit its status, so a book marked read gives you chapters marked read.'),
    status,
    list,
    countLine,
    h('div.actions',
      addBtn,
      h('button', { type: 'button', onclick: () => dlg.destroy() }, 'Cancel')),
  );
  const dlg = openDialog(form);
  addBtn.onclick = add;

  findChapters(book)
    .then(({ via, candidates, certain }) => { if (dlg.isConnected) render(via, candidates, certain); })
    .catch(err => {
      if (!dlg.isConnected) return;
      status.className = 'hint bad';
      status.textContent = `${err.message} Nothing was added.`;
    });

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
    ['g then q', 'Queue'], ['g then t', 'Triage'], ['g then b', 'Backfill'], ['g then p', 'Pool'], ['g then u', 'Subjects'], ['g then e', 'Evaluate'],
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
