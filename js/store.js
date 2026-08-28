// Application state, local mirror, and the sync state machine (spec §2).

import { getFile, putFile, GitHubError } from './github.js';
import { emptyDoc, validateDoc } from './model.js';

const LS = {
  token: 'rt.token',
  tokenSetAt: 'rt.tokenSetAt',
  owner: 'rt.owner',
  repo: 'rt.repo',
  cache: 'rt.cache',
  prefs: 'rt.prefs',
};

const DEFAULTS = { owner: 'jiayuebo', repo: 'reading-data', path: 'data.json' };
const AUTOSAVE_MS = 15000;

const DEFAULT_PREFS = {
  w: 0.7,          // spec §4: weight on absolute value
  alpha: 0.7,      // spec §4: small-item correction
  sort: 'smart',
  group: true,       // nest chapters under their book by default
  lookup: true,      // DOI/ISBN/title metadata lookup (Settings can switch it off)
  filters: { q: '', project: '', type: '', familiarity: '', status: 'active' },
};

function lsGet(k, fallback = null) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function lsSet(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode / quota */ }
}
function lsJSON(k, fallback) {
  const raw = lsGet(k);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ── state ───────────────────────────────────────────────────────────

export const state = {
  doc: null,
  /**
   * Bumped whenever anything the view is built from changes — the document
   * or the preferences — and never for a sync-status change. The view is rebuilt from this, so a background autosave flipping
   * "dirty" to "saving" to "saved" no longer tears down and rebuilds every
   * field on screen, which is what was discarding text mid-typing.
   */
  rev: 0,
  sha: null,            // remote blob sha this doc is based on
  dirty: false,
  status: 'init',       // init|notoken|loading|clean|dirty|saving|saved|offline|conflict|error
  message: '',
  savedAt: null,
  loadedFrom: null,     // 'github' | 'cache' | 'import' | 'new'
  conflict: null,       // { remoteText, remoteSha, localText, detail }
  pendingRestore: null, // { cachedAt, sha, remoteChanged, doc }
  error: null,
  prefs: { ...DEFAULT_PREFS, ...lsJSON(LS.prefs, {}) },
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of [...listeners]) fn(state); }

// ── settings ────────────────────────────────────────────────────────

export const settings = {
  get token() { return lsGet(LS.token, ''); },
  set token(v) {
    lsSet(LS.token, v || null);
    if (v) lsSet(LS.tokenSetAt, new Date().toISOString());
    else lsSet(LS.tokenSetAt, null);
  },
  get tokenSetAt() { return lsGet(LS.tokenSetAt, null); },
  get owner() { return lsGet(LS.owner, DEFAULTS.owner); },
  set owner(v) { lsSet(LS.owner, v || null); },
  get repo() { return lsGet(LS.repo, DEFAULTS.repo); },
  set repo(v) { lsSet(LS.repo, v || null); },
  get path() { return DEFAULTS.path; },
  get hasToken() { return !!this.token; },
};

export function savePrefs(patch) {
  Object.assign(state.prefs, patch);
  lsSet(LS.prefs, JSON.stringify(state.prefs));
  // Sort, filters and the weight sliders all change what the view shows, so
  // this counts as a change the view is built from — unlike a save status.
  state.rev++;
  emit();
}

// ── serialization ───────────────────────────────────────────────────

/**
 * Two-space indent with non-ASCII left unescaped. Verified byte-identical to
 * the file already in the repo, so the first save this app makes produces a
 * diff of the actual edit rather than a reformat of all 229 rows.
 */
export function serialize(doc = state.doc) {
  return JSON.stringify(doc, null, 2);
}

// ── local cache ─────────────────────────────────────────────────────

function writeCache() {
  if (!state.doc) return;
  try {
    localStorage.setItem(LS.cache, JSON.stringify({
      doc: state.doc,
      sha: state.sha,
      dirty: state.dirty,
      savedAt: state.savedAt,
      cachedAt: new Date().toISOString(),
    }));
  } catch (e) {
    // ~300 KB fits comfortably in a 5 MB quota; if it ever does not, say so
    // rather than letting the mirror silently stop working.
    state.message = 'Local backup failed (storage full). Your edits exist only in this tab until you save.';
    console.warn('cache write failed', e);
  }
}

