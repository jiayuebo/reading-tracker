// Courses: a course record with dated sessions (spec §3, §5).
//
// Deliberately light. Reading happens on the reader's own time, so nothing here
// plans or allocates: dates are entered by hand or come off a syllabus, and the
// one job for a model is translating a syllabus's unstructured list into
// sessions with dates and matched texts — by the same export → chat →
// paste-back loop as Evaluate, and for the same reason (no model key in the
// page, §4 step 2).
//
// A course's readings live on its sessions. The older `import.courses` tag on a
// text is provenance from the 2025–26 syllabus import and is left alone; those
// six courses can be turned into records from the tags once, by the reader.

import {
  fold, slugify, uniqueId, todayISO, authorLine, TYPES, nextSubItemId, newText,
} from './model.js';
import { lookup, rankCandidates, authorsAgree } from './lookup.js';

// ── dates ───────────────────────────────────────────────────────────

export function formatDay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function validISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ── reading the records ─────────────────────────────────────────────

export function courseTextIds(course) {
  const out = [];
  for (const s of course.sessions || []) for (const id of s.text_ids || []) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * When is each unread text due? The earliest upcoming session that assigns it;
 * failing that, the latest past one, so an overdue reading still says so.
 * Only queued and reading texts — a finished text is not due.
 */
export function dueDates(doc, today = todayISO()) {
  const status = new Map((doc.texts || []).map(t => [t.id, t.status]));
  const out = new Map();
  for (const c of doc.courses || []) {
    for (const s of c.sessions || []) {
      if (!s.date) continue;
      const upcoming = s.date >= today;
      for (const id of s.text_ids || []) {
        const st = status.get(id);
        if (st !== 'queued' && st !== 'reading') continue;
        const cand = { date: s.date, past: !upcoming, course: c.name, optional: (s.optional_ids || []).includes(id) };
        const cur = out.get(id);
        if (!cur
          || (upcoming && (cur.past || s.date < cur.date))
          || (!upcoming && cur.past && s.date > cur.date)) out.set(id, cand);
      }
    }
  }
  return out;
}

/** The next dated session on or after today, if any. */
export function nextSession(course, today = todayISO()) {
  return (course.sessions || [])
    .filter(s => s.date && s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}

export function sortSessions(sessions) {
  // Stable, dated sessions in date order, undated ones after them in the order given.
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (a.s.date && b.s.date && a.s.date !== b.s.date) return a.s.date.localeCompare(b.s.date);
      if (a.s.date && !b.s.date) return -1;
      if (!a.s.date && b.s.date) return 1;
      return a.i - b.i;
    })
    .map(x => x.s);
}

// ── courses implied by older data ───────────────────────────────────

