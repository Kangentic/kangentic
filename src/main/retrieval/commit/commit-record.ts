import crypto from 'node:crypto';
import { estimateTokens } from '../token-estimate';
import type { ChunkInput } from '../types';

/**
 * A commit on the project's default branch as the memory index holds it: its
 * subject and body, the `commit` corpus, one document per commit keyed by sha.
 *
 * Tied to a task by where its subject was written. An agent writes a commit's
 * subject in its conversation before the commit exists, and the rebase-merged
 * commit on the default branch keeps it, so the task whose conversation first
 * mentions the subject, at or before the commit landed, is the task it came
 * from. Measured on this repository's 2,419 first-parent commits against the
 * tasks named by their merged pull requests: 1,254 of 1,272 right, 4 wrong, 14
 * left unlinked. A unique match alone linked only 278 of those, because later
 * sessions quote the subject too (a `git log`, a review). The phrase is the
 * subject's first eight words: the stored tool call is cut at 200 characters,
 * which a long subject after an absolute commit-message path does not survive.
 */

/** Bump when the text or chunking changes, so every commit re-indexes. */
export const COMMIT_RECORD_VERSION = 1;

/** `git log --format`: sha, committer time, subject, body, each record ended by RS. */
export const COMMIT_LOG_FORMAT = '%H%x1f%ct%x1f%s%x1f%b%x1e';

/** Characters of a commit's text kept, subject first. */
const COMMIT_TEXT_CHARS = 1_600;

/** Subject words the link phrase is made of. */
export const LINK_PHRASE_WORDS = 8;
/** A phrase shorter than this matches too much to name one task. */
const LINK_PHRASE_MIN_WORDS = 3;
/** A conversation may mention a subject this long after the commit's own time
 *  (clock skew between the agent's machine and the committer's). */
export const LINK_GRACE_MS = 60_000;

export interface CommitEntry {
  sha: string;
  /** Committer time, epoch ms. */
  committedMs: number;
  subject: string;
  body: string;
}

/** The records `git log --format=COMMIT_LOG_FORMAT` printed, in its order. */
export function parseCommitLog(stdout: string): CommitEntry[] {
  const commits: CommitEntry[] = [];
  for (const record of stdout.split('\x1e')) {
    const trimmed = record.replace(/^\s+/, '');
    if (!trimmed) continue;
    const [sha, seconds, subject, body] = trimmed.split('\x1f');
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha.trim())) continue;
    const committedMs = Number(seconds) * 1000;
    commits.push({
      sha: sha.trim(),
      committedMs: Number.isFinite(committedMs) ? committedMs : 0,
      subject: (subject ?? '').trim(),
      body: (body ?? '').trim(),
    });
  }
  return commits;
}

/**
 * A body without its trailer block (`Co-Authored-By:`, `Signed-off-by:`,
 * session links): the lines at its end that are all `Key: value`. They name who
 * and where, never what, and a session URL in the index is noise to a search.
 */
export function withoutTrailers(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  let start = end;
  while (start > 0 && /^[A-Za-z][A-Za-z0-9-]*: \S/.test(lines[start - 1].trim())) start -= 1;
  // Only a block that follows a blank line (or is the whole body) is a trailer block.
  if (start < end && (start === 0 || lines[start - 1].trim() === '')) end = start;
  return lines.slice(0, end).join('\n').trim();
}

/** A commit as one chunk: the subject, then the body without its trailers. */
export function commitChunks(commit: CommitEntry): ChunkInput[] {
  const body = withoutTrailers(commit.body);
  const text = (body ? `${commit.subject}\n\n${body}` : commit.subject).slice(0, COMMIT_TEXT_CHARS);
  if (!text.trim()) return [];
  return [{
    seq: 0,
    text,
    contentHash: crypto.createHash('sha1').update(text).digest('hex'),
    tokenEstimate: estimateTokens(text),
    role: 'commit',
    tsStart: commit.committedMs,
    tsEnd: commit.committedMs,
    turnUuidStart: null,
    turnUuidEnd: null,
  }];
}

/**
 * The FTS5 phrase a subject's task is found by: its first eight words, quoted
 * so operators in it are literal. Null for a subject too short to name a task.
 * Words are letters and digits only, the same separators the index's
 * unicode61 tokenizer uses, so the phrase tokenizes exactly as the text did.
 */
export function commitLinkPhrase(subject: string): string | null {
  const words = subject.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0).slice(0, LINK_PHRASE_WORDS);
  if (words.length < LINK_PHRASE_MIN_WORDS) return null;
  return `"${words.join(' ')}"`;
}

/** The first line of a commit chunk: its subject. */
export function commitSubjectOf(text: string): string {
  const newline = text.indexOf('\n');
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

/**
 * A subject as an agent is shown it: a squash-merge's trailing `(#812)` spelled
 * `(PR 812)`. A `#N` reads as a task everywhere an agent writes, and the Ask
 * answer parser would take the pull request's number for a task's.
 */
export function subjectForAgents(subject: string): string {
  return subject.replace(/\(#(\d+)\)/g, '(PR $1)');
}
