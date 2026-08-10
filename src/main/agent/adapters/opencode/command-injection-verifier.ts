import fs from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import type { SubmissionContext, SubmissionVerifier } from '../../../../shared/types';
import { loadBetterSqlite3, openCodeDbPath } from './session-history-parser';

/**
 * OpenCode's `command-injection` verifier. CONFIRM-ONLY.
 *
 * Confirm-only despite a clean measurement, because of the remote-session case
 * at the bottom of this comment - the one adapter here with a KNOWN wrong
 * answer rather than an unproven one. See
 * `OpenCodeAdapter.canEscalateOnVerificationFailure`.
 *
 * MEASURED, NOT ASSUMED (scripts/measure-injection-flush.mjs, 2026-08-09):
 *   short prompt: 64ms, 64ms   (turn ~2.4-2.6s)
 *   long prompt:  95ms, 64ms   (turn ~5.0-7.3s)
 * Flat against a turn 75x longer, so the row is written on SUBMIT. Worst
 * observed 95ms. Measuring it required teaching the harness to QUERY the
 * database rather than scan bytes - a SQLite page is not observable as text,
 * and an earlier file-scanning run reported "never landed" for rows that had in
 * fact been written promptly.
 *
 * OpenCode is the only adapter that does NOT read an appendable text file, so
 * it cannot use the shared bounded tail read at all: every session lives in one
 * shared SQLite database (`~/.local/share/opencode/opencode.db`, WAL mode).
 * This queries that DB read-only instead, reusing the same lazy
 * `loadBetterSqlite3` loader and the schema already verified against a real
 * install (OpenCode 1.14.25):
 *
 *   message(id, session_id, time_created, data)  data JSON: { role, ... }
 *   part(message_id, session_id, time_created, data)  data.type === 'text'
 *
 * A user turn's text is the concatenation of its message's `text` parts, which
 * is why this needs two queries rather than one.
 *
 * SLASH COMMANDS ARE NOT VERIFIED (see `canVerifySlashSubmission`). Like Codex,
 * OpenCode handles `/...` in the TUI and writes no row for it, so absence
 * cannot distinguish "rejected" from "ran client-side".
 *
 * REMOTE SESSIONS HAVE NO LOCAL ROW, AND THAT IS A KNOWN WRONG ANSWER.
 * `opencode-adapter.ts` returns null from `locateSessionHistoryFile` for a
 * remote target by design. Here the query simply finds nothing, so every poll
 * returns false, the burst exhausts its retries, and a perfectly delivered
 * auto_command is reported `failed`.
 *
 * There is no seam to fix it at. `getSubmissionVerifier` receives only a
 * context type, so it cannot consult `remoteTargetsByCwd` the way
 * `locateSessionHistoryFile` does; and once running, this function's contract
 * is a boolean in which "cannot observe" and "observed absence" must BOTH
 * return false, or the caller would stop polling during the normal first few
 * hundred milliseconds after a spawn.
 *
 * So the containment is one rung up: escalation is off for this adapter, which
 * bounds the damage to a spurious notice instead of a restart of a healthy
 * remote session on every single delivery. Expressing "cannot observe" would
 * mean widening the verifier contract, which is the real fix and is not
 * attempted here.
 */

/** Clock-skew tolerance, matching the shared scan. */
const SENT_AT_TOLERANCE_MS = 50;

/**
 * How many recent user messages to inspect. The scan only ever needs turns
 * written since `sentAt` (a few hundred milliseconds), so a small bound keeps
 * the query cheap at a 25ms poll cadence.
 */
const RECENT_MESSAGE_LIMIT = 12;

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}
interface PartRow {
  message_id: string;
  data: string;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pure row-to-text mapping, split from the SQLite I/O so it can be unit tested
 * without the native better-sqlite3 binding (which cannot load under a
 * stand-alone Node runtime). Mirrors `mapOpenCodeRows` in transcript-parser.ts.
 */
export function findOpenCodeSubmittedText(
  messageRows: MessageRow[],
  partRows: PartRow[],
  text: string,
  sentAt: number,
): boolean {
  const expected = text.trim();
  if (!expected) return false;

  const partsByMessage = new Map<string, string[]>();
  for (const row of partRows) {
    const data = tryParseJson(row.data);
    if (!isRecord(data)) continue;
    if (data.type !== 'text') continue;
    const value = data.text;
    if (typeof value !== 'string') continue;
    const bucket = partsByMessage.get(row.message_id) ?? [];
    bucket.push(value);
    partsByMessage.set(row.message_id, bucket);
  }

  for (const messageRow of messageRows) {
    const data = tryParseJson(messageRow.data);
    if (!isRecord(data)) continue;
    if (data.role !== 'user') continue;
    // `time_created` is epoch MILLISECONDS in this schema.
    if (messageRow.time_created < sentAt - SENT_AT_TOLERANCE_MS) continue;
    const combined = (partsByMessage.get(messageRow.id) ?? []).join('');
    if (combined.trim() === expected) return true;
  }
  return false;
}

function queryForSubmittedText(
  dbPath: string,
  sessionId: string,
  text: string,
  sentAt: number,
): boolean {
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) return false;

  let database: DatabaseType.Database | null = null;
  try {
    // Read-only, and never touch journal mode: OpenCode owns this DB and holds
    // it in WAL.
    database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    const messageRows = database
      .prepare<[string, number], MessageRow>(
        `SELECT id, time_created, data FROM message
         WHERE session_id = ? AND time_created >= ?
         ORDER BY time_created DESC LIMIT ${RECENT_MESSAGE_LIMIT}`,
      )
      .all(sessionId, sentAt - SENT_AT_TOLERANCE_MS);
    if (messageRows.length === 0) return false;

    // Bounded to the messages just fetched. `part` holds one row per streamed
    // chunk for EVERY message in the session, so it grows with the whole
    // conversation while the scan only ever reads parts belonging to a
    // `messageRows` entry - every other row was fetched and JSON-parsed for
    // nothing. The identical query in `transcript-parser.ts` is a one-shot
    // transcript read and can afford that; this one runs on a 25ms poll, and
    // better-sqlite3 is synchronous, so an unbounded scan blocks the thread
    // that services IPC up to 40 times a second per in-flight burst.
    const messageIdPlaceholders = messageRows.map(() => '?').join(', ');
    const partRows = database
      .prepare<string[], PartRow>(
        `SELECT message_id, data FROM part
         WHERE session_id = ? AND message_id IN (${messageIdPlaceholders})
         ORDER BY time_created ASC`,
      )
      .all(sessionId, ...messageRows.map((messageRow) => messageRow.id));

    return findOpenCodeSubmittedText(messageRows, partRows, text, sentAt);
  } catch {
    // A locked or mid-write DB is a "not seen yet", never a verified failure.
    return false;
  } finally {
    if (database) {
      try {
        database.close();
      } catch {
        /* already closed */
      }
    }
  }
}

export function createOpenCodeCommandInjectionVerifier(): SubmissionVerifier {
  return async (context: SubmissionContext): Promise<boolean> => {
    if (context.type !== 'command-injection') return false;
    if (!context.agentSessionId) return false;

    const dbPath = openCodeDbPath();
    if (!fs.existsSync(dbPath)) return false;

    return queryForSubmittedText(
      dbPath,
      context.agentSessionId,
      context.text,
      context.sentAt ?? Date.now(),
    );
  };
}
