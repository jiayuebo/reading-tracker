// GitHub Contents API client (spec §2).
//
// One private repo, one file. Read returns base64 + a blob sha; every write
// must quote the last known sha or GitHub rejects it. That rejection is the
// whole conflict story — see store.js for what we do with it.

import { utf8ToBase64, base64ToUtf8 } from './codec.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(kind, message, { status = 0, detail = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind; // auth | access | missing | conflict | ratelimit | toolarge | network | server | unknown
    this.status = status;
    this.detail = detail;
  }
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function request(url, token, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: { ...headers(token), ...(init.headers || {}) } });
  } catch (e) {
    throw new GitHubError('network', 'Could not reach github.com. Check your connection.', { detail: String(e) });
  }
  if (res.ok) return res.json();

  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  const msg = (body && body.message) || res.statusText || 'Request failed';
  throw classify(res, msg, body);
}

function classify(res, msg, body) {
  const s = res.status;
  if (s === 401) {
    return new GitHubError('auth', 'Token rejected (401). It may be expired, revoked, or mistyped.', { status: s, detail: msg });
  }
  if (s === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      const when = reset ? new Date(reset).toLocaleTimeString() : 'shortly';
      return new GitHubError('ratelimit', `Rate limit reached. Resets at ${when}.`, { status: s, detail: msg });
    }
    return new GitHubError('access', `Forbidden (403). ${msg}`, { status: s, detail: msg });
  }
  if (s === 404) {
    return new GitHubError('missing', msg, { status: s, detail: msg });
  }
  if (s === 409) {
    return new GitHubError('conflict', 'The file changed on GitHub since this device last loaded it.', { status: s, detail: msg });
  }
  if (s === 422 && /sha|does not match|conflict/i.test(msg)) {
    return new GitHubError('conflict', 'The file changed on GitHub since this device last loaded it.', { status: s, detail: msg });
  }
  if (s === 413 || /too large/i.test(msg)) {
    return new GitHubError('toolarge', 'File is too large for the Contents API (1 MB limit).', { status: s, detail: msg });
  }
  if (s >= 500) {
    return new GitHubError('server', `GitHub is having trouble (${s}). Try again in a moment.`, { status: s, detail: msg });
  }
  return new GitHubError('unknown', `${msg} (HTTP ${s})`, { status: s, detail: body ? JSON.stringify(body) : msg });
}

/** Repo metadata. Fine-grained tokens always carry metadata:read, so this is a clean reachability probe. */
export async function checkRepo({ owner, repo, token }) {
  try {
    const r = await request(`${API}/repos/${owner}/${repo}`, token);
    return { ok: true, private: r.private, defaultBranch: r.default_branch };
  } catch (e) {
    if (e.kind === 'missing') {
      throw new GitHubError('access',
        `Cannot see ${owner}/${repo}. GitHub returns 404 rather than 403 for private repos a token cannot reach, so this usually means the token is not scoped to this repository.`,
        { status: 404 });
    }
    throw e;
  }
}

/**
 * Read a file of up to 100 MB.
 *
 * The Contents API only returns content inline for files of 1 MB or less, and
 * between 1 and 100 MB it refuses the default media type outright. data.json
 * was 669 KB at 422 rows and growing about 1.6 KB a row, so it crosses that
 * line at roughly 630 rows.
 *
 * So the request asks for the `object` media type, which answers at every size
 * up to 100 MB: with content inline when the file is small, and with metadata
 * and an empty content field when it is not. In the second case the content
 * comes from the Blobs API by the sha the first response supplied. Both paths
 * return the same base64 and go through the same UTF-8 decoder.
 *
 * `viaBlob` forces the second path, so it can be checked against the first on a
 * file small enough to read both ways.
 *
 * @returns {{text: string, sha: string, size: number, via: 'contents' | 'blob'}}
 */
export async function getFile({ owner, repo, path, token, viaBlob = false }) {
  let r;
  try {
    r = await request(`${API}/repos/${owner}/${repo}/contents/${path}`, token, {
      headers: { Accept: 'application/vnd.github.object+json' },
    });
  } catch (e) {
    if (e.kind === 'missing') {
      // Distinguish "no such file" from "token cannot see this repo at all".
      await checkRepo({ owner, repo, token }); // throws 'access' if the repo is unreachable
      throw new GitHubError('missing', `${path} does not exist in ${owner}/${repo}.`, { status: 404 });
    }
    throw e;
  }
  // The object media type wraps a directory listing as { entries: [...] }.
  if (Array.isArray(r) || Array.isArray(r.entries) || r.type === 'dir') {
    throw new GitHubError('unknown', `${path} is a directory, not a file.`);
  }

  let b64 = null;
  let via = 'contents';
  const inline = r.encoding === 'base64' && typeof r.content === 'string' && (r.content !== '' || !r.size);
  if (inline && !viaBlob) {
    b64 = r.content;
  } else {
    if (!r.sha) {
      throw new GitHubError('unknown', 'GitHub returned no content and no sha for the file.', { detail: r.encoding });
    }
    const blob = await request(`${API}/repos/${owner}/${repo}/git/blobs/${r.sha}`, token);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new GitHubError('toolarge',
        'GitHub would not return the file even through the Blobs API, which stops at 100 MB.',
        { detail: `${blob.encoding}, ${r.size} bytes` });
    }
    b64 = blob.content;
    via = 'blob';
  }

  let text;
  try {
    text = base64ToUtf8(b64);
  } catch (e) {
    throw new GitHubError('unknown', 'File content is not valid UTF-8 and was not decoded.', { detail: String(e) });
  }
  return { text, sha: r.sha, size: r.size, via };
}

/** @returns {{sha: string, commit: string}} */
export async function putFile({ owner, repo, path, token, text, sha, message }) {
  const body = {
    message: message || 'Update data.json',
    content: utf8ToBase64(text),
  };
  if (sha) body.sha = sha; // omitted only when creating the file for the first time
  const r = await request(`${API}/repos/${owner}/${repo}/contents/${path}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { sha: r.content.sha, commit: r.commit && r.commit.sha };
}
