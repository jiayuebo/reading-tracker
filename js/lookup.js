// Bibliographic lookup: Crossref for DOIs and title search, OpenLibrary for ISBNs.
//
// ON THE SECURITY CONSTRAINT (spec §2, §9). The rule that matters is "no
// third-party SCRIPT". A <script src> from another origin executes with full
// access to the page and therefore to the token in localStorage; that is the
// change that would make this materially unsafe. A fetch() to a JSON API
// executes nothing. The response is parsed as data and rendered through
// textContent, so a hostile reply is inert.
//
// What it does cost, stated plainly rather than buried:
//   - Crossref and OpenLibrary learn what you are looking up. No token, no
//     identity, and no mailto is sent, so the query is not tied to you.
//   - Two more origins the page can reach. Both are disclosed in Settings and
//     the whole feature can be switched off there.
//
// Nothing here ever overwrites a field that already has a value.

import { fold } from './model.js';

const CROSSREF = 'https://api.crossref.org/works';
const OPENLIBRARY = 'https://openlibrary.org/api/books';
const TIMEOUT_MS = 8000;

export const LOOKUP_ORIGINS = ['api.crossref.org', 'openlibrary.org'];

/** What kind of thing did the user paste? */
export function classifyQuery(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'empty' };

  const doi = s.match(/\b(10\.\d{4,9}\/[^\s"'<>]+)/i);
  if (doi) return { kind: 'doi', value: doi[1].replace(/[.,;)]+$/, '') };

  const digits = s.replace(/[\s-]/g, '');
  if (/^\d{9}[\dXx]$/.test(digits) || /^\d{13}$/.test(digits)) {
    return { kind: 'isbn', value: digits.toUpperCase() };
  }
  return { kind: 'title', value: s };
}

function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('The lookup service did not respond.')), ms)),
  ]);
}

async function getJSON(url) {
  const res = await withTimeout(fetch(url, { headers: { Accept: 'application/json' } }));
  if (!res.ok) {
    if (res.status === 404) throw new Error('Not found.');
    throw new Error(`Lookup failed (HTTP ${res.status}).`);
  }
  return res.json();
}

// ── mapping ─────────────────────────────────────────────────────────

const CROSSREF_TYPE = {
  'journal-article': 'article',
  'proceedings-article': 'article',
  'posted-content': 'article',
  'book-chapter': 'chapter',
  'book-part': 'chapter',
  'book-section': 'section',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
};

function pageCount(page) {
  const m = String(page || '').match(/^(\d+)\s*[-–—]+\s*(\d+)$/);
  if (!m) return null;
  const n = Number(m[2]) - Number(m[1]) + 1;
  return n > 0 && n < 5000 ? n : null;
}

function fromCrossref(w) {
  const authors = (w.author || [])
    .map(a => [a.given, a.family].filter(Boolean).join(' ').trim() || a.name)
    .filter(Boolean);
  const parts = w.issued && w.issued['date-parts'] && w.issued['date-parts'][0];
  const type = CROSSREF_TYPE[w.type] || 'article';
  const containerTitle = (w['container-title'] && w['container-title'][0]) || null;

  // Crossref returns one `container-title` for everything, but it means two
  // different things. For a book chapter it is the book — a genuine parent. For
  // a journal article it is the journal, which is not a parent in any sense:
  // nesting an article under "Nous" groups by venue, which is exactly what this
  // tracker does not care about. Route it by type.
  // Three cases, not two. For a chapter it is the book (a real parent); for an
  // article it is the journal; for a whole book it is a series or a hosting
  // platform - Crossref hands back "Oxford Scholarship Online" - which is
  // neither, and writing that into `journal` would just be noise.
  const isPartOfBook = type === 'chapter' || type === 'section';
  return {
    source: 'Crossref',
    title: (w.title && w.title[0]) || '',
    authors,
    year: parts && parts[0] ? Number(parts[0]) : null,
    type,
    container: isPartOfBook ? containerTitle : null,
    journal: type === 'article' ? containerTitle : null,
    pages: pageCount(w.page),
    doi: w.DOI || null,
    publisher: w.publisher || null,
  };
}

function fromOpenLibrary(rec, isbn) {
  return {
    source: 'OpenLibrary',
    title: rec.title || '',
    authors: (rec.authors || []).map(a => a.name).filter(Boolean),
    year: (String(rec.publish_date || '').match(/\d{4}/) || [null])[0] ? Number(String(rec.publish_date).match(/\d{4}/)[0]) : null,
    type: 'book',
    container: null,
    journal: null,
    pages: rec.number_of_pages || null,
    isbn,
    publisher: (rec.publishers && rec.publishers[0] && rec.publishers[0].name) || null,
  };
}

// ── the one entry point ─────────────────────────────────────────────

/**
 * @param {string} raw a DOI, an ISBN, or free text
 * @param {{author?: string}} opts an author surname narrows a title search a lot,
 *   and is the cheapest defence against matching a review instead of the work
 * @returns {Promise<Array>} candidates, best first. Never throws for "no match".
 */
