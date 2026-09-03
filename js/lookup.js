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

// ── title case (Chicago) ────────────────────────────────────────────
//
// Catalogue records are inconsistent about case. Crossref hands back
// "I.—COMPUTING MACHINERY AND INTELLIGENCE" from one publisher and
// "The myth of the essential indexical" from the next, and both land in a
// list beside titles that are already right.

/**
 * Lowercased in the middle of a title: articles, coordinating conjunctions and
 * prepositions, which CMS 17 keeps down regardless of length. `as` and `to`
 * are here for the same reason.
 *
 * CMS capitalises a preposition used adverbially — "Look Up", "Turn On" — and
 * nothing short of parsing tells those apart from the ordinary case, so this
 * gets those wrong. It is the one error worth accepting: it is rare in a
 * bibliography, visible when it happens, and correctable in the box.
 */
const LOWER = new Set([
  'a', 'an', 'the',
  'and', 'but', 'or', 'nor', 'for', 'yet', 'so',
  'as', 'at', 'by', 'down', 'from', 'in', 'into', 'like', 'near', 'of', 'off',
  'on', 'onto', 'out', 'over', 'past', 'per', 'than', 'to', 'up', 'upon',
  'via', 'with', 'within', 'without', 'about', 'above', 'across', 'after',
  'against', 'along', 'among', 'around', 'before', 'behind', 'below',
  'beneath', 'beside', 'between', 'beyond', 'during', 'except', 'inside',
  'outside', 'since', 'through', 'throughout', 'toward', 'towards', 'under',
  'underneath', 'until', 'versus', 'vs',
]);

/**
 * Is this string shouting? Only then is existing case discarded.
 *
 * Anywhere else, existing capitals are evidence and are kept: they carry
 * McDowell, PhD, Sinn und Bedeutung, and every acronym. Down-casing those to
 * rebuild them would lose information no rule can put back.
 */
function isShouty(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 8) return false;
  const upper = (s.match(/[A-Z]/g) || []).length;
  return !/[a-z]/.test(s) || upper / letters.length > 0.8;
}

function capFirst(w) {
  const i = w.search(/[A-Za-zÀ-ɏ]/);
  if (i < 0) return w;
  return w.slice(0, i) + w[i].toUpperCase() + w.slice(i + 1);
}

