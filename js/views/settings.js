// Settings (spec §5.11): token, sync, w/alpha, import/export.

import { h, mount } from '../dom.js';
import {
  state, settings, savePrefs, load, save, serialize, clearCache, importDoc, startEmpty,
} from '../store.js';
import { checkRepo, getFile } from '../github.js';
import { validateDoc } from '../model.js';

export function renderSettings(root, ctx) {
  const probe = h('p.probe-result');

  mount(root,
    h('header.view-head', h('h1', 'Settings')),

    h('section.card',
      h('h2', 'GitHub'),
      h('div.fields',
        h('div.field.wide',
          h('label', { for: 'token' }, 'Fine-grained personal access token'),
          h('input#token', {
            type: 'password', autocomplete: 'off', spellcheck: 'false',
            placeholder: settings.hasToken ? '•••••••• (stored on this device)' : 'github_pat_…',
            onchange: e => {
              const v = e.target.value.trim();
              if (!v) return;
              settings.token = v;
              e.target.value = '';
              ctx.rerender();
              load();
            },
          }),
          h('p.hint', 'Scope it to ', h('code', `${settings.owner}/${settings.repo}`),
            ' only, with Contents: Read and write and nothing else. Paste it here; it is never written into any file in the public repo.'),
        ),
        h('div.field', h('label', { for: 'owner' }, 'Owner'),
          h('input#owner', { type: 'text', value: settings.owner, onchange: e => { settings.owner = e.target.value.trim(); ctx.rerender(); } })),
        h('div.field', h('label', { for: 'repo' }, 'Data repo'),
          h('input#repo', { type: 'text', value: settings.repo, onchange: e => { settings.repo = e.target.value.trim(); ctx.rerender(); } })),
      ),
      tokenStatus(),
      h('div.actions',
        h('button', {
          onclick: async () => {
            probe.textContent = 'Checking…';
            probe.className = 'probe-result';
            try {
              const r = await checkRepo({ owner: settings.owner, repo: settings.repo, token: settings.token });
              const f = await getFile({ owner: settings.owner, repo: settings.repo, path: settings.path, token: settings.token });
              probe.className = 'probe-result ok';
              probe.textContent = `OK — ${settings.owner}/${settings.repo} is ${r.private ? 'private' : 'PUBLIC'}, data.json is ${fmtBytes(f.size)}, sha ${f.sha.slice(0, 7)}.`;
            } catch (e) {
              probe.className = 'probe-result bad';
              probe.textContent = e.message;
            }
          },
          disabled: !settings.hasToken,
        }, 'Test connection'),
        h('button', { onclick: () => load({ force: true }) }, 'Reload from GitHub'),
        h('button', { onclick: () => save({ message: 'Manual save from tracker' }), disabled: !state.dirty }, 'Save now'),
        settings.hasToken
          ? h('button.danger', {
            onclick: () => {
              if (!confirm('Forget the token on this device? Your data stays on GitHub.')) return;
              settings.token = '';
              ctx.rerender();
            },
          }, 'Forget token')
          : null,
      ),
      probe,
    ),

    h('section.card',
      h('h2', 'What this costs you, honestly'),
      h('p', 'This page is served publicly from ', h('code', 'reading-tracker'),
        ', and your token sits in this browser’s localStorage. Anyone with access to this device or browser profile can read it.'),
      h('p', 'The blast radius is bounded by how the token is scoped: it can read and write one private repo containing a reading list. It cannot touch other repos or your account settings.'),
      h('p', 'That trade holds ', h('strong', 'only while the page loads no third-party script'),
        '. This build loads none — no CDN, no web fonts, no analytics — and adding one later would change the calculus silently.'),
      h('p', 'Metadata lookup reaches two outside services — ', h('code', 'api.crossref.org'),
        ' for DOIs and article search, ', h('code', 'openlibrary.org'),
        ' for ISBNs and book page counts. A JSTOR link is resolved through its DOI at Crossref; '
        + 'jstor.org itself is never contacted, because it sends no CORS header and its own APIs '
        + 'need an institutional agreement. Both services are reached by ', h('em', 'fetching data'),
        ', not by loading code. A script from another origin could read your token; a JSON reply cannot, and is rendered as text. '
        + 'What it does cost is that those services see what you look up. No token and no identifying information is sent with the query.'),
      h('div.actions',
        h('label.check',
          h('input', {
            type: 'checkbox', checked: state.prefs.lookup !== false,
            onchange: e => { savePrefs({ lookup: e.target.checked }); ctx.rerender(); },
          }),
          h('span', 'Allow DOI / ISBN / title lookup'))),
    ),

    h('section.card',
      h('h2', 'Priority weights'),
      h('p.hint', 'These do nothing until something has a value and a cost. Nothing in the file does yet.'),
      h('div.fields',
        h('div.field', h('label', { for: 'w' }, 'Absolute weight (w)'),
          h('input#w', { type: 'number', min: 0, max: 1, step: 0.05, value: state.prefs.w, onchange: e => savePrefs({ w: clamp(e.target.value, 0, 1, 0.7) }) }),
          h('p.hint', 'value = w·absolute + (1−w)·relative. Starts high on absolute and shifts down the degree.')),
        h('div.field', h('label', { for: 'alpha' }, 'Cost exponent (alpha)'),
          h('input#alpha', { type: 'number', min: 0, max: 1.5, step: 0.05, value: state.prefs.alpha, onchange: e => savePrefs({ alpha: clamp(e.target.value, 0, 1.5, 0.7) }) }),
          h('p.hint', 'priority = value ÷ cost^alpha. Below 1 it corrects the bias toward short shallow items.')),
      ),
    ),

    h('section.card',
      h('h2', 'Export and import'),
      h('p.hint', 'The schema, not this app, is the durable asset. Export produces exactly the bytes that go to GitHub.'),
      h('div.actions',
        h('button.primary', { onclick: exportFile, disabled: !state.doc }, 'Export data.json'),
        importControl(ctx),
      ),
      h('p.hint', 'Import replaces everything in memory and marks it unsaved. Nothing reaches GitHub until you press Save.'),
    ),

    h('section.card',
      h('h2', 'This device'),
      h('dl.kv',
        h('dt', 'Loaded from'), h('dd', state.loadedFrom || '—'),
        h('dt', 'Base sha'), h('dd', h('code', state.sha ? state.sha.slice(0, 12) : '—')),
        h('dt', 'Texts'), h('dd', String((state.doc && state.doc.texts || []).length)),
        h('dt', 'Document updated'), h('dd', (state.doc && state.doc.updated) || '—'),
        h('dt', 'Serialized size'), h('dd', state.doc ? fmtBytes(new TextEncoder().encode(serialize()).length) : '—'),
      ),
      h('div.actions',
        h('button', {
          onclick: () => {
            if (!confirm('Clear this device’s cached copy? Unsaved edits on this device would be lost.')) return;
            clearCache();
            load({ force: true });
          },
        }, 'Clear local cache'),
        !state.doc ? h('button', { onclick: () => startEmpty() }, 'Start an empty file') : null,
      ),
    ),
  );
}

