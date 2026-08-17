// Evaluation export and paste-back (spec §4, revised 2026-08-11).
//
// The scoring happens outside this app, in a chat. Not because that is more
// convenient — it is less — but because doing it in-page would mean a model API
// key in localStorage on a publicly served site. That is a second credential,
// and unlike the fine-grained PAT it cannot be scoped down to one private repo
// of reading notes. §9's security argument survives export-and-paste; it does
// not survive an embedded key.
//
// So this module does two things: build one self-contained document to hand
// over, and validate what comes back before a single field is written.

import { authorLine, sortKeyTitle, todayISO } from './model.js';

/** Seeded into `rubric.prose` the first time, then edited in the Evaluate view. */
export const DEFAULT_PROMPT = `You are helping a philosophy PhD student decide what to read next, and what is worth
making flashcards from. Below you will find: (1) the reader, (2) their projects and
subjects, (3) the corpus they have already read, and (4) the rows to be scored.

Score every row in (4) on three axes, 0-10.

ABSOLUTE VALUE. How much this raises the ceiling on what they can think and write
later, independent of any current project. The operational question is counterfactual
regret: would they regret never having read this? Score for what it would cost NOT to
have read it — not for how famous, canonical or heavily cited it is.

RELATIVE VALUE. How much it serves what they are working on now. If no project context
is given below, return null. Do not guess. A fabricated relative score is worse than a
missing one, because it is indistinguishable from a real one.

COST. Hours of effortful processing needed to extract the value: length x density x
prerequisite load x inverse familiarity. Not difficulty, and not page count. A short
dense paper can cost more than a long clear book.

Give a separate one-line reason for each of the two value axes:

  "reason_abs" — why that absolute value. What would it cost not to have read this?
  "reason_rel" — why that relative value, in terms of the projects below. If relative
                 value is null, set this to null too rather than explaining an absence.

Concrete in both cases: name the chapter, the argument, the move. "Canonical" is not a
reason; "the source of the quasi-memory device the Vaporization case runs on" is.

A BIAS YOU HAVE, WHICH YOU SHOULD CORRECT FOR. Your sense of what is worth reading
tracks what the literature discusses most: canonical, heavily cited, anglophone,
analytic. You will systematically undervalue an unpublished draft by their supervisor, a
recent paper nobody has cited yet, an untranslated work, and whatever niche subfield they
happen to work in. Correct for this deliberately rather than hoping it averages out.

ON THE "assessment" MARKS IN THE READ CORPUS. "good" means the hours paid off — the
reader would have regretted missing it. "bad" means they did not. It is not a record of
enjoyment: a grinding text can be "good". ABSENCE MEANS "NOT EVALUATED". It does not mean
"average". Most rows are unmarked; treat those as carrying no information whatsoever, and
do not let them pull anything toward the middle of the scale.

Use the marks to calibrate what the top and bottom of the scale mean FOR THIS READER. Do
NOT treat them as a target to resemble. Do not raise a score because a text is similar in
author or subject to something marked good. The marks are drawn from what was already
read, and what was already read was chosen by existing interests; treating them as a
target closes that loop and suppresses exactly the unfamiliar work that would raise the
ceiling — which is what absolute value is defined to measure.

Return a JSON array and nothing else:

[{"id": "some-row-id", "value_abs": 8.2, "value_rel": 6.4, "cost": 5.1,
  "reason_abs": "The locus classicus for the distinction between character and content.",
  "reason_rel": "Section IV needs exactly this to make the teleosemantic defence go through."}]

Use the exact "id" given. Omit any row you cannot judge rather than guessing at it.`;

export function promptOf(doc) {
  const p = ((doc && doc.rubric) || {}).prose;
  return (p && p.trim()) ? p : DEFAULT_PROMPT;
}

export function rubricVersion(doc) {
  return Number(((doc && doc.rubric) || {}).version) || 1;
}

