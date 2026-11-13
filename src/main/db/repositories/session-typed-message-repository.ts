import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { normalizeForMatch } from '../../../shared/final-line-match';
import { writeTransaction } from '../transaction';

/** How many of a session's newest records are kept. A turn reads only its own, which are the newest. */
export const TYPED_MESSAGES_KEPT_PER_SESSION = 50;

/**
 * The key a typed message is recorded and looked up under: a SHA-256 of the
 * WHOLE text after `normalizeForMatch` (case, punctuation, markdown and runs of
 * whitespace and line breaks forgiven, the same forgiveness a Text match
 * reads with). No length cap: a long forwarded agent reply still matches.
 * Null for text with no words in it, which no Text match could read anyway.
 */
export function typedMessageKey(text: string): string | null {
  const normalized = normalizeForMatch(text);
  if (normalized === '') return null;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * What Kangentic itself typed into a session (#1078).
 *
 * The agent's transcript cannot tell Kangentic's text from a person's: a
 * column message pasted into the terminal, a keystroke-delivered nudge and a
 * message another agent sent all land as the user's own turn. A Text match on
 * the user's message must never read those as the user's words (the Design
 * contract itself names the sign-off phrase), so every text Kangentic types
 * is recorded here at the one chokepoint (`TerminalSubmit`) and the turn-end
 * read drops a transcript message whose key is recorded.
 *
 * Only a hash is kept, never the text, and the rows go with their session.
 */
export class SessionTypedMessageRepository {
  constructor(private db: Database.Database) {}

  /**
   * Record one text Kangentic typed into a session. Returns false, writing
   * nothing, when the text has no words or no `sessions` row exists (the
   * foreign key would refuse it). Prunes the session to its newest rows.
   */
  record(sessionId: string, text: string): boolean {
    const key = typedMessageKey(text);
    if (key === null) return false;
    // One write: the insert and its prune commit together.
    return writeTransaction(this.db, (): boolean => {
      const session = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as { id: string } | undefined;
      if (!session) return false;
      this.db.prepare(
        'INSERT INTO session_typed_messages (id, session_id, text_hash, created_at) VALUES (?, ?, ?, ?)',
      ).run(randomUUID(), sessionId, key, new Date().toISOString());
      this.db.prepare(`
        DELETE FROM session_typed_messages
        WHERE session_id = ? AND id NOT IN (
          SELECT id FROM session_typed_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
        )
      `).run(sessionId, sessionId, TYPED_MESSAGES_KEPT_PER_SESSION);
      return true;
    })();
  }

  /** Every recorded key for a session. */
  keysForSession(sessionId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT text_hash FROM session_typed_messages WHERE session_id = ?')
      .all(sessionId) as Array<{ text_hash: string }>;
    return new Set(rows.map((row) => row.text_hash));
  }
}
