// Shell: routing, the sync indicator, keyboard, and the two banners that have
// to interrupt (restore-from-cache and conflict).

import { h, mount, clear, isTyping } from './dom.js';
import {
  state, settings, load, save, subscribe, installGuards, resolveRestore, startEmpty,
} from './store.js';
import { renderQueue, queueKeys } from './views/queue.js';
import { renderTriage } from './views/triage.js';
import { renderBackfill, backfillKeys } from './views/backfill.js';
import { renderPool } from './views/pool.js';
import { renderEvaluate } from './views/evaluate.js';
import { renderSubjects, renderSubjectDetail } from './views/subjects.js';
import { renderDetail } from './views/detail.js';
import { renderSettings } from './views/settings.js';
import { quickLog, newTextDialog, conflictDialog, helpDialog } from './views/dialogs.js';

const view = document.getElementById('view');
const statusEl = document.getElementById('sync-status');
const bannerEl = document.getElementById('banner');
const navEl = document.getElementById('nav');

const ctx = {
  go: (hash) => { location.hash = hash; },
  rerender: () => schedule(true),
  quickLog: () => quickLog(ctx),
  newText: () => newTextDialog(ctx),
  toast,
};

// ── routing ─────────────────────────────────────────────────────────

function route() {
  const raw = (location.hash || '#/queue').replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: name || 'queue', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
}

let scheduled = false;
// Views keep state of their own that the store knows nothing about — which
// rows are ticked in the queue, where the backfill cursor is, which scope the
// evaluate view is on. Those call ctx.rerender() explicitly, and it has to
// rebuild the view even though neither the document nor the route moved.
let forceView = false;
function schedule(force) {
  if (force) forceView = true;
  if (scheduled) return;
  scheduled = true;
  // A microtask, not requestAnimationFrame: rAF can be withheld indefinitely in
  // a background tab, so opening the app in a tab you are not looking at would
  // leave it stuck on the loading screen until you focused it.
  queueMicrotask(() => { scheduled = false; render(); });
}

let lastRev = -1;
let lastRoute = '';
let lastDoc = null;

function render() {
  const r = route();
  const before = captureFocus();
  const scrollY = window.scrollY;

  renderNav(r);
  renderStatus();
  renderBanner();

  // A sync-status change is not a document change. Autosave fires on a timer
  // and walks the status from dirty to saving to saved, and rebuilding every
  // field on screen for that was throwing away whatever was half-typed in the
  // box the caret was sitting in. The chrome above always redraws; the view
  // below only when the document or the route actually moved.
  const routeKey = `${r.name}/${r.arg || ''}`;
  const unchanged = !forceView
    && state.doc
    && state.doc === lastDoc
    && state.rev === lastRev
    && routeKey === lastRoute;
  if (unchanged) {
    restoreFocus(before);
    maybeOpenConflict();
    return;
  }
  forceView = false;
  lastDoc = state.doc;
  lastRev = state.rev;
  lastRoute = routeKey;

  if (!state.doc) {
    renderWelcome(r);
  } else {
    try {
      if (r.name === 'triage') renderTriage(view, ctx);
      else if (r.name === 'backfill') renderBackfill(view, ctx);
      else if (r.name === 'pool') renderPool(view, ctx);
      else if (r.name === 'evaluate') renderEvaluate(view, ctx);
      else if (r.name === 'subjects') renderSubjects(view, ctx);
      else if (r.name === 'subject' && r.arg) renderSubjectDetail(view, ctx, r.arg);
      else if (r.name === 'text' && r.arg) renderDetail(view, ctx, r.arg);
      else if (r.name === 'settings') renderSettings(view, ctx);
      else renderQueue(view, ctx);
    } catch (err) {
      console.error(err);
      mount(view, h('div.empty',
        h('p', 'Something went wrong rendering this view.'),
        h('pre.dump', String(err && err.stack || err)),
        h('a.button', { href: '#/queue' }, 'Back to the queue')));
    }
  }

  restoreFocus(before);
  if (r.name === 'text' || r.name === 'triage' || r.name === 'subject') window.scrollTo(0, scrollY);
  maybeOpenConflict();
}