export async function lookup(raw, opts = {}) {
  const q = classifyQuery(raw);
  if (q.kind === 'empty') return [];

  if (q.kind === 'doi') {
    const data = await getJSON(`${CROSSREF}/${encodeURIComponent(q.value)}`);
    return data && data.message ? [fromCrossref(data.message)] : [];
  }

  if (q.kind === 'isbn') {
    const key = `ISBN:${q.value}`;
    const data = await getJSON(
      `${OPENLIBRARY}?bibkeys=${encodeURIComponent(key)}&format=json&jscmd=data`);
    const rec = data && data[key];
    return rec ? [fromOpenLibrary(rec, q.value)] : [];
  }

  const author = (opts.author || '').trim();
  const data = await getJSON(
    `${CROSSREF}?query.bibliographic=${encodeURIComponent(q.value)}`
    + (author ? `&query.author=${encodeURIComponent(author)}` : '')
    + '&rows=5&select=title,author,issued,container-title,page,type,DOI,publisher');
  const items = (data && data.message && data.message.items) || [];
  return items.map(fromCrossref).filter(c => c.title);
}

function surnames(list) {
  return new Set((list || [])
    .map(n => String(n).trim().split(/\s+/).pop().toLowerCase())
    .filter(Boolean));
}

/**
 * Do the row and the candidate look like the same work?
 *
 * This exists because title search is genuinely dangerous here. Searching
 * "Beyond Concepts: Unicepts, Language, and Natural Information" returns, as
 * its top Crossref hit, a three-page review OF that book by someone else —
 * same title, different author, wrong type, wrong year, wrong DOI. Reviews,
 * replies and symposium pieces all share their subject's title, so title
 * agreement proves nothing and author agreement is the check that bites.
 *
 * Unknown counts as agreement: a row with no authors cannot contradict anything.
 */
export function authorsAgree(row, c) {
  const a = surnames(row.authors);
  const b = surnames(c.authors);
  if (!a.size || !b.size) return true;
  for (const n of a) if (b.has(n)) return true;
  return false;
}

/**
 * Fill only what is missing. Enriching a row must never silently replace a
 * title the user corrected by hand, so every field is guarded.
 */
export function applyCandidate(row, c, { overwrite = false } = {}) {
  const changed = [];
  const put = (field, value) => {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return;
    const cur = row[field];
    const empty = cur == null || cur === '' || (Array.isArray(cur) && !cur.length);
    if (!empty && !overwrite) return;
    if (JSON.stringify(cur) === JSON.stringify(value)) return;
    row[field] = value;
    changed.push(field);
  };
  put('title', c.title);
  put('authors', c.authors);
  put('year', c.year);
  put('pages', c.pages);
  put('container', c.container);
  put('journal', c.journal);
  if (c.doi) put('doi', c.doi);
  if (c.isbn) put('isbn', c.isbn);
  // `type` is the field the import got wrong most often, so it is the one field
  // worth correcting even when already set. Only when the record is plausibly
  // the same work, though — otherwise a review of a book turns the book into an
  // article, which is precisely the corruption this guard exists to prevent.
  if (c.type && row.type !== c.type) {
    const wasDefaulted = row.type === 'book' && !c.type.startsWith('book');
    if (overwrite || !row.type || (wasDefaulted && authorsAgree(row, c))) {
      row.type = c.type;
      changed.push('type');
    }
  }
  return changed;
}

/**
 * Re-rank by how well each candidate's title matches the row's.
 *
 * Crossref ranks by its own relevance, which for "Beyond Concepts: Unicepts,
 * Language, and Natural Information" put four of the book's own chapters above
 * the book itself. An exact title match is almost always the right answer, so
 * it should not be fourth in the list.
 */
export function rankCandidates(candidates, row) {
  const want = fold(row && row.title);
  if (!want) return candidates;
  const score = (c) => {
    const got = fold(c.title);
    if (got === want) return 0;
    if (want.startsWith(got) || got.startsWith(want)) return 1;
    if (want.includes(got) || got.includes(want)) return 2;
    return 3;
  };
  return candidates
    .map((c, i) => ({ c, i, s: score(c) + (authorsAgree(row, c) ? 0 : 0.5) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map(x => x.c);
}

/** What would applyCandidate actually change? Shown before anything is written. */
export function previewChanges(row, c) {
  const clone = JSON.parse(JSON.stringify(row));
  const fields = applyCandidate(clone, c);
  return fields.map(f => ({
    field: f,
    from: row[f] == null || row[f] === '' ? null : row[f],
    to: clone[f],
  }));
}

export function describe(c) {
  const bits = [];
  if (c.authors && c.authors.length) {
    bits.push(c.authors.length > 2 ? `${c.authors[0]} et al.` : c.authors.join(' & '));
  }
  if (c.year) bits.push(String(c.year));
  if (c.journal || c.container) bits.push(c.journal || c.container);
  if (c.type) bits.push(c.type);
  return bits.join(' · ');
}
