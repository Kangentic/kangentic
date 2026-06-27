import type Database from 'better-sqlite3';

export interface TranscriptRecord {
  session_id: string;
  transcript: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export class TranscriptRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create an empty transcript row for a new session.
   * Call before any data arrives so appendChunk has a row to update.
   */
  create(sessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO session_transcripts (session_id, transcript, size_bytes, created_at, updated_at)
      VALUES (?, '', 0, ?, ?)
    `).run(sessionId, now, now);
  }

  /**
   * Append a chunk of ANSI-stripped text to the session's transcript.
   * Uses SQLite string concatenation for efficient append.
   */
  appendChunk(sessionId: string, chunk: string): void {
    const sizeBytes = Buffer.byteLength(chunk);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE session_transcripts
      SET transcript = transcript || ?, size_bytes = size_bytes + ?, updated_at = ?
      WHERE session_id = ?
    `).run(chunk, sizeBytes, now, sessionId);
  }

  /**
   * Get the full transcript for a session.
   * Returns null if no transcript exists.
   */
  getBySessionId(sessionId: string): TranscriptRecord | null {
    return this.db.prepare(
      'SELECT * FROM session_transcripts WHERE session_id = ?',
    ).get(sessionId) as TranscriptRecord | null;
  }

  /**
   * Get just the transcript text for a session.
   * More efficient than getBySessionId when you only need the content.
   */
  getTranscriptText(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT transcript FROM session_transcripts WHERE session_id = ?',
    ).get(sessionId) as { transcript: string } | undefined;
    return row?.transcript ?? null;
  }

  /**
   * Get the last `maxChars` characters of a session's transcript plus the
   * total character length, WITHOUT materializing the full transcript in JS.
   * SQLite computes the substring internally (`substr`), so a multi-MB
   * transcript stays on the C side and only the tail crosses into the JS heap.
   * Used by the raw `get_transcript` MCP path, which only ever shows the tail -
   * loading the whole blob there blocked the main loop for tens to hundreds of
   * ms on a verbose session. Returns null when no transcript row exists.
   */
  getTranscriptTail(sessionId: string, maxChars: number): {
    tail: string;
    fullLength: number;
    sizeBytes: number;
    createdAt: string;
    updatedAt: string;
  } | null {
    // substr(X, -N) returns the last N characters (or the whole string when
    // it is shorter). Bind the negative start directly.
    const row = this.db.prepare(`
      SELECT substr(transcript, ?) AS tail,
             length(transcript) AS full_length,
             size_bytes, created_at, updated_at
      FROM session_transcripts
      WHERE session_id = ?
    `).get(-Math.max(0, maxChars), sessionId) as {
      tail: string | null;
      full_length: number | null;
      size_bytes: number | null;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) return null;
    return {
      tail: row.tail ?? '',
      fullLength: row.full_length ?? 0,
      sizeBytes: row.size_bytes ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get the transcript size without loading the content.
   * Useful for UI display.
   */
  getSizeBytes(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT size_bytes FROM session_transcripts WHERE session_id = ?',
    ).get(sessionId) as { size_bytes: number } | undefined;
    return row?.size_bytes ?? 0;
  }
}
