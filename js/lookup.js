// Bibliographic lookup: Crossref for DOIs, OpenLibrary for ISBNs, both for a
// title search. JSTOR links resolve through their 10.2307 DOI.
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
const OPENLIBRARY_SEARCH = 'https://openlibrary.org/search.json';
const TIMEOUT_MS = 8000;

export const LOOKUP_ORIGINS = ['api.crossref.org', 'openlibrary.org'];

/** What kind of thing did the user paste? */
export function classifyQuery(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'empty' };

  const doi = s.match(/\b(10\.\d{4,9}\/[^\s"'<>]+)/i);
  if (doi) return { kind: 'doi', value: doi[1].replace(/[.,;)]+$/, '') };

  // JSTOR. There is no metadata API to call: jstor.org sends no CORS header, so
  // a browser cannot read it, and JSTOR's real APIs need an institutional
  // agreement. What does work is that most JSTOR items carry a DOI under the
  // 10.2307 prefix built from the stable id, and Crossref will resolve that.
  // So a pasted JSTOR link becomes a DOI lookup.
  const jstor = s.match(/jstor\.org\/stable\/(?:pdf\/)?([^\s?#/]+)/i)
    || s.match(/^stable\/([^\s?#/]+)$/i);
  if (jstor) {
    const id = jstor[1].replace(/\.pdf$/i, '');
    return { kind: 'doi', value: `10.2307/${id}`, via: 'JSTOR' };
  }

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

/**
 * Crossref hands back XML/JATS, not plain text: titles arrive carrying `&amp;`
 * for an ampersand and markup like `<i>Sophist</i>` for emphasis. Written
 * straight into a row, those show up verbatim in the interface.
 *
 * Parsing as a detached HTML document and taking textContent decodes the
 * entities and drops the tags in one pass. DOMParser does not run scripts and
 * the result is never inserted as HTML, so a hostile string stays inert.
 */
function cleanText(s) {
  if (s == null) return '';
  const str = String(s);
  if (!/[<&]/.test(str)) return str.replace(/\s+/g, ' ').trim();
  const doc = new DOMParser().parseFromString(str, 'text/html');
  return ((doc.body && doc.body.textContent) || str).replace(/\s+/g, ' ').trim();
}

/**
 * Crossref stores a subtitle in its own field, so reading `title[0]` alone
 * silently truncates at the colon: "Mind in a Physical World" loses "An Essay
 * on the Mind-body Problem and Mental Causation".
 */
function fullTitle(titleArr, subtitleArr) {
  const main = cleanText((titleArr || [])[0]);
  const sub = cleanText((subtitleArr || [])[0]);
  if (!sub) return main;
  if (!main) return sub;
  if (fold(main).includes(fold(sub))) return main;   // some records repeat it
  return `${main.replace(/[:\s]+$/, '')}: ${sub}`;
}

function pageCount(page) {
  const m = String(page || '').match(/^(\d+)\s*[-–—]+\s*(\d+)$/);
  if (!m) return null;
  const n = Number(m[2]) - Number(m[1]) + 1;
  return n > 0 && n < 5000 ? n : null;
}

function fromCrossref(w) {
  const authors = (w.author || [])
    .map(a => cleanText([a.given, a.family].filter(Boolean).join(' ').trim() || a.name))
    .filter(Boolean);
  const parts = w.issued && w.issued['date-parts'] && w.issued['date-parts'][0];
  const type = CROSSREF_TYPE[w.type] || 'article';
  const containerTitle = cleanText((w['container-title'] && w['container-title'][0]) || '') || null;

  // Three cases, not two. For a chapter it is the book (a real parent); for an
  // article it is the journal; for a whole book it is a series or a hosting
  // platform - Crossref hands back "Oxford Scholarship Online" - which is
  // neither, and writing that into `journal` would just be noise.
  const isPartOfBook = type === 'chapter' || type === 'section';
  return {
    source: 'Crossref',
    title: fullTitle(w.title, w.subtitle),
    authors,
    year: parts && parts[0] ? Number(parts[0]) : null,
    type,
    container: isPartOfBook ? containerTitle : null,
    journal: type === 'article' ? containerTitle : null,
    pages: pageCount(w.page),
    doi: w.DOI || null,
    isbn: (w.ISBN && w.ISBN[0]) || null,
    publisher: cleanText(w.publisher) || null,
  };
}

function fromOpenLibrary(rec, isbn) {
  return {
    source: 'OpenLibrary',
    title: fullTitle([rec.title], [rec.subtitle]),
    authors: (rec.authors || []).map(a => cleanText(a.name)).filter(Boolean),
    year: (String(rec.publish_date || '').match(/\d{4}/) || [null])[0] ? Number(String(rec.publish_date).match(/\d{4}/)[0]) : null,
    type: 'book',
    container: null,
    journal: null,
    pages: rec.number_of_pages || null,
    isbn,
    publisher: cleanText((rec.publishers && rec.publishers[0] && rec.publishers[0].name) || '') || null,
  };
}

/**
 * OpenLibrary's search endpoint, as opposed to its ISBN endpoint.
 *
 * This exists because Crossref is a DOI registry: everything in it has a DOI,
 * and its record for a whole book is the publisher's electronic edition, which
 * carries no page count. Ask Crossref for "Mind in a Physical World" and the
 * monograph comes back with `page: null`. OpenLibrary has 156 pages for the
 * same book. Neither source alone answers a book title search well.
 */
function fromOpenLibrarySearch(doc) {
  return {
    source: 'OpenLibrary',
    title: fullTitle([doc.title], [doc.subtitle]),
    authors: (doc.author_name || []).map(cleanText).filter(Boolean),
    year: doc.first_publish_year || null,
    type: 'book',
    container: null,
    journal: null,
    pages: doc.number_of_pages_median || null,
    doi: null,
    isbn: (doc.isbn && doc.isbn[0]) || null,
    publisher: cleanText((doc.publisher || [])[0]) || null,
  };
}

function surnameOfFirst(c) {
  const a = (c.authors || [])[0] || '';
  return fold(String(a).trim().split(/\s+/).pop());
}

/**
 * Are these two records the same work?
 *
 * Same first-author surname is the hard requirement — it is what keeps a review
 * of a book from merging into the book. Beyond that, the two catalogues rarely
 * agree on the title: Crossref carries "Mind in a Physical World: An Essay on
 * the Mind-Body Problem and Mental Causation" and OpenLibrary just "Mind in a
 * Physical World". Matching only on equality leaves the DOI and the page count
 * on separate candidates, which is the thing worth fixing.
 *
 * So a subtitle may be present on one side and absent on the other — but only
 * a real subtitle. The extra text has to sit after a colon or dash, or
 * "Causation" would swallow "Causation and Counterfactuals".
 */
function sameWork(a, b) {
  if (surnameOfFirst(a) !== surnameOfFirst(b)) return false;
  const ta = fold(a.title), tb = fold(b.title);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  const [shorter, longer] = ta.length <= tb.length ? [a, b] : [b, a];
  const mainOfLonger = fold(String(longer.title).split(/[:—–]/)[0]);
  return mainOfLonger === fold(shorter.title);
}

/** Fold the two sources' views of one work into a single candidate. */
function mergeCandidates(list) {
  const out = [];
  for (const c of list) {
    const m = out.find(x => sameWork(x, c));
    if (!m) { out.push({ ...c }); continue; }
    for (const f of ['year', 'pages', 'doi', 'isbn', 'container', 'journal', 'publisher']) {
      if (m[f] == null && c[f] != null) m[f] = c[f];
    }
    if (!(m.authors || []).length && (c.authors || []).length) m.authors = c.authors;
    if ((c.title || '').length > (m.title || '').length) m.title = c.title;
    // Crossref distinguishes chapter from book; OpenLibrary calls everything a book.
    if (c.source === 'Crossref') m.type = c.type;
    if (!String(m.source).includes(c.source)) m.source = `${m.source} + ${c.source}`;
  }
  return out;
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

  // A title search asks both. Crossref alone systematically fails on books:
  // it is a DOI registry, so its book records are electronic editions with no
  // page count, while OpenLibrary is a book catalogue and has one.
  const author = (opts.author || '').trim();
  const [cr, ol] = await Promise.allSettled([
    getJSON(`${CROSSREF}?query.bibliographic=${encodeURIComponent(q.value)}`
      + (author ? `&query.author=${encodeURIComponent(author)}` : '')
      + '&rows=5&select=title,subtitle,author,issued,container-title,page,type,DOI,ISBN,publisher'),
    // OpenLibrary indexes the title proper, so searching it with a subtitle
    // attached finds nothing: "Beyond Concepts: Unicepts, Language, and Natural
    // Information" misses a catalogue entry filed as "Beyond Concepts".
    getJSON(`${OPENLIBRARY_SEARCH}?title=${encodeURIComponent(q.value.split(/[:—–]/)[0].trim() || q.value)}`
      + (author ? `&author=${encodeURIComponent(author)}` : '')
      + '&limit=5&fields=title,subtitle,author_name,first_publish_year,number_of_pages_median,isbn,publisher'),
  ]);
  // One source failing is survivable; both failing is the error.
  if (cr.status === 'rejected' && ol.status === 'rejected') throw cr.reason;
  const items = [
    ...(cr.status === 'fulfilled' ? ((cr.value.message && cr.value.message.items) || []).map(fromCrossref) : []),
    ...(ol.status === 'fulfilled' ? (ol.value.docs || []).map(fromOpenLibrarySearch) : []),
  ];
  return mergeCandidates(items).filter(c => c.title).slice(0, 6);
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
  if (c.pages) bits.push(`${c.pages} pp`);
  // Which source a candidate came from matters now that a title search asks two
  // and merges them: "Crossref + OpenLibrary" means the DOI and the page count
  // are from different catalogues.
  if (c.source) bits.push(c.source);
  return bits.join(' · ');
}
