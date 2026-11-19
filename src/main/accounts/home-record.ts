import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPlainRecord } from '../agent/shared/plain-record';
import { safeWriteJson } from '../safe-write';

/**
 * What the default home held when an account folder was last refreshed (task #1118).
 *
 * A refresh copies and derives files from the home into the account folder, so a change made
 * from a session on that account is replaced at the account's next spawn. Telling that change
 * from one the home made needs a baseline, and the account's file is none: the CLI rewrites it
 * between refreshes (Claude changed eight shared keys of its state file in one session). So
 * each refresh records what the HOME held, as a hash per part of each judged entry, in one small
 * file in the account folder.
 *
 * - The account's own: a part whose hash differs from what the home held at the last refresh.
 * - Replaced: the account's own, and the refresh writes something else over it.
 *
 * The home's side is recorded, never what was written. A written file also carries the
 * account's own parts, so a server added on the account would read as unchanged on the day the
 * home adds one under the same name, and be replaced unnoticed.
 *
 * The file holds part names and hashes, never a value, and stays in the account folder.
 */
export const HOME_RECORD_FILE = '.kangentic-home-record.json';

const RECORD_VERSION = 1;

/** The one part of an entry that is a whole file. */
const WHOLE_FILE_PART = 'file';

/** U+FEFF, which some Windows editors write at the start of a UTF-8 file. */
const BYTE_ORDER_MARK = 0xfeff;

/**
 * The record's own `safeWriteJson` source, apart from the state file's `agent_account_state`.
 * The failure latch is kept per source, so a state file that saves must not clear the latch of
 * a record that does not.
 */
const RECORD_WRITE_SOURCE = 'agent_account_home_record';

/** The parts of one entry: what a user configures in it, by the names its declaration chose. */
export type EntryParts = Record<string, unknown>;

/** What the home held for an entry: each part's hash, or null when the home had no such file. */
export type EntryRecord = Record<string, string> | null;

export interface HomeRecord {
  /** What the home held for `entry`, or undefined when nothing was recorded for it yet. */
  get(entry: string): EntryRecord | undefined;
  set(entry: string, held: EntryRecord): void;
  /** Writes the record when it holds an entry and differs from what was read. */
  save(): void;
}

/** JSON with every object's keys in order, so the same content in another key order reads the same. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (isPlainRecord(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(sortedJson(value)).digest('hex');
}

/** Each part's hash. */
export function hashParts(parts: EntryParts): Record<string, string> {
  return Object.fromEntries(Object.entries(parts).map(([part, value]) => [part, hashOf(value)]));
}

/**
 * A whole file as an entry's one part. JSON is compared as parsed, so a CLI that re-indents the
 * file or writes its keys in another order has changed nothing. Any other text is compared with
 * its line endings made one kind. A leading byte order mark is no content either way:
 * `JSON.parse` refuses it, so a file saved with one and saved again without would read as changed.
 */
export function fileParts(text: string): EntryParts {
  const content = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  try {
    return { [WHOLE_FILE_PART]: { json: JSON.parse(content) as unknown } };
  } catch {
    // report-ok: text that is not JSON is an answer, not a failure: the text is the content.
    return { [WHOLE_FILE_PART]: { text: content.replace(/\r\n/g, '\n') } };
  }
}

/**
 * How many parts of the account's own a refresh replaces: parts the account holds differently
 * from what the home held, where `next` is something else again. A part the account removed
 * counts when `next` brings it back. `recorded` undefined means nothing was ever recorded for
 * the entry, so nothing can be told and nothing is counted; null means the home held nothing.
 */
export function countReplaced(recorded: EntryRecord | undefined, current: EntryParts, next: EntryParts): number {
  if (recorded === undefined) return 0;
  const homeHeld = new Map(Object.entries(recorded ?? {}));
  const accountHolds = new Map(Object.entries(hashParts(current)));
  const refreshWrites = new Map(Object.entries(hashParts(next)));
  let replaced = 0;
  for (const part of new Set([...homeHeld.keys(), ...accountHolds.keys(), ...refreshWrites.keys()])) {
    const held = accountHolds.get(part);
    if (held !== homeHeld.get(part) && held !== refreshWrites.get(part)) replaced += 1;
  }
  return replaced;
}

function readEntries(filePath: string): Map<string, EntryRecord> {
  const entries = new Map<string, EntryRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // report-ok: a missing or unreadable record is no record. This refresh judges nothing and
    // writes a new one.
    return entries;
  }
  if (!isPlainRecord(parsed) || parsed.version !== RECORD_VERSION || !isPlainRecord(parsed.entries)) return entries;
  for (const [entry, held] of Object.entries(parsed.entries)) {
    if (held === null) {
      entries.set(entry, null);
    } else if (isPlainRecord(held) && Object.values(held).every((hash) => typeof hash === 'string')) {
      entries.set(entry, held as Record<string, string>);
    }
  }
  return entries;
}

/** The record kept in `accountFolder`. A folder with none starts with nothing recorded. */
export function loadHomeRecord(accountFolder: string): HomeRecord {
  const filePath = path.join(accountFolder, HOME_RECORD_FILE);
  const entries = readEntries(filePath);
  const loaded = sortedJson(Object.fromEntries(entries));
  return {
    get: (entry) => entries.get(entry),
    set: (entry, held) => {
      entries.set(entry, held);
    },
    save: () => {
      if (entries.size === 0) return;
      const held = Object.fromEntries(entries);
      if (sortedJson(held) === loaded) return;
      safeWriteJson(filePath, { version: RECORD_VERSION, entries: held }, RECORD_WRITE_SOURCE, { mode: 0o600 });
    },
  };
}