// ── export ──────────────────────────────────────────────────────────

export const CORPUS_SCOPES = {
  pool: { label: 'Comparison pool', test: t => t.in_pool === true },
  marked: { label: 'Marked or with a verdict', test: t => t.assessment || (t.verdict || '').trim() },
  read: { label: 'Everything read', test: t => t.status === 'read' },
};

export const TARGET_SCOPES = {
  unscored: {
    label: 'Queued, not yet scored',
    test: t => (t.status === 'queued' || t.status === 'reading')
      && (t.predicted || {}).value_abs == null,
  },
  queue: { label: 'Everything queued', test: t => t.status === 'queued' || t.status === 'reading' },
  // §4: only the relative component goes stale between terms. The absolute
  // rubric can stand for years, so re-running the whole thing each term would
  // churn scores that were fine and lose their provenance for no gain.
  relative: {
    label: 'Already scored — relative value only',
    relativeOnly: true,
    test: t => (t.status === 'queued' || t.status === 'reading')
      && (t.predicted || {}).value_abs != null,
  },
};

function bib(t) {
  const bits = [authorLine(t), t.year || null, t.type !== 'article' ? t.type : null];
  if (t.pages) bits.push(`${t.pages} pp`);
  if (t.journal) bits.push(t.journal);
  return bits.filter(Boolean).join(', ');
}

function corpusLine(t) {
  const parts = [`- "${t.title}"`];
  const b = bib(t);
  if (b) parts.push(`— ${b}`);
  if (t.assessment) parts.push(`[assessment: ${t.assessment}]`);
  const v = (t.verdict || '').trim();
  if (v) parts.push(`\n    verdict: ${v}`);
  return parts.join(' ');
}

function targetLine(t, byId, relativeOnly) {
  const parts = [`- id: ${t.id}`, `"${t.title}"`];
  const b = bib(t);
  if (b) parts.push(`— ${b}`);
  const parent = t.parent_id && byId.get(t.parent_id);
  if (parent) parts.push(`[in: ${parent.title}]`);
  else if (t.container) parts.push(`[in: ${t.container}]`);
  if (relativeOnly) {
    // Carry the standing absolute score and cost so they are not re-derived,
    // and so an obviously wrong one can be spotted rather than silently kept.
    const p = t.predicted || {};
    parts.push(`\n    standing: absolute ${p.value_abs}, cost ${p.cost}`
      + (p.value_rel != null ? `, relative ${p.value_rel} (v${p.rel_version || p.rubric_version || '?'})` : ', relative not set'));
    if (p.reason_abs || p.reason) parts.push(`\n    absolute reason: ${p.reason_abs || p.reason}`);
  }
  return parts.join(' ');
}

/**
 * One self-contained document. Markdown rather than JSON because a human pastes
 * it into a conversation and has to be able to see what they are sending.
 */
