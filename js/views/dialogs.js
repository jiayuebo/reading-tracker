// Modals: quick-log, new text, conflict. Native <dialog> gives the focus trap
// and Esc handling without a library.

import { h, mount } from '../dom.js';
import { state, mutate, serialize, resolveConflictTakeRemote, resolveConflictForceLocal, save } from '../store.js';
import { newText, slugify, uniqueId, todayISO, TYPES, childIndex, fold } from '../model.js';
import { lookupPanel, lookupEnabled } from './lookup-ui.js';
import { rowPicker } from './row-picker.js';
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
  const texts = (state.doc && state.doc.texts) || [];

  const title = h('input', { type: 'text', required: true, placeholder: 'Title', 'aria-label': 'Title' });
  const authors = h('textarea', { rows: 2, placeholder: 'One per line' });
  const year = h('input', { type: 'number', min: 0, max: 3000 });
  const type = h('select', TYPES.map(x => h('option', { value: x }, x)));
  type.value = 'article';
  const journal = h('input', { type: 'text', placeholder: 'e.g. Nous' });
  const container = h('input', { type: 'text', placeholder: 'e.g. Critique of Pure Reason' });
  const pages = h('input', { type: 'number', min: 0 });
  const estHours = h('input', { type: 'number', min: 0, step: 0.25 });
  const familiarity = h('select',
    [['', '—'], ['0', '0 unfamiliar'], ['1', '1 some'], ['2', '2 good'], ['3', '3 expert']]
      .map(([v, l]) => h('option', { value: v }, l)));
  const verdict = h('textarea', { rows: 2 });

  const flagBoxes = {
    notes_written: h('input', { type: 'checkbox' }),
    carded: h('input', { type: 'checkbox' }),
    reread_wanted: h('input', { type: 'checkbox' }),
  };

  // Both on by default, because the common case is logging something the
  // moment you finish it. Unticking is for the other case — reconstructing a
  // read from memory, where inventing a date would be worse than leaving it
  // blank. A null date is an ordinary state here, not a gap to be filled.
  const startedBox = h('input', { type: 'checkbox', checked: true });
  const finishedBox = h('input', { type: 'checkbox', checked: true });

  let assessment = null;
  const markBtns = h('span.ql-marks');
  const paintMarks = () => {
    mount(markBtns,
      h(`button.small${assessment === 'good' ? '.primary' : ''}`, {
        type: 'button', onclick: () => { assessment = assessment === 'good' ? null : 'good'; paintMarks(); },
      }, 'Good'),
      h(`button.small${assessment === 'bad' ? '.primary' : ''}`, {
        type: 'button', onclick: () => { assessment = assessment === 'bad' ? null : 'bad'; paintMarks(); },
      }, 'Bad'),
    );
  };
  paintMarks();

  let parentId = null;
  const picker = rowPicker({
    texts, value: null, banned: new Set(),
    placeholder: 'Type to find a parent…',
    onChange: (id) => { parentId = id || null; },
  });

  let extra = {};
  const captured = h('p.hint.dim');
  // The field is singular in spirit even as a list, and philosophers write
  // themselves surname-first, so typed text is split on newlines, never commas.
  const panel = lookupEnabled()
    ? lookupPanel((c) => {
      if (c.title) title.value = c.title;
      if (c.authors && c.authors.length) authors.value = c.authors.join('\n');
      if (c.year) year.value = c.year;
      if (c.type) type.value = c.type;
      if (c.journal) journal.value = c.journal;
      if (c.container) container.value = c.container;
      if (c.pages) pages.value = c.pages;
      extra = {};
      if (c.doi) extra.doi = c.doi;
      if (c.isbn) extra.isbn = c.isbn;
      captured.textContent = c.doi ? `DOI ${c.doi} captured.` : (c.isbn ? `ISBN ${c.isbn} captured.` : '');
      title.focus();
    }, {
      authorHint: () => (authors.value.split('\n')[0] || '').trim(),
      placeholder: 'DOI, ISBN, JSTOR link, or title…',
    })
    : h('p.hint', 'Metadata lookup is switched off in Settings.');

  const submit = () => {
    const v = title.value.trim();
    if (!v) { title.focus(); return; }
    const row = addText({
      title: v,
      authors: authors.value.split('\n').map(x => x.trim()).filter(Boolean),
      year: year.value === '' ? null : Number(year.value),
      type: type.value,
      parent_id: parentId,
      // A linked parent wins over the free-text one, so never store both.
      container: parentId ? null : (container.value.trim() || null),
      status: 'read',
      source: 'off-list',
      date_added: todayISO(),
      date_started: startedBox.checked ? todayISO() : null,
      date_finished: finishedBox.checked ? todayISO() : null,
      source_notes: 'quick-log',
      extra: {
        ...extra,
        ...(journal.value.trim() ? { journal: journal.value.trim() } : {}),
        ...(pages.value === '' ? {} : { pages: Number(pages.value) }),
        ...(estHours.value === '' ? {} : { est_hours: Number(estHours.value) }),
        ...(familiarity.value === '' ? {} : { familiarity: Number(familiarity.value) }),
        ...(verdict.value.trim() ? { verdict: verdict.value.trim() } : {}),
        // Sparse: a flag goes in only when it is true. Absent is not false.
        ...Object.fromEntries(Object.entries(flagBoxes)
          .filter(([, box]) => box.checked).map(([k]) => [k, true])),
        ...(assessment ? { assessment } : {}),
      },
    });
    dlg.destroy();
    ctx.go(`#/text/${encodeURIComponent(row.id)}`);
  };

  const form = h('form.quicklog', { onsubmit: e => { e.preventDefault(); submit(); } },
    h('h2', 'Log something you read'),
    panel,
    captured,
    h('div.ql-grid',
      qlField('Title', title, 6),
      qlField('Authors', authors, 3),
      qlField('Year', year, 1),
      qlField('Type', type, 2),
      qlField('Journal', journal, 3),
      qlField('Nest under', picker, 3),
      qlField('Parent title, unlinked', container, 3),
      qlField('Pages', pages, 1),
      qlField('Est. hours', estHours, 1),
      qlField('Familiarity', familiarity, 1),
      qlField('Verdict', verdict, 6),
    ),
    h('div.ql-toggles',
      markBtns,
      h('span.ql-checks',
        h('label.check', flagBoxes.notes_written, h('span', 'Notes')),
        h('label.check', flagBoxes.carded, h('span', 'Cards')),
        h('label.check', flagBoxes.reread_wanted, h('span', 'Reread')),
        h('label.check', startedBox, h('span', 'Started today')),
        h('label.check', finishedBox, h('span', 'Finished today'))),
    ),
    h('div.actions',
      h('button.primary', { type: 'submit' }, 'Log it'),
      h('button', { type: 'button', onclick: () => dlg.destroy() }, 'Cancel')),
  );

  const dlg = openDialog(form);
  // openDialog focuses the first control, which is the lookup box. The title is
  // what this screen is for, so take it back.
  title.focus();
  return dlg;
}

