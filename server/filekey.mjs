// Same-file key for the conflict alarm: an absolute path becomes a salted hash and the path itself is dropped.
// Pure: no I/O. The key never leaves the server (not in a view, a log line or a signal).
import { createHash } from 'node:crypto';
import { win32, posix } from 'node:path';

const VERBATIM = '\\\\?\\'; // the \\?\ prefix Windows puts before a long path
const VERBATIM_UNC = `${VERBATIM}UNC\\`;
const WINDOWS_PATH = /^(?:[A-Za-z]:|\\)/; // drive letter or a leading backslash (UNC included)

/**
 * @param {unknown} raw  a path from a tool input
 * @param {Buffer|string} salt  random per server start
 * @param {{maxChars:number, hashChars:number}} opts  conflict.maxPathChars, conflict.hashChars
 * @returns {string|null} `hashChars` hex characters, or null for anything that is not a plain absolute path
 */
export function fileKey(raw, salt, { maxChars, hashChars }) {
  if (typeof raw !== 'string' || raw.length > maxChars) return null;
  // A relative path says nothing about which folder it is relative to, so it is not counted.
  if (!win32.isAbsolute(raw) && !raw.startsWith('/')) return null;
  let path = raw;
  if (path.startsWith(VERBATIM_UNC)) path = `\\\\${path.slice(VERBATIM_UNC.length)}`;
  else if (path.startsWith(VERBATIM)) path = path.slice(VERBATIM.length);
  const norm = WINDOWS_PATH.test(path)
    ? win32.normalize(path).toLowerCase().replaceAll('/', '\\')
    : posix.normalize(path);
  const key = norm.replace(/[\\/]+$/, '');
  return createHash('sha256').update(salt).update('\0').update(key).digest('hex').slice(0, hashChars);
}