export function buildExport(doc, { corpusScope = 'pool', targetScope = 'unscored' } = {}) {
  const texts = doc.texts || [];
  const byId = new Map(texts.map(t => [t.id, t]));
  const corpus = texts.filter(CORPUS_SCOPES[corpusScope].test)
    .sort((a, b) => sortKeyTitle(a).localeCompare(sortKeyTitle(b)));
  const targets = texts.filter(TARGET_SCOPES[targetScope].test)
    .sort((a, b) => sortKeyTitle(a).localeCompare(sortKeyTitle(b)));

  const out = [];
  out.push(promptOf(doc).trim());
  out.push('\n---\n');

  const reader = doc.reader || {};
  out.push('## 1. The reader\n');
  if (reader.stage) out.push(reader.stage);
  if (reader.standing_interests) out.push(`\nStanding interests: ${reader.standing_interests}`);
  if (!reader.stage && !reader.standing_interests) out.push('_Not recorded._');

  out.push('\n\n## 2. Projects and subjects\n');
  const projects = doc.projects || [];
  if (!projects.length) {
    out.push('_No projects recorded. Return null for relative value on every row._');
  }
  for (const p of projects) {
    out.push(`\n### Project: ${p.title}  (${p.status || 'no status'})\n`);
    if (p.summary) out.push(`${p.summary}\n`);
    else out.push('_No summary recorded — relative value cannot be judged for this project._\n');
    const open = (p.questions || []).filter(q => q.status === 'open');
    if (open.length) {
      out.push('\nOpen questions:');
      for (const q of open) out.push(`  - ${q.text}`);
    }
  }
  const subjects = doc.subjects || [];
  if (subjects.length) {
    out.push('\n### Subjects being learned\n');
    for (const sub of subjects) {
      const goal = (sub.goal || '').trim();
      out.push(`- ${sub.name} (${sub.status || 'active'})${goal ? ` — ${goal}` : ' — no goal recorded'}`);
    }
  }

  out.push(`\n\n## 3. Already read — ${corpus.length} texts (${CORPUS_SCOPES[corpusScope].label})\n`);
  const marked = corpus.filter(t => t.assessment).length;
  out.push(`_${marked} of these carry an assessment mark. The rest are unmarked, which means `
    + `not evaluated — not average._\n`);
  for (const t of corpus) out.push(corpusLine(t));

  const relativeOnly = !!TARGET_SCOPES[targetScope].relativeOnly;
  out.push(`\n\n## 4. To score — ${targets.length} rows\n`);
  if (relativeOnly) {
    out.push('**Relative value only.** These rows already carry an absolute value and a cost from '
      + 'an earlier pass, shown beneath each. Absolute value is stable and is NOT being '
      + 'reconsidered — do not return `value_abs`, `cost`, or `reason_abs`, and do not comment on '
      + 'them. Return only `value_rel` and `reason_rel`, judged against the project context in '
      + 'section 2 as it stands today. Omitting a field leaves it untouched; returning it as null '
      + 'clears it.\n');
  }
  for (const t of targets) out.push(targetLine(t, byId, relativeOnly));
  out.push(relativeOnly
    ? '\nReturn a JSON array of {id, value_rel, reason_rel} and nothing else.'
    : '\nReturn a JSON array covering these ids and nothing else.');

  return out.join('\n');
}

// ── paste-back ──────────────────────────────────────────────────────

const AXES = ['value_abs', 'value_rel', 'cost'];

