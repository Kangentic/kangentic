// The path mapping every mirror write and read goes through, kept free of side effects so a unit
// test can import it. scripts/probe-ssh-mirror.mjs is the only caller.
import crypto from 'node:crypto';
import path from 'node:path';

// A superscript digit needs no entry here: mirrorSegment has already percent-encoded it, so `lpt` plus one is safe.
const RESERVED_STEM = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;
// NTFS allows 255. Claude's own slugs reach 207, so the cap sits above them, and an escaped name is longer.
export const MAXIMUM_SEGMENT = 240;
/** A shortened name cannot be undone by reading it, so the real mirror must persist this table. */
const shortenedSegments = new Map();

function percentEncode(text) {
  return [...Buffer.from(text, 'utf8')].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
}

/**
 * One host path segment as one safe NTFS segment. Injective under NTFS's case folding, and the identity
 * on lowercase ASCII, so UUIDs, `.jsonl` names and all-lowercase slugs are unchanged. Stateless, so a
 * reader computes the same name the writer did. `~` is escaped because `name~1.txt` can answer as the
 * 8.3 alias of another file, which also leaves `~~<digest>` free as the mark of a shortened name.
 */
export function mirrorSegment(segment) {
  let mapped = '';
  for (const character of segment) {
    if (/[a-z0-9._\- $+=,@()[\]{}!#&';^`]/.test(character)) mapped += character;
    else mapped += percentEncode(character);
  }
  mapped = mapped.replace(/[. ]+$/, (trailing) => [...trailing].map(percentEncode).join(''));
  const stem = mapped.split('.')[0];
  if (RESERVED_STEM.test(stem)) mapped = percentEncode(mapped[0]) + mapped.slice(1);
  if (mapped.length > MAXIMUM_SEGMENT) {
    const digest = crypto.createHash('sha256').update(segment).digest('hex').slice(0, 16);
    mapped = `${mapped.slice(0, MAXIMUM_SEGMENT - 18)}~~${digest}`;
    shortenedSegments.set(mapped, segment);
  }
  return mapped;
}

export function unmirrorSegment(mapped) {
  if (/~~[0-9a-f]{16}$/.test(mapped)) return shortenedSegments.get(mapped) ?? null;
  return Buffer.from(mapped.replace(/%([0-9a-f]{2})/g, (match, hex) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1').toString('utf8');
}

/** A host-relative path under the mirror root, or a throw when it would leave the root. */
export function mirrorPath(mirrorHome, hostRelative) {
  if (hostRelative.length === 0 || hostRelative.startsWith('/') || hostRelative.includes('\0')) throw new Error(`refused: ${JSON.stringify(hostRelative)}`);
  const segments = hostRelative.split('/');
  for (const segment of segments) if (segment === '' || segment === '.' || segment === '..') throw new Error(`refused: ${JSON.stringify(hostRelative)}`);
  return path.join(mirrorHome, ...segments.map(mirrorSegment));
}