/** "ethics-of-belief-246" → "Ethics of belief 246". A starting name, meant to be edited. */
export function nameFromKey(key) {
  const words = String(key).split('-').filter(Boolean);
  if (!words.length) return key;
  const out = words.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** "Readings for Tyler's seminar on Kant" → "Tyler's seminar on Kant". */
export function nameFromShelf(shelf) {
  const out = String(shelf).trim().replace(/^readings?\s+(for|from)\s+/i, '');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Courses implied by older data that have no record yet.
 *
 * Two earlier representations. The `import.courses` tag from the 2025–26
 * syllabus merge stays on each text as provenance. `shelves` is retired (§3):
 * the only shelf ever used was a seminar's reading list, which is what a course
 * is, so turning one into a course also removes the label — see applyCandidates.
 * Either way the reader creates the records with one click; nothing is inferred
 * silently.
 */
export function courseCandidates(doc, dismissed = []) {
  const recorded = new Set((doc.courses || []).map(c => c.id));
  const found = new Map();
  const add = (key, make, textId) => {
    if (!found.has(key)) found.set(key, { key, ...make(), text_ids: [] });
    const c = found.get(key);
    if (!c.text_ids.includes(textId)) c.text_ids.push(textId);
  };
  for (const t of doc.texts || []) {
    for (const k of (t.import || {}).courses || []) {
      add(k, () => ({ name: nameFromKey(k), source: 'tag' }), t.id);
    }
    for (const sh of t.shelves || []) {
      add(slugify(nameFromShelf(sh)), () => ({ name: nameFromShelf(sh), source: 'shelf', shelf: sh }), t.id);
    }
  }
  return [...found.values()]
    .filter(c => !recorded.has(c.key) && !dismissed.includes(c.key))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create the records, inside mutate(). A course made from a shelf takes the
 * shelf's place: the label comes off its readings, and the `shelves` key goes
 * once it is empty, so the same grouping is never stored twice.
 */
export function applyCandidates(d, candidates) {
  d.courses = [...(d.courses || []), ...recordsFromCandidates(candidates)];
  const retired = new Set(candidates.filter(c => c.source === 'shelf').map(c => c.shelf));
  if (!retired.size) return;
  for (const t of d.texts || []) {
    if (!(t.shelves || []).length) continue;
    t.shelves = t.shelves.filter(sh => !retired.has(sh));
    if (!t.shelves.length) delete t.shelves;
  }
}

export function recordsFromCandidates(candidates) {
  return candidates.map(c => ({
    id: c.key,
    name: c.name,
    code: null,
    term: null,
    sessions: [{ id: 's1', date: null, label: 'Readings', text_ids: [...c.text_ids], optional_ids: [] }],
  }));
}

// ── syllabus: export ────────────────────────────────────────────────

export const SYLLABUS_PROMPT = `You are turning a course syllabus into structured data for a philosophy student's
reading tracker. The syllabus will be pasted below this prompt. Below that instruction is the
list of texts already in the tracker, each with an id.

Return one JSON object and nothing else, in exactly this shape:

{
  "course": { "id": "short-slug", "name": "Course title", "code": "PHIL 246" or null, "term": "Fall 2026" or null },
  "sessions": [
    {
      "date": "YYYY-MM-DD" or null,
      "label": "Week 2: Belief and the will",
      "readings": [
        { "id": "an-existing-id", "optional": false },
        { "new": { "title": "Full Title: With Subtitle", "authors": ["First Author"], "year": 1970,
                   "type": "article", "parent_id": null }, "optional": true }
      ]
    }
  ]
}

Rules.
- One entry in "sessions" per meeting, in the syllabus's own order.
- Use an existing "id" only when you are confident it is the same work: same author and same
  title, allowing for a different edition or translation. A different paper by the same author
  is not a match. When unsure, use "new" — a duplicate is easy to fix, a wrong match is not.
- "type" is one of: ${TYPES.join(', ')}. A chapter or section of a book that is already in the
  list may set "parent_id" to that book's id.
- Dates: resolve "Week 3, Tuesday" and the like only when the syllabus gives enough to do it (a
  start date and meeting days). Otherwise use null. Never guess a date.
- Mark readings described as optional, recommended or supplementary with "optional": true.
- If a session has no readings, still include it with an empty "readings" array.
- Titles in title case. Authors as full names, as the syllabus gives them.`;

export function buildSyllabusExport(doc) {
  const texts = (doc.texts || []).filter(t => t.status !== 'triage')
    .slice().sort((a, b) => (authorLine(a) || '').localeCompare(authorLine(b) || ''));
  const courses = doc.courses || [];
  const lines = [SYLLABUS_PROMPT, '', '---', '',
    'Paste the syllabus immediately below this line, then send.', '', '[SYLLABUS HERE]', '', '---', ''];
  if (courses.length) {
    lines.push('Courses already recorded (reuse the id only if this syllabus is the same course):');
    for (const c of courses) lines.push(`${c.id} — ${c.name}${c.term ? `, ${c.term}` : ''}`);
    lines.push('');
  }
  lines.push(`Texts already in the tracker (${texts.length}):`);
  for (const t of texts) {
    lines.push(`${t.id} — ${authorLine(t) || 'no author'}, ${t.title || '(untitled)'}${t.year ? ` (${t.year})` : ''}`);
  }
  return lines.join('\n');
}

// ── syllabus: paste-back ────────────────────────────────────────────

function extractObject(text) {
  let t = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('No JSON object found in that paste.');
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch (e) {
    throw new Error(`That paste is not valid JSON (${e.message}).`);
  }
}

function surnames(list) {
  return new Set((list || []).map(n => fold(String(n).trim().split(/\s+/).pop() || '')).filter(Boolean));
}

/**
 * Is a proposed new reading probably a text already in the tracker? The model
 * was told to prefer "new" when unsure, so this catches the cautious misses:
 * the same title, or one title containing the other with an author in common.
 */
function probableMatch(fresh, texts) {
  const ft = fold(fresh.title);
  const fs = surnames(fresh.authors);
  let best = null;
  for (const t of texts) {
    const tt = fold(t.title || '');
    if (!tt || !ft) continue;
    const sameTitle = tt === ft;
    const contains = (tt.includes(ft) || ft.includes(tt)) && Math.min(tt.length, ft.length) >= 12;
    const shared = [...surnames(t.authors)].some(x => fs.has(x));
    if (sameTitle && (shared || !fs.size || !(t.authors || []).length)) return t;
    if (contains && shared && !best) best = t;
  }
  return best;
}

/**
 * Validate a pasted syllabus. Nothing is written here.
 *
 * @returns {{ course, sessions, fresh, errors: string[], warnings: string[], existingCourse }}
 *   `sessions[i].items` are { kind: 'existing', id, optional } or
 *   { kind: 'fresh', key, optional }; `fresh` lists each distinct new reading
 *   once, however many sessions assign it, with any probable match.
 */
export function parseSyllabus(text, doc) {
  const errors = [];
  const warnings = [];
  let obj;
  try {
    obj = extractObject(text);
  } catch (e) {
    return { course: null, sessions: [], fresh: [], errors: [e.message], warnings };
  }
  const texts = (doc.texts || []).filter(t => t.status !== 'triage');
  const byId = new Map((doc.texts || []).map(t => [t.id, t]));

  const c = obj.course || {};
  const name = String(c.name || '').trim();
  if (!name) errors.push('The course has no name.');
  const id = slugify(String(c.id || name || '').trim()) || 'course';
  const course = {
    id,
    name,
    code: c.code ? String(c.code).trim() : null,
    term: c.term ? String(c.term).trim() : null,
  };
  const existingCourse = (doc.courses || []).find(x => x.id === id) || null;

  if (!Array.isArray(obj.sessions)) {
    errors.push('There is no "sessions" array.');
    return { course, sessions: [], fresh: [], errors, warnings, existingCourse };
  }

  const fresh = new Map();
  const sessions = obj.sessions.map((s, si) => {
    const where = `Session ${si + 1}`;
    let date = s && s.date != null ? String(s.date).trim() : null;
    if (date && !validISODate(date)) {
      warnings.push(`${where} has a date that is not YYYY-MM-DD ("${date}"); it will be left undated.`);
      date = null;
    }
    const label = String((s && s.label) || '').trim() || `Session ${si + 1}`;
    const items = [];
    for (const [ri, r] of ((s && s.readings) || []).entries()) {
      const optional = !!(r && r.optional);
      if (r && r.id) {
        if (!byId.has(r.id)) {
          errors.push(`${where}, reading ${ri + 1}: no text with id "${r.id}". Ask for it as a new reading instead.`);
          continue;
        }
        items.push({ kind: 'existing', id: r.id, optional });
        continue;
      }
      const n = r && r.new;
      if (!n || !String(n.title || '').trim()) {
        errors.push(`${where}, reading ${ri + 1}: neither an existing id nor a new reading with a title.`);
        continue;
      }
      const authors = Array.isArray(n.authors) ? n.authors.map(a => String(a).trim()).filter(Boolean) : [];
      const title = String(n.title).trim();
      const key = `${fold(title)}|${[...surnames(authors)].sort().join(',')}`;
      if (!fresh.has(key)) {
        let type = String(n.type || 'article').toLowerCase();
        if (!TYPES.includes(type)) {
          warnings.push(`"${title}" has type "${n.type}", which is not one of ${TYPES.join(', ')}; using article.`);
          type = 'article';
        }
        let parent = n.parent_id ? String(n.parent_id) : null;
        if (parent && !byId.has(parent)) {
          warnings.push(`"${title}" names a parent "${parent}" that is not in the tracker; it will be left unnested.`);
          parent = null;
        }
        const year = Number.isInteger(Number(n.year)) && Number(n.year) > 0 ? Number(n.year) : null;
        // Everything below `sessions` is editable in the review before anything
        // is written; `ai` keeps the chat's version once Crossref overwrites it.
        const entry = {
          key, title, authors, year, type, parent_id: parent, sessions: 0,
          pages: null, doi: null, isbn: null, journal: null, container: null,
          include: true, crossref: null, ai: null, touched: false,
        };
        entry.match = probableMatch(entry, texts);
        entry.useExisting = !!entry.match;
        fresh.set(key, entry);
      }
      fresh.get(key).sessions += 1;
      items.push({ kind: 'fresh', key, optional });
    }
    return { date, label, items };
  });

  if (!sessions.length) warnings.push('The syllabus came back with no sessions.');
  const undated = sessions.filter(s => !s.date).length;
  if (undated && undated === sessions.length) warnings.push('No session has a date. You can add them by hand afterwards.');
  else if (undated) warnings.push(`${undated} session${undated === 1 ? ' has' : 's have'} no date.`);

  return { course, sessions, fresh: [...fresh.values()], errors, warnings, existingCourse };
}

/**
 * Write a validated syllabus into the document. Call inside mutate().
 *
 * @param {Map<string, string>} choice fresh key → 'create' | 'skip' | an existing text id
 */
export function applySyllabus(d, parsed, choice) {
  d.courses = d.courses || [];
  let course = d.courses.find(c => c.id === parsed.course.id);
  const isNew = !course;
  if (!course) {
    course = { ...parsed.course, sessions: [] };
    d.courses.push(course);
  } else {
    // Fill what the record lacks; never overwrite what the reader typed.
    for (const k of ['name', 'code', 'term']) if (!course[k] && parsed.course[k]) course[k] = parsed.course[k];
  }

  const taken = new Set(d.texts.map(t => t.id));
  const resolved = new Map();
  let created = 0;
  for (const f of parsed.fresh) {
    const c = choice.get(f.key) || 'create';
    if (c === 'skip') continue;
    if (c !== 'create') { resolved.set(f.key, c); continue; }
    const id = uniqueId(slugify(f.title), taken);
    taken.add(id);
    // Queued, not read: a syllabus says what was assigned, not what was done.
    // Source `coursework` because an instructor chose it, which is a selection
    // process of its own (§3). No `confidence: syllabus` — that flag exists to
    // keep unconfirmed *read* rows out of the corpus, and these are not read.
    const extra = {};
    for (const k of ['pages', 'doi', 'isbn', 'journal']) if (f[k] != null && f[k] !== '') extra[k] = f[k];
    const row = newText({
      id, title: f.title, authors: f.authors, year: f.year, type: f.type,
      parent_id: f.parent_id, status: 'queued', source: 'coursework',
      // A linked parent wins over a named one (§3), so never store both.
      container: f.parent_id ? null : (f.container || null),
      date_added: todayISO(), source_notes: 'syllabus-import', extra,
    });
    row.import.courses = [course.id];
    d.texts.push(row);
    resolved.set(f.key, id);
    created += 1;
  }

  let linked = 0;
  for (const s of parsed.sessions) {
    const text_ids = [];
    const optional_ids = [];
    for (const it of s.items) {
      const id = it.kind === 'existing' ? it.id : resolved.get(it.key);
      if (!id) continue;
      if (!text_ids.includes(id)) { text_ids.push(id); linked += 1; }
      if (it.optional && !optional_ids.includes(id)) optional_ids.push(id);
    }
    const same = course.sessions.find(x => (x.date || null) === (s.date || null) && (x.label || '') === s.label);
    if (same) {
      for (const id of text_ids) if (!(same.text_ids || []).includes(id)) (same.text_ids = same.text_ids || []).push(id);
      for (const id of optional_ids) if (!(same.optional_ids || []).includes(id)) (same.optional_ids = same.optional_ids || []).push(id);
    } else {
      course.sessions.push({ id: nextSubItemId(course.sessions, 's'), date: s.date, label: s.label, text_ids, optional_ids });
    }
  }
  course.sessions = sortSessions(course.sessions);
  return { courseId: course.id, isNew, created, linked };
}

// ── syllabus: catalogue lookup ──────────────────────────────────────
//
// Each new reading is looked up when the paste is checked, and can be looked up
// again by hand. §10 warns that a title search is not proof of identity: search
// a book's title and Crossref's top hit can be a review of it, same title,
// different author. So a result fills an entry only when it has authors, they
// agree with the syllabus's, and the titles match; anything else is left as
// the chat gave it and marked for a look. Nothing reaches the file until Apply,
// and the review is the human look §10 asks for.

function titleClose(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
  return (x.includes(y) || y.includes(x)) && Math.min(x.length, y.length) >= 12;
}

export async function autoMatch(f) {
  if (!f.authors.length) {
    return { status: 'unsure', reason: 'the syllabus gives no author to check a match against' };
  }
  let found;
  try {
    found = await lookup(f.title, { author: f.authors[0] });
    // An empty answer for a well-known paper turned out to be transient in
    // testing — "Two Dogmas of Empiricism" came back with nothing once and with
    // five records a moment later. One retry before calling it absent.
    if (!found.length) {
      await new Promise(r => setTimeout(r, 900));
      found = await lookup(f.title, { author: f.authors[0] });
    }
  } catch (e) {
    return { status: 'error', message: e.message };
  }
  if (!found.length) {
    return found.failed
      ? { status: 'error', message: `${found.failed.join(' and ')} did not answer — usually a rate limit. Look it up again in a moment.` }
      : { status: 'none' };
  }
  const top = rankCandidates(found, f)[0];
  if ((top.authors || []).length && authorsAgree(f, top) && titleClose(f.title, top.title)) {
    return { status: 'matched', candidate: top };
  }
  return {
    status: 'unsure',
    reason: (top.authors || []).length && !authorsAgree(f, top)
      ? `the closest record is by ${top.authors.slice(0, 2).join(' & ')}`
      : 'the closest record has a different title',
  };
}

/** Overwrite an entry from a catalogue record, keeping the chat's version to undo to. */
export function fillFromCandidate(f, c) {
  if (!f.ai) f.ai = { title: f.title, authors: [...f.authors], year: f.year, type: f.type, pages: f.pages };
  if (c.title) f.title = c.title;
  if ((c.authors || []).length) f.authors = [...c.authors];
  if (c.year) f.year = c.year;
  // A reading the chat nested under a book keeps its type; a title search on a
  // chapter can surface the whole book.
  if (c.type && TYPES.includes(c.type) && !f.parent_id) f.type = c.type;
  for (const k of ['pages', 'doi', 'isbn', 'journal', 'container']) f[k] = c[k] ?? null;
}

export function revertToAI(f) {
  if (!f.ai) return;
  Object.assign(f, f.ai, { doi: null, isbn: null, journal: null, container: null });
  f.ai = null;
}