function qlField(label, control, span) {
  control.id = control.id || `ql-${label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '')}`;
  control.setAttribute('aria-label', label);
  return h(`div.ql-field.span-${span}`, h('label', { for: control.id }, label), control);
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
  /**
   * Everything already sitting under this book — read fresh on every use, not
   * captured when the dialog opens.
   *
   * Two ways a chapter attaches to its book and the duplicate check only knew
   * one of them. `parent_id` is the real link; a row logged through quick-log
   * carries the book's name in `container` instead, with no parent_id at all,
   * so the Critique's five quick-logged sections were invisible here and came
   * back as second copies of themselves.
   */
  const kidsNow = () => {
    const texts = state.doc.texts || [];
    const linked = childIndex(texts).get(book.id) || [];
    const want = fold(book.title || '');
    const named = want
      ? texts.filter(t => !t.parent_id && t.container && fold(t.container) === want)
      : [];
    return linked.concat(named);
  };
  let kids = kidsNow();
  const status = h('p.hint', 'Asking Crossref…');
  const list = h('div.chapter-list');
  const countLine = h('p.hint.dim');
  const addBtn = h('button.primary', { type: 'button', disabled: true }, 'Add selected');

  let found = [];
  let boxes = [];
  // Rows already under this book whose number the fetched list would change.
  // Without this the fix would only reach chapters imported from now on, and
  // an existing contents list would stay stuck in alphabetical order.
  let renumber = [];
  let adding = false;
  const renumberBox = h('input', { type: 'checkbox', checked: true, onchange: () => refreshCount() });
  const renumberWrap = h('label.renumber', { hidden: true });

  const refreshCount = () => {
    const n = boxes.filter(b => b.checked).length;
    const fixing = renumber.length && renumberBox.checked;
    addBtn.disabled = !n && !fixing;
    addBtn.textContent = n
      ? `Add ${n} row${n === 1 ? '' : 's'}${fixing ? ' and renumber' : ''}`
      : (fixing ? `Renumber ${renumber.length} row${renumber.length === 1 ? '' : 's'}` : 'Add selected');
  };

  const add = () => {
    if (adding) return;
    adding = true;
    // The list is re-derived here rather than trusted from render time: this is
    // the last point before rows are written, and it is the only check that
    // cannot be raced.
    kids = kidsNow();
    const picked = boxes.filter(b => b.checked)
      .map(b => found[Number(b.dataset.i)])
      .filter(c => !alreadyHave(kids, c));
    const fixing = renumber.length && renumberBox.checked ? renumber : [];
    if (!picked.length && !fixing.length) { dlg.destroy(); return; }
    const taken = new Set((state.doc.texts || []).map(t => t.id));
    const made = [];
    mutate(d => {
      for (const { id, no } of fixing) {
        const row = d.texts.find(x => x.id === id);
        if (row) row.chapter_no = no;
      }
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
    const bits = [];
    if (made.length) bits.push(`Added ${made.length} row${made.length === 1 ? '' : 's'}`);
    if (fixing.length) bits.push(`${bits.length ? 'n' : 'N'}umbered ${fixing.length} existing row${fixing.length === 1 ? '' : 's'}`);
    ctx.toast(`${bits.join(' and ')} under ${book.title}.`);
    ctx.rerender();
  };

  const render = (via, candidates, certain) => {
    found = candidates;
    kids = kidsNow();
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

    renumber = candidates
      .map(c => ({ have: alreadyHave(kids, c), no: c.chapter_no }))
      .filter(x => x.have && x.no != null && x.have.chapter_no !== x.no)
      .map(x => ({ id: x.have.id, no: x.no }));
    if (renumber.length) {
      renumberWrap.hidden = false;
      mount(renumberWrap, renumberBox, h('span',
        `Also number the ${renumber.length} already recorded, so they sort in the book's order`));
    }
    refreshCount();
  };

  const form = h('div',
    h('h2', 'Find chapters'),
    h('p.hint', 'For ', h('strong', book.title || '(untitled)'), '. New rows are nested under it '
      + 'and inherit its status, so a book marked read gives you chapters marked read.'),
    status,
    list,
    countLine,
    renumberWrap,
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
    ['g then q', 'Queue'], ['g then t', 'Triage'], ['g then l', 'Log'], ['g then v', 'Verdicts'], ['g then r', 'Projects'], ['g then b', 'Backfill'], ['g then p', 'Pool'], ['g then u', 'Subjects'], ['g then e', 'Evaluate'],
    ['g then s', 'Settings'],
    ['/', 'Focus search'], ['n', 'New text'], ['l', 'Quick-log'],
    ['j / k', 'Move down / up the list'], ['Enter', 'Open the focused row'],
    ['1 / 2 / 0', 'Queue: mark the focused read row good / bad / unmarked'],
    ['x', 'Queue: select the focused row for a bulk action'],
    ['1 – 5', 'Backfill: accept that match'], ['s / x / u', 'Backfill: skip / nothing to find / undo'],
    ['Cmd/Ctrl S', 'Save now'], ['?', 'This help'], ['Esc', 'Close'],
  ];
  return openDialog(
    h('h2', 'Keyboard'),
    h('dl.keys', keys.flatMap(([k, v]) => [h('dt', h('kbd', k)), h('dd', v)])),
    h('div.actions', h('button.primary', { onclick: e => e.target.closest('dialog').destroy() }, 'Close')),
  );
}
