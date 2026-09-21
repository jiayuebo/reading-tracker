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

// ── the six 2025–26 courses ─────────────────────────────────────────

/** Course keys found on texts' `import.courses` that have no record yet. */
export function legacyCourseKeys(doc, dismissed = []) {
  const recorded = new Set((doc.courses || []).map(c => c.id));
  const keys = new Set();
  for (const t of doc.texts || []) for (const k of (t.import || {}).courses || []) keys.add(k);
  return [...keys].filter(k => !recorded.has(k) && !dismissed.includes(k)).sort();
}

/** "ethics-of-belief-246" → "Ethics of belief 246". A starting name, meant to be edited. */
export function nameFromKey(key) {
  const words = String(key).split('-').filter(Boolean);
  if (!words.length) return key;
  const out = words.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function recordsFromTags(doc, keys) {
  return keys.map(key => ({
    id: key,
    name: nameFromKey(key),
    code: null,
    term: null,
    sessions: [{
      id: 's1',
      date: null,
      label: 'Readings',
      text_ids: (doc.texts || []).filter(t => ((t.import || {}).courses || []).includes(key)).map(t => t.id),
      optional_ids: [],
    }],
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
        const entry = { key, title, authors, year, type, parent_id: parent, sessions: 0 };
        entry.match = probableMatch(entry, texts);
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
    const row = newText({
      id, title: f.title, authors: f.authors, year: f.year, type: f.type,
      parent_id: f.parent_id, status: 'queued', source: 'coursework',
      date_added: todayISO(), source_notes: 'syllabus-import',
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
