// Schema helpers (spec §3).
//
// Rule for the whole file: the real data.json is SPARSE. `reread_log` is absent
// from all 229 rows, `reread_wanted` from all but 4, and `import` blocks carry a
// varying subset of their documented keys. Nothing here may assume a key exists.
// Nothing here rewrites rows to add missing keys either — that would turn the
// first save into a 229-row diff. Read defensively, write full shapes only for
// rows this app creates.

// `collection` is gone. It only ever held author blocks and seminar blocks —
// Google Tasks scaffolding that duplicated information the rows already carry.
// Real containment is now expressed by parent_id, at any depth.
export const TYPES = ['book', 'chapter', 'article', 'section'];
export const STATUSES = ['queued', 'reading', 'read', 'abandoned', 'triage'];
export const SOURCES = ['queue', 'off-list', 'coursework'];

export const STATUS_LABEL = {
  queued: 'Queued', reading: 'Reading', read: 'Read',
  abandoned: 'Abandoned', triage: 'Triage',
};

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function slugify(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'untitled';
}

export function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** A complete text row, matching the shape already in data.json. */
export function newText(partial = {}) {
  return {
    id: partial.id,
    title: partial.title || '',
    authors: partial.authors || [],
    year: partial.year ?? null,
    type: partial.type || 'article',
    container: partial.container ?? null,
    parent_id: partial.parent_id ?? null,
    status: partial.status || 'queued',
    source: partial.source || 'queue',
    notes_written: false,
    carded: false,
    pages: null,
    est_hours: null,
    familiarity: null,
    predicted: { value_abs: null, value_rel: null, cost: null, date: null, rubric_version: null },
    realized: { value_abs: null, value_rel: null, cost: null, date: null },
    latent: { value_abs: null, value_rel: null, cost: null },
    verdict: '',
    notes_link: null,
    zotero_key: null,
    subject_ids: [],
    project_ids: [],
    prerequisite_ids: [],
    date_added: partial.date_added ?? todayISO(),
    date_started: partial.date_started ?? null,
    date_finished: partial.date_finished ?? null,
    import: {
      raw_title: partial.title || '',
      source_notes: partial.source_notes ?? null,
      needs_container: false,
      container_candidates: null,
    },
    ...(partial.extra || {}),
  };
}

// ── relations ───────────────────────────────────────────────────────

/** Map of parent_id -> child rows. Rebuilt per render; 229 rows is nothing. */
export function childIndex(texts) {
  const m = new Map();
  for (const t of texts) {
    if (!t.parent_id) continue;
    if (!m.has(t.parent_id)) m.set(t.parent_id, []);
    m.get(t.parent_id).push(t);
  }
  return m;
}

export function byIdIndex(texts) {
  return new Map(texts.map(t => [t.id, t]));
}

/** Container display name for a child row, whether linked by id or free text. */
export function containerName(t, byId) {
  if (t.parent_id && byId.has(t.parent_id)) return byId.get(t.parent_id).title;
  return t.container || null;
}

/**
 * Which group a row hangs under, at any depth: a real parent row if one is
 * linked, otherwise the free-text container it names.
 *
 * The fallback matters. Four rows point at books that have no row of their own
 * ("Critique of Pure Reason", "Lectures on Logic"). Grouping them by the string
 * keeps the hierarchy visible without inventing rows nobody asked for.
 */
export function groupKey(t, byId) {
  if (t.parent_id && byId.has(t.parent_id)) return `id:${t.parent_id}`;
  if (t.container) return `text:${fold(t.container)}`;
  return null;
}

export const MAX_DEPTH = 8;

/**
 * Every id at or below `id`. Used to stop a row being made its own ancestor —
 * arbitrary nesting means a cycle would hang the renderer, so the parent picker
 * refuses to offer one rather than trusting the data to be acyclic.
 */
export function descendantIds(id, children) {
  const out = new Set();
  const walk = (cur, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const c of children.get(cur) || []) {
      if (out.has(c.id)) continue;
      out.add(c.id);
      walk(c.id, depth + 1);
    }
  };
  walk(id, 0);
  return out;
}

export function unreadPrerequisites(t, byId) {
  return (t.prerequisite_ids || [])
    .map(id => byId.get(id))
    .filter(p => p && p.status !== 'read');
}

// ── display ─────────────────────────────────────────────────────────

/**
 * 20 rows have an empty `authors` array and many of those carry the author
 * inside the title instead ("Ezra Rubenstein, \"Two Approaches…\""). Return
 * null rather than inventing one; the caller omits the field.
 */