function readCache() { return lsJSON(LS.cache, null); }
export function clearCache() { lsSet(LS.cache, null); }

// ── mutation ────────────────────────────────────────────────────────

let autosaveTimer = null;

/** Every change to the document goes through here. */
export function mutate(fn) {
  if (!state.doc) return;
  fn(state.doc);
  state.rev++;
  state.dirty = true;
  if (state.status !== 'conflict') {
    state.status = 'dirty';
    state.message = '';
  }
  writeCache();
  scheduleAutosave();
  emit();
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (!settings.hasToken || state.status === 'conflict') return;
  autosaveTimer = setTimeout(() => { save({ auto: true }); }, AUTOSAVE_MS);
}

export function cancelAutosave() { clearTimeout(autosaveTimer); }

// ── load ────────────────────────────────────────────────────────────

export async function load({ force = false } = {}) {
  const cache = readCache();

  if (!settings.hasToken) {
    if (cache && cache.doc) {
      state.doc = cache.doc;
      state.rev++;
      state.sha = cache.sha;
      state.dirty = !!cache.dirty;
      state.loadedFrom = 'cache';
    }
    state.status = 'notoken';
    state.message = 'No token set. Add one in Settings to sync with GitHub.';
    emit();
    return;
  }

  state.status = 'loading';
  state.message = 'Loading from GitHub…';
  state.error = null;
  emit();

  let remote;
  try {
    remote = await getFile({
      owner: settings.owner, repo: settings.repo, path: settings.path, token: settings.token,
    });
  } catch (e) {
    // Offline or unreachable: fall back to the mirror rather than showing nothing.
    if (cache && cache.doc && !force) {
      state.doc = cache.doc;
      state.rev++;
      state.sha = cache.sha;
      state.dirty = !!cache.dirty;
      state.loadedFrom = 'cache';
      state.status = e.kind === 'network' ? 'offline' : 'error';
      state.error = e;
      state.message = `${e.message} Showing this device's cached copy${cache.dirty ? ' with unsaved edits' : ''}.`;
    } else {
      state.status = e.kind === 'network' ? 'offline' : 'error';
      state.error = e;
      state.message = e.message;
    }
    emit();
    return;
  }

  let remoteDoc;
  try {
    remoteDoc = JSON.parse(remote.text);
  } catch (e) {
    state.status = 'error';
    state.message = 'data.json on GitHub is not valid JSON. Refusing to load it.';
    state.error = e;
    emit();
    return;
  }

  // Spec §2: if the cached copy is newer than the remote, offer to restore.
  // Never decide this silently in either direction.
  if (!force && cache && cache.doc && cache.dirty) {
    state.pendingRestore = {
      cachedAt: cache.cachedAt,
      doc: cache.doc,
      sha: cache.sha,
      remoteChanged: cache.sha !== remote.sha,
    };
  }

  state.doc = remoteDoc;

  state.rev++;
  state.sha = remote.sha;
  state.dirty = false;
  state.loadedFrom = 'github';
  state.status = 'clean';
  state.savedAt = null;
  state.message = '';
  writeCache();
  emit();
}

/** Resolve the load-time restore offer. */
export function resolveRestore(keepLocal) {
  const p = state.pendingRestore;
  state.pendingRestore = null;
  if (p && keepLocal) {
    state.doc = p.doc;
    state.rev++;
    state.dirty = true;
    state.status = 'dirty';
    state.loadedFrom = 'cache';
    // sha stays at the *remote* sha we just fetched, so the next save is a
    // clean fast-forward if nothing else changed, and a 409 if it did.
    writeCache();
  } else {
    writeCache();
  }
  emit();
}

// ── save ────────────────────────────────────────────────────────────