/** One word, already known not to be shouting. */
function caseWord(w, force) {
  const bare = w.replace(/[^A-Za-z'’]/g, '').toLowerCase();
  if (!force && LOWER.has(bare)) return w.toLowerCase();
  // A word with capitals of its own past the first letter is a name, an
  // acronym or a deliberate spelling. Leave it exactly as it came.
  if (/[A-Z]/.test(w.slice(1))) return w;
  return capFirst(w);
}

/**
 * Chicago-style title case. First and last word always capitalised, as is
 * anything opening a subtitle after a colon, question mark or dash.
 */
export function titleCase(input) {
  const raw = String(input || '').trim();
  if (!raw) return raw;
  const src = isShouty(raw) ? raw.toLowerCase() : raw;

  const tokens = src.split(/(\s+)/);
  const words = tokens.map((t, i) => ({ t, i, isWord: !/^\s*$/.test(t) }));
  const wordIdx = words.filter(w => w.isWord).map(w => w.i);
  const first = wordIdx[0];
  const last = wordIdx[wordIdx.length - 1];

  let openSegment = true;              // start of the title or of a subtitle
  return words.map(({ t, i, isWord }) => {
    if (!isWord) return t;
    const force = openSegment || i === first || i === last;
    // A colon, question mark, em dash or full stop ends a segment, so whatever
    // follows is the start of a subtitle and is capitalised.
    openSegment = /[:?!.—–]$/.test(t.trim());
    // Split on the separators that can sit inside a token. A hyphen makes a
    // compound and each part takes the ordinary rule — "Anti-Individualism".
    // A dash or a slash starts a new phrase, so what follows is capitalised
    // outright: without this, Crossref's "I.—COMPUTING MACHINERY" came back as
    // "I.—computing Machinery".
    const parts = t.split(/([-—–/])/);
    return parts.map((part, j) => {
      if (j % 2) return part;                       // the separator itself
      const prev = parts[j - 1];
      const opensPhrase = prev === '—' || prev === '–' || prev === '/';
      return caseWord(part, (force && j === 0) || opensPhrase);
    }).join('');
  }).join('');
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
  const main = titleCase(cleanText((titleArr || [])[0]));
  const sub = titleCase(cleanText((subtitleArr || [])[0]));
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
  // The container of a chapter is a book title, so it gets the same treatment.
  // The journal name does not: those arrive correct and are full of house
  // styling — "Noûs", "Mind & Language" — that a rule can only damage.
  const rawContainer = cleanText((w['container-title'] && w['container-title'][0]) || '') || null;
  const containerTitle = rawContainer;

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
    container: isPartOfBook ? titleCase(containerTitle) : null,
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
  // `type` used to be corrected even when already set, because the import
  // defaulted everything it could not identify to "book". Those rows have since
  // been fixed by hand, so the exception now only risks turning a corrected type
  // back into whatever a catalogue happens to say — Crossref calls plenty of
  // chapters "book-part". It fills an empty type and nothing more.
  put('type', c.type);
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

// ── chapter discovery (spec §5) ─────────────────────────────────────
//
// A recent academic book is often deposited with Crossref chapter by chapter,
// each with its own DOI and page range. Where that is true the whole table of
// contents can be recovered from the book's ISBN in one request. Where it is
// not — anything older than roughly 2005, and most trade and translated
// editions — no amount of querying will conjure it, and the honest answer is
// that there is nothing to find.

const CHAPTER_FILTER = 'type:book-chapter,type:book-part,type:book-section';
const CHAPTER_SELECT = 'DOI,title,subtitle,author,page,issued,type,container-title,ISBN,publisher';

/**
 * Some publishers — OUP conspicuously — put the chapter number in the title
 * field: "8 Biological and Methodological Backgrounds". Left there it sorts
 * chapter 10 between 1 and 2 and reads badly in a list. Split it off so the
 * title is the title and the number can do the ordering.
 */
function splitNumbering(title) {
  const m = String(title || '').match(
    /^\s*(?:chapter|chap\.?|part|section)?\s*(\d{1,3})\s*[.:—–-]?\s+(\S.*)$/i);
  if (!m) return { no: null, title: String(title || '').trim() };
  return { no: Number(m[1]), title: m[2].trim() };
}

function firstPage(page) {
  const m = String(page || '').match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Crossref's `query.container-title` is a relevance search, not a filter, so it
 * happily returns chapters of other books — and a short title makes that
 * catastrophic. Searching Strawson's `Individuals` under a substring rule
 * returned a hundred chapters from a hundred unrelated volumes, every one of
 * them ready to be added in a single click.
 *
 * So: the container has to be this book by name, and either the name is exact
 * or it is long enough to be discriminating AND the chapter shares an author
 * with the book. A one-word title gets exact matching or nothing.
 */
function containerMatches(book, w) {
  const got = fold(cleanText((w['container-title'] || [])[0] || ''));
  const want = fold(book.title || '');
  if (!got || !want) return false;
  if (got === want) return true;
  const distinctive = want.split(/\s+/).filter(Boolean).length >= 3 && want.length >= 18;
  if (!distinctive) return false;
  // "Origins of Objectivity" vs "Origins of Objectivity: ..." — a subtitle is
  // fine; an unrelated book that merely contains the phrase is not.
  if (!got.startsWith(want)) return false;
  return authorsAgree(book, fromCrossref(w));
}

/**
 * @returns {Promise<{via: string, candidates: object[]}>}
 */
/**
 * Crossref's `isbn:` filter is not a reliable index of a book's parts. The
 * Cambridge Critique of Pure Reason returns three chapters by ISBN — and all
 * thirty-two when its own DOI stem is probed directly, because that is what the
 * parts were actually deposited against. A publisher numbering its chapters
 * `<book-doi>.001`, `.002`, … lets the whole contents list be recovered in one
 * request, since Crossref ORs repeated `doi:` filters.
 *
 * Nothing is guessed: every DOI here either resolves to a real record or is
 * silently absent from the reply.
 */
async function probeDoiStem(stem, from, count) {
  const filter = Array.from({ length: count }, (_, i) =>
    `doi:${stem}.${String(from + i).padStart(3, '0')}`).join(',');
  const d = await getJSON(`${CROSSREF}?filter=${encodeURIComponent(filter)}`
    + `&rows=${count}&select=${CHAPTER_SELECT}`);
  return ((d.message || {}).items) || [];
}

export async function findChapters(book) {
  const seen = new Map();
  let via = null;
  let byTitle = false;

  const collect = (items, label, { partOfBook = false } = {}) => {
    for (const w of items || []) {
      const doi = w.DOI;
      if (!doi || seen.has(doi)) continue;
      const c = fromCrossref(w);
      const { no, title } = splitNumbering(c.title);
      if (!title) continue;
      // Front and back matter is deposited as Crossref type `other`, which maps
      // to `article` by default — wrong for a glossary, and it would send the
      // book's name to `journal` instead of `container`.
      if (partOfBook && c.type !== 'chapter' && c.type !== 'section') {
        c.type = 'section';
        c.container = c.container || c.journal;
        c.journal = null;
      }
      // When the DOI sits under the book's own stem, its numeric suffix is the
      // publisher's deposit order — better evidence of position than a page
      // range, which front matter often lacks entirely.
      const seq = partOfBook ? Number((String(doi).match(/\.(\d{1,4})$/) || [])[1]) : NaN;
      seen.set(doi, {
        ...c, title, chapter_no: no,
        start: firstPage(w.page),
        seq: Number.isFinite(seq) ? seq : null,
      });
    }
    if (items && items.length && !via) via = label;
  };

  // A book DOI that already ends in a numbered segment is itself a part
  // (OUP deposits books as `…9780199581405.001.0001`), so there is no stem
  // below it to probe and the ISBN path is the one that works.
  const rawDoi = String(book.doi || '').trim().toLowerCase().replace(/\/+$/, '');
  const stem = /\.\d{3,4}$/.test(rawDoi) ? '' : rawDoi;
  if (stem) {
    // Front matter and appendices are deposited as `other`, so no type filter
    // here — a DOI under the book's own stem is part of the book by definition.
    const BATCH = 40;
    for (let from = 1; from <= 200; from += BATCH) {
      const items = await probeDoiStem(stem, from, BATCH);
      collect(items, `the DOI ${book.doi}`, { partOfBook: true });
      if (items.length < BATCH) break;   // ran off the end of the numbering
    }
  }

  const isbn = String(book.isbn || '').replace(/[^0-9Xx]/g, '');
  if (isbn) {
    const url = `${CROSSREF}?filter=isbn:${encodeURIComponent(isbn)},${CHAPTER_FILTER}`
      + `&rows=200&select=${CHAPTER_SELECT}`;
    const d = await getJSON(url);
    collect(((d.message || {}).items) || [], `ISBN ${isbn}`);
  }

  // Fall back to the title only when the ISBN found nothing — a book can be
  // deposited under a different ISBN than the printing you own.
  if (!seen.size && book.title) {
    const url = `${CROSSREF}?query.container-title=${encodeURIComponent(book.title)}`
      + `&filter=${CHAPTER_FILTER}&rows=100&select=${CHAPTER_SELECT}`;
    const d = await getJSON(url);
    const items = (((d.message || {}).items) || []).filter(w => containerMatches(book, w));
    collect(items, `the title “${book.title}”`);
    if (seen.size) byTitle = true;
  }

  // A composite key, not a chain of pairwise tests. Front matter ("Preface",
  // "Dedication") carries neither a page range nor a number, and comparing
  // those pairwise against numbered chapters yields a non-transitive
  // comparator — which does not merely misplace them, it scrambles the whole
  // array. Unplaceable items sort to the end, where they are obvious.
  const all = [...seen.values()];
  // Neither key works alone. Page order is the book's real order, but front
  // matter is paginated in roman numerals that parse to nothing — "Contents",
  // v-vi — so it would sort after page 774. Deposit order fixes that, yet is
  // not the book's order either: Cambridge deposited four of the Critique's
  // sections late, so `.033` is a passage belonging on page 202.
  //
  // So: front matter first, in deposit order, then the body in page order.
  const key = (c) => {
    if (c.start != null) return [1, c.start, fold(c.title)];
    if (c.seq != null) return [0, c.seq, fold(c.title)];
    return [2, c.chapter_no != null ? c.chapter_no : 0, fold(c.title)];
  };
  const candidates = all.sort((a, b) => {
    const ka = key(a); const kb = key(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2].localeCompare(kb[2]);
  });
  // An ISBN names one book. A title merely resembles one, so a title-matched
  // result is offered rather than assumed: the caller pre-selects nothing.
  // Where the publisher numbers its own chapters, that numbering is the real
  // one and is left alone. Where it does not — Cambridge gives the Critique's
  // thirty-six parts no numbers at all — impose a sequence, so the contents
  // list reads in the book's order instead of alphabetically. All or nothing
  // per book: a mix of publisher numbers and invented ones would mean two
  // different things in one column.
  if (!candidates.some(c => c.chapter_no != null)) {
    candidates.forEach((c, i) => { c.chapter_no = i + 1; });
  }
  return { via: via || null, candidates, certain: !byTitle };
}

/** Is this chapter already recorded under the book? Matched on DOI, then title. */
export function alreadyHave(kids, c) {
  return (kids || []).find(k =>
    (c.doi && k.doi && String(k.doi).toLowerCase() === String(c.doi).toLowerCase())
    || (k.title && fold(k.title) === fold(c.title))) || null;
}