/** Re-rendering a whole view on each edit would otherwise eject the caret. */
function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.id || a === document.body) return null;
  const o = { id: a.id, tag: a.tagName };
  if (typeof a.selectionStart === 'number') { o.start = a.selectionStart; o.end = a.selectionEnd; }
  // Text fields commit on `change`, which fires at blur. So anything typed
  // since the field was focused exists only in the DOM, and a rebuild from the
  // stored document silently reverts it. Carry it across.
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'radio') {
    o.value = a.value;
  }
  return o;
}
function restoreFocus(o) {
  if (!o) return;
  const el = document.getElementById(o.id);
  if (!el) return;
  const same = el === document.activeElement;
  // Only for a field that was rebuilt underneath the caret, and only when the
  // rebuild actually changed what is in it — never overwrite a value the view
  // deliberately recomputed while the user was elsewhere.
  if (o.value != null && el.tagName === o.tag && !same && el.value !== o.value) {
    el.value = o.value;
  }
  if (same) return;
  el.focus();
  if (o.start != null && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(o.start, o.end); } catch { /* type doesn't support it */ }
  }
}

// ── chrome ──────────────────────────────────────────────────────────

function renderNav(r) {
  const texts = state.doc ? (state.doc.texts || []) : [];
  const triageCount = texts.filter(t => t.status === 'triage').length;
  mount(navEl,
    navLink('#/queue', 'Queue', r.name === 'queue'),
    // Triage empties out and stays empty; keep it out of the way once it has.
    triageCount || r.name === 'triage'
      ? navLink('#/triage', triageCount ? `Triage ${triageCount}` : 'Triage', r.name === 'triage')
      : null,
    navLink('#/backfill', 'Backfill', r.name === 'backfill'),
    navLink('#/subjects', 'Subjects', r.name === 'subjects' || r.name === 'subject'),
    navLink('#/pool', 'Pool', r.name === 'pool'),
    navLink('#/evaluate', 'Evaluate', r.name === 'evaluate'),
    navLink('#/settings', 'Settings', r.name === 'settings'),
  );
}

function navLink(href, label, current) {
  return h('a', { href, class: current ? 'current' : null, 'aria-current': current ? 'page' : null }, label);
}

const STATUS_TEXT = {
  init: () => ['', 'Starting…'],
  loading: () => ['busy', 'Loading…'],
  saving: () => ['busy', 'Saving…'],
  saved: () => ['ok', `Saved · ${state.savedAt ? state.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`],
  clean: () => ['ok', 'Synced'],
  dirty: () => ['warn', 'Unsaved changes'],
  offline: () => ['warn', 'Offline'],
  conflict: () => ['bad', 'Conflict'],
  notoken: () => ['warn', 'No token'],
  error: () => ['bad', 'Sync error'],
};

function renderStatus() {
  const [cls, text] = (STATUS_TEXT[state.status] || STATUS_TEXT.init)();
  mount(statusEl,
    h(`span.dot.${cls || 'idle'}`, { 'aria-hidden': 'true' }),
    h('span.status-text', text),
    state.dirty && state.status !== 'saving'
      ? h('button.small', { onclick: () => save({ message: 'Save from tracker' }) }, 'Save')
      : null,
    state.status === 'conflict'
      ? h('button.small', { onclick: () => conflictDialog(ctx) }, 'Resolve')
      : null,
    state.status === 'notoken'
      ? h('a.small', { href: '#/settings' }, 'Add one')
      : null,
  );
  statusEl.title = state.message || '';
}