export async function save({ auto = false, message } = {}) {
  if (!state.doc) return false;
  if (!settings.hasToken) {
    state.status = 'notoken';
    state.message = 'No token set — cannot save to GitHub. Export the file instead.';
    emit();
    return false;
  }
  if (state.status === 'saving') return false;
  if (state.status === 'conflict') return false;
  // Nothing to write. Cmd-S on a clean document should not mint an empty commit.
  if (!state.dirty) return true;

  clearTimeout(autosaveTimer);
  state.status = 'saving';
  state.message = auto ? 'Autosaving…' : 'Saving…';
  emit();

  state.doc.updated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const text = serialize(state.doc);

  try {
    const r = await putFile({
      owner: settings.owner, repo: settings.repo, path: settings.path, token: settings.token,
      text, sha: state.sha, message: message || `Update data.json (${new Date().toLocaleString()})`,
    });
    state.sha = r.sha;
    state.dirty = false;
    state.savedAt = new Date();
    state.status = 'saved';
    state.message = '';
    writeCache();
    emit();
    return true;
  } catch (e) {
    if (e.kind === 'conflict') {
      await enterConflict(text, e);
      return false;
    }
    state.status = e.kind === 'network' ? 'offline' : 'error';
    state.error = e;
    state.message = e.message;
    writeCache(); // the edits are still local and still dirty
    emit();
    return false;
  }
}

/**
 * Spec §2: on 409, refetch, say plainly what happened, and hand the user their
 * pending edits as copyable JSON. No automatic merge — a single-file store has
 * no safe three-way merge, and a wrong one loses rows silently.
 */
async function enterConflict(localText, err) {
  state.status = 'conflict';
  state.message = 'This file changed on another device.';
  state.error = err;
  let remoteText = null, remoteSha = null;
  try {
    const remote = await getFile({
      owner: settings.owner, repo: settings.repo, path: settings.path, token: settings.token,
    });
    remoteText = remote.text;
    remoteSha = remote.sha;
  } catch { /* leave null; the dump below is the part that matters */ }
  state.conflict = { localText, remoteText, remoteSha, detail: err.detail || err.message };
  writeCache();
  emit();
}

/** Discard local edits and take the version on GitHub. */
export function resolveConflictTakeRemote() {
  const c = state.conflict;
  if (!c || !c.remoteText) return false;
  try {
    state.doc = JSON.parse(c.remoteText);
    state.rev++;
  } catch { return false; }
  state.sha = c.remoteSha;
  state.dirty = false;
  state.conflict = null;
  state.status = 'clean';
  state.message = "Reloaded GitHub's copy. Your previous edits were discarded.";
  writeCache();
  emit();
  return true;
}

/** Keep local edits and overwrite the remote, rebasing onto the newer sha. */
export function resolveConflictForceLocal() {
  const c = state.conflict;
  if (!c) return false;
  if (c.remoteSha) state.sha = c.remoteSha;
  state.conflict = null;
  state.status = 'dirty';
  state.dirty = true;
  state.message = 'Kept this device\'s version. Save again to overwrite GitHub.';
  writeCache();
  emit();
  return true;
}

// ── import / export ─────────────────────────────────────────────────

export function importDoc(obj, { from = 'import' } = {}) {
  const errs = validateDoc(obj);
  if (errs.length) return errs;
  state.doc = obj;
  state.rev++;
  state.dirty = true;
  state.status = 'dirty';
  state.loadedFrom = from;
  state.pendingRestore = null;
  state.message = 'Imported. Nothing has been sent to GitHub yet — press Save when you are ready.';
  writeCache();
  emit();
  return [];
}

export function startEmpty() {
  state.doc = emptyDoc();
  state.rev++;
  state.sha = null;
  state.dirty = false;
  state.loadedFrom = 'new';
  state.status = settings.hasToken ? 'clean' : 'notoken';
  emit();
}

// ── ambient ─────────────────────────────────────────────────────────

export function installGuards() {
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('online', () => {
    if (state.status === 'offline') { state.status = state.dirty ? 'dirty' : 'clean'; state.message = ''; emit(); }
  });
  window.addEventListener('offline', () => {
    state.status = 'offline';
    state.message = 'Offline. Edits are kept on this device and will save when you reconnect.';
    emit();
  });
}

export { GitHubError };
