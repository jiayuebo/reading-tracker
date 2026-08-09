// UTF-8 safe base64, for the GitHub Contents API.
//
// btoa() throws on any code point above U+00FF (em dash, Stojnić) and — worse —
// silently emits Latin-1 bytes for anything in U+0080..U+00FF (Salmón, Møller).
// The second failure mode corrupts data without raising anything, so the encode
// path must always go through TextEncoder. Verified byte-identical against the
// real 304 KB data.json before any of this app was written.

const CHUNK = 0x8000; // String.fromCharCode(...300k bytes) exceeds the argument limit

/** @param {string} str @returns {string} base64 */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** @param {string} b64 GitHub wraps its base64 at 60 columns @returns {string} */
export function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // fatal:true so malformed bytes throw instead of becoming U+FFFD replacement
  // characters, which would otherwise be written back and made permanent.
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