function renderBanner() {
  clear(bannerEl);
  const p = state.pendingRestore;
  if (p) {
    const when = p.cachedAt ? new Date(p.cachedAt).toLocaleString() : 'earlier';
    bannerEl.append(h('div.banner',
      h('p',
        h('strong', 'This device has unsaved changes'),
        ` from ${when}${p.remoteChanged ? ', and data.json on GitHub has also changed since then' : ''}.`),
      h('div.actions',
        h('button.primary', { onclick: () => { resolveRestore(true); toast('Restored this device’s version. Save when ready.'); } }, 'Keep my local version'),
        h('button', { onclick: () => { resolveRestore(false); toast('Using the copy from GitHub.'); } }, 'Discard, use GitHub’s copy'),
      )));
    return;
  }
  if (state.message && (state.status === 'error' || state.status === 'offline')) {
    bannerEl.append(h('div.banner.warn', h('p', state.message),
      h('div.actions', h('button', { onclick: () => load() }, 'Try again'))));
  }
}

let conflictOpen = false;
// dialogs.js fires this on teardown; the native `close` event is not dependable.
document.addEventListener('modal-closed', () => { conflictOpen = false; });

function maybeOpenConflict() {
  if (state.status === 'conflict' && !conflictOpen && !document.querySelector('dialog.modal[open]')) {
    conflictOpen = true;
    if (!conflictDialog(ctx)) conflictOpen = false;
  }
}

function renderWelcome(r) {
  if (r.name === 'settings') { renderSettings(view, ctx); return; }
  mount(view,
    h('div.welcome',
      h('h1', 'Reading & study tracker'),
      state.status === 'loading'
        ? h('p', 'Loading data.json from GitHub…')
        : [
          h('p', 'This page is a shell. Everything in it lives in a private repository and is fetched at runtime, so there is nothing here until you supply a token.'),
          h('div.actions',
            h('a.button.primary', { href: '#/settings' }, 'Add a token'),
            h('button', { onclick: () => startEmpty() }, 'Start an empty file')),
          state.message ? h('p.notice.warn', state.message) : null,
        ],
    ));
}

// ── toast ───────────────────────────────────────────────────────────

let toastTimer = null;
function toast(text) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div#toast', { role: 'status' }); document.body.append(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ── keyboard (spec §8: keyboard-friendly) ───────────────────────────

let pendingG = false;
function keys(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save({ message: 'Save from tracker' });
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog.modal[open]')) return;

  if (isTyping()) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  if (pendingG) {
    pendingG = false;
    const map = { q: '#/queue', t: '#/triage', s: '#/settings', b: '#/backfill', p: '#/pool', e: '#/evaluate', u: '#/subjects' };
    if (map[e.key]) { e.preventDefault(); location.hash = map[e.key]; }
    return;
  }

  // The active view gets first refusal on a key, so Backfill can bind 1-5/s/u
  // without those becoming global shortcuts everywhere else.
  if (route().name === 'backfill' && backfillKeys(e, ctx)) return;
  if (route().name === 'queue' && queueKeys(e, ctx)) return;

  switch (e.key) {
    case 'g': pendingG = true; setTimeout(() => { pendingG = false; }, 900); break;
    case '/': {
      const q = document.getElementById('q');
      if (q) { e.preventDefault(); q.focus(); q.select(); }
      break;
    }
    case 'n': e.preventDefault(); ctx.newText(); break;
    case 'l': e.preventDefault(); ctx.quickLog(); break;
    case '?': e.preventDefault(); helpDialog(); break;
    case 'j': case 'k': {
      const rows = [...document.querySelectorAll('.row-main')];
      if (!rows.length) return;
      e.preventDefault();
      const i = rows.indexOf(document.activeElement);
      const next = e.key === 'j'
        ? Math.min(rows.length - 1, i < 0 ? 0 : i + 1)
        : Math.max(0, i < 0 ? 0 : i - 1);
      rows[next].focus();
      rows[next].scrollIntoView({ block: 'nearest' });
      break;
    }
    default: break;
  }
}

// ── boot ────────────────────────────────────────────────────────────

// Tells the boot guard in index.html that the module graph loaded and ran.
window.__trackerBooted = true;

subscribe(() => schedule());
window.addEventListener('hashchange', schedule);
document.addEventListener('keydown', keys);
installGuards();
render();
load();

// Surface anything that would otherwise die silently in the console.
window.addEventListener('error', e => console.error('[tracker]', e.error || e.message));
window.addEventListener('unhandledrejection', e => console.error('[tracker] unhandled', e.reason));