export function authorLine(t) {
  const a = t.authors || [];
  if (!a.length) return null;
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} & ${a[1]}`;
  return `${a[0]} et al.`;
}

export function sortKeyTitle(t) {
  return String(t.title || '').toLowerCase().replace(/^(the|a|an)\s+/, '');
}

// ── comparison pool (spec §4) ───────────────────────────────────────

/**
 * Can this text be compared at all?
 *
 * §4: comparisons are drawn only from completed reading — the whole constraint
 * is that unread texts cannot be judged against each other.
 *
 * §10: a row imported from a syllabus but never confirmed as actually read is
 * excluded. A wrong row there does not merely mislabel itself; it enters the
 * Bradley-Terry training set and teaches the rubric something false, which then
 * propagates to every prediction in the queue.
 *
 * `abandoned` is deliberately out. It is a first-class outcome worth keeping,
 * but "which would I more regret never having read" is not answerable about a
 * text that was put down partway.
 */
export function poolEligible(t) {
  if (t.status !== 'read') return false;
  if ((t.import || {}).confidence === 'syllabus') return false;
  return true;
}

export function inPool(t) { return t.in_pool === true; }

/**
 * What a pool of this size costs, at §4's 4-6 comparisons per item per
 * dimension. Each comparison covers two items, so ~2.5N per dimension.
 * Surfaced live while choosing, because the number is the whole argument for
 * sampling rather than comparing the entire read corpus.
 */
export function poolCost(n) {
  const perDimension = Math.ceil(n * 2.5);
  const total = perDimension * 3;
  return {
    perDimension,
    total,
    batches: Math.ceil(total / 20),
    minutes: Math.round(total * 3 / 60),
  };
}

// ── scores (all null until phase 2; hand-entry allowed in phase 1) ───

/** Which block a score comes from: realized beats predicted for read texts. */
export function scores(t) {
  const r = t.realized || {};
  const p = t.predicted || {};
  return {
    value_abs: r.value_abs ?? p.value_abs ?? null,
    value_rel: r.value_rel ?? p.value_rel ?? null,
    cost: r.cost ?? p.cost ?? null,
  };
}

export function isScored(t) {
  const s = scores(t);
  return s.value_abs != null || s.value_rel != null || s.cost != null;
}

/**
 * priority = value / cost^alpha, where value = w*abs + (1-w)*rel.
 *
 * Returns null — never NaN, never Infinity — when the inputs are not there,
 * which right now is every row in the file. Callers must handle null; that is
 * cheaper than defending against NaN leaking into a comparator.
 */
export function priority(t, w, alpha) {
  const s = scores(t);
  if (s.cost == null) return null;
  if (s.value_abs == null && s.value_rel == null) return null;
  const abs = s.value_abs ?? s.value_rel;
  const rel = s.value_rel ?? s.value_abs;
  const value = w * abs + (1 - w) * rel;
  const cost = Math.max(Number(s.cost), 0.1); // cost 0 would divide by zero
  const p = value / Math.pow(cost, alpha);
  return Number.isFinite(p) ? p : null;
}

/** Spec §4: the read/card quadrant. Needs both value axes. */
export function quadrant(t, midpoint = 5) {
  const s = scores(t);
  if (s.value_abs == null || s.value_rel == null) return null;
  const hiAbs = s.value_abs >= midpoint;
  const hiRel = s.value_rel >= midpoint;
  if (hiAbs && hiRel) return { key: 'now', label: 'Read now, carefully', card: true, note: 'Card it.' };
  if (hiAbs && !hiRel) return { key: 'keep', label: "Read eventually. Don't lose it", card: true, note: 'Card it when read.' };
  if (!hiAbs && hiRel) return { key: 'fast', label: 'Read fast, instrumentally', card: false, note: "Extract and move on. Don't card." };
  return { key: 'cut', label: 'Cut', card: false, note: 'Neither axis justifies the hours.' };
}

// ── document validation (import path) ───────────────────────────────

export function validateDoc(obj) {
  const errs = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['Not a JSON object.'];
  if (!Array.isArray(obj.texts)) errs.push('Missing `texts` array.');
  for (const k of ['subjects', 'projects', 'comparisons']) {
    if (k in obj && !Array.isArray(obj[k])) errs.push(`\`${k}\` is present but not an array.`);
  }
  if (Array.isArray(obj.texts)) {
    const seen = new Set();
    obj.texts.forEach((t, i) => {
      if (!t || typeof t !== 'object') { errs.push(`texts[${i}] is not an object.`); return; }
      if (!t.id) errs.push(`texts[${i}] has no id.`);
      else if (seen.has(t.id)) errs.push(`Duplicate id "${t.id}".`);
      else seen.add(t.id);
      if (t.status && !STATUSES.includes(t.status)) errs.push(`texts[${i}] "${t.id}" has unknown status "${t.status}".`);
    });
  }
  return errs;
}

export function emptyDoc() {
  return {
    version: 1,
    updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    texts: [], subjects: [], projects: [], comparisons: [], rubric: {},
  };
}

/**
 * Normalise a string for matching: case, accents, and punctuation all go.
 *
 * Bibliographic titles are full of punctuation that nobody types the same way
 * twice — colons before subtitles, ampersands between authors, curly versus
 * straight apostrophes, en dashes in page ranges. Leaving any of it in place
 * means "Kringelbach Berridge" fails to find "Kringelbach & Berridge" and
 * "beyond concepts unicepts" fails to find "Beyond Concepts: Unicepts, ...".
 *
 * Apostrophes are deleted rather than spaced, so "Tyler's" folds to "tylers"
 * and both "tylers" and "tyler" still match it. "&" becomes "and" so either
 * spelling converges. Everything else becomes a space.
 */
export function fold(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')      // combining marks: Salmón -> salmon
    .replace(/[\u2018\u2019\u02bc']/g, '') // apostrophes vanish: Tyler's -> tylers
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does `hay` match `query`? Every whitespace-separated token in the query must
 * appear somewhere in the haystack, in any order.
 *
 * Substring-matching the whole query is too brittle for this data: it makes
 * word order significant and breaks on any punctuation sitting between two
 * words the reader typed adjacently.
 */
export function matchesQuery(hay, query) {
  const tokens = fold(query).split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const h = fold(hay);
  return tokens.every(tok => h.includes(tok));
}