function extractJSON(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('Nothing pasted.');
  // Tolerate a fenced block or surrounding chatter; the array is what matters.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON array found. Expected something starting with [ and ending with ].');
  }
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    throw new Error(`That is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array.');
  return parsed;
}

/**
 * Validate before anything is written. Unknown ids are refused rather than
 * skipped quietly — a wrong id usually means the wrong export was scored, and
 * silently dropping it would hide that.
 *
 * @returns {{rows: Array, errors: string[], warnings: string[]}}
 */
export function parseScores(text, doc) {
  const byId = new Map((doc.texts || []).map(t => [t.id, t]));
  const errors = [];
  const warnings = [];
  let raw;
  try {
    raw = extractJSON(text);
  } catch (e) {
    return { rows: [], errors: [e.message], warnings: [] };
  }

  const rows = [];
  const seen = new Set();
  raw.forEach((item, i) => {
    const where = `entry ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${where} is not an object.`);
      return;
    }
    const id = item.id;
    if (!id) { errors.push(`${where} has no id.`); return; }
    if (!byId.has(id)) { errors.push(`${where}: no text with id "${id}".`); return; }
    if (seen.has(id)) { errors.push(`${where}: "${id}" appears more than once.`); return; }
    seen.add(id);

    // An absent key and an explicit null mean different things, and conflating
    // them is how a relative-only rescore would wipe every absolute score.
    // Absent: leave whatever is on the row alone. Explicit null: clear it —
    // which is what the prompt asks for when there is no project context.
    const scores = {};
    const given = {};
    for (const axis of AXES) {
      if (!Object.prototype.hasOwnProperty.call(item, axis)) continue;
      given[axis] = true;
      const v = item[axis];
      if (v === null) { scores[axis] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`${where} ("${id}"): ${axis} is not a number.`); return; }
      if (n < 0 || n > 10) { errors.push(`${where} ("${id}"): ${axis} is ${n}, outside 0–10.`); return; }
      scores[axis] = n;
    }
    if (!Object.keys(given).length) {
      warnings.push(`"${id}" mentions no scores at all and will be skipped.`);
      return;
    }
    // Two reasons now, one per value axis. §4 says the axes decay at different
    // rates — absolute is stable for years, relative goes stale within a term —
    // so a relative-only rescore next term must be able to replace one without
    // touching the other. A single blended sentence could not be split later.
    // `reason` is still accepted: the first pass was scored under a prompt that
    // asked for one, and those rows should not be treated as unexplained.
    const reasonAbs = String(item.reason_abs || item.reason || '').trim();
    const reasonRel = String(item.reason_rel || '').trim();
    if (given.value_abs && !reasonAbs) {
      warnings.push(`"${id}" came back with no reason for absolute value.`);
    }
    if (given.value_rel && scores.value_rel != null && !reasonRel) {
      warnings.push(`"${id}" has a relative score but no reason for it.`);
    }
    rows.push({ id, row: byId.get(id), scores, given, reasonAbs, reasonRel });
  });

  if (!rows.length && !errors.length) errors.push('Nothing usable in that paste.');
  return { rows, errors, warnings };
}

/** What each row would change, for display before applying. */
export function scoreDiff(entry) {
  const cur = entry.row.predicted || {};
  const out = [];
  for (const axis of AXES) {
    if (!entry.given[axis]) continue;          // untouched, so not a change
    const before = cur[axis] == null ? null : Number(cur[axis]);
    const after = entry.scores[axis];
    if (before === after) continue;
    out.push({ field: axis, from: before, to: after });
  }
  const curAbs = cur.reason_abs || cur.reason || '';
  if (entry.reasonAbs && curAbs !== entry.reasonAbs) {
    out.push({ field: 'reason_abs', from: curAbs || null, to: entry.reasonAbs });
  }
  if (entry.reasonRel && (cur.reason_rel || '') !== entry.reasonRel) {
    out.push({ field: 'reason_rel', from: cur.reason_rel || null, to: entry.reasonRel });
  }
  return out;
}

/** Build the `predicted` block a row should end up with. */
/**
 * Merge onto whatever is already there, rather than replacing it.
 *
 * This is what makes §4's asymmetry workable. Absolute value is stable for
 * years; relative value is project-indexed and stale within a term. So a termly
 * pass must be able to rewrite relative value and leave absolute alone — which
 * a wholesale replacement cannot do, because the fields it was not given would
 * come back null.
 *
 * Each axis also records the prompt version that produced it, since after a
 * partial pass a single `rubric_version` for the row would be a lie: the
 * absolute score came from one generation and the relative from another.
 */
export function predictedBlock(entry, version) {
  const out = { ...(entry.row.predicted || {}) };
  for (const axis of AXES) {
    if (entry.given[axis]) out[axis] = entry.scores[axis];
  }
  if (entry.given.value_abs) {
    if (entry.reasonAbs) out.reason_abs = entry.reasonAbs;
    out.abs_version = version;
    out.abs_date = todayISO();
  }
  if (entry.given.value_rel) {
    if (entry.reasonRel) out.reason_rel = entry.reasonRel;
    else if (entry.scores.value_rel === null) delete out.reason_rel;
    out.rel_version = version;
    out.rel_date = todayISO();
  }
  if (entry.given.cost) { out.cost_version = version; }
  out.date = todayISO();
  out.rubric_version = version;      // the most recent pass to touch this row
  return out;
}