function tokenStatus() {
  if (!settings.hasToken) {
    return h('p.notice.warn', 'No token stored on this device. The app is read-only against whatever is cached locally.');
  }
  const setAt = settings.tokenSetAt ? new Date(settings.tokenSetAt) : null;
  if (!setAt) return h('p.notice.quiet', 'Token stored on this device.');
  const renew = new Date(setAt.getTime());
  renew.setFullYear(renew.getFullYear() + 1);
  const days = Math.round((renew - Date.now()) / 86400000);
  return h(`p.notice.${days < 30 ? 'warn' : 'quiet'}`,
    `Token stored ${setAt.toLocaleDateString()}. If you set a 1-year expiry, renew by ${renew.toLocaleDateString()} (${days} days).`);
}

function importControl(ctx) {
  const input = h('input', {
    type: 'file', accept: 'application/json,.json', style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let obj;
      try {
        obj = JSON.parse(await file.text());
      } catch (err) {
        alert(`That file is not valid JSON.\n\n${err.message}`);
        return;
      }
      const errs = validateDoc(obj);
      if (errs.length) {
        alert(`Refusing to import. Problems found:\n\n${errs.slice(0, 12).join('\n')}${errs.length > 12 ? `\n…and ${errs.length - 12} more.` : ''}`);
        return;
      }
      const n = obj.texts.length;
      if (state.doc && !confirm(`Replace the ${state.doc.texts.length} texts in memory with ${n} from ${file.name}?`)) return;
      importDoc(obj);
      ctx.rerender();
    },
  });
  return h('span', input, h('button', { onclick: () => input.click() }, 'Import data.json…'));
}

function exportFile() {
  const text = serialize();
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const a = h('a', { href: url, download: `data-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clamp(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
