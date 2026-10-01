import type Database from 'better-sqlite3';

/**
 * A session's raw terminal transcript: the ANSI-stripped PTY output
 * `TranscriptWriter` captures, kept whole and never trimmed. It outlives its
 * session row on purpose (agent CLIs clean up their own session files, so this
 * is Kangentic's durable copy), which is why no trigger deletes it.
 *
 * Stored as ordered pieces in `session_transcript_chunks`, one row per flush,
 * so a flush is one INSERT. It used to be one growing TEXT value in
 * `session_transcripts`, where each flush rewrote the whole value: 127 to 164
 * ms for a 19 MB transcript. Rows still in that legacy table are read as the
 * oldest part of the transcript until the retrieval worker converts them to
 * pieces (negative `seq`, so they sort ahead of anything written since).
 */
/** The append statement, prepared once per connection: a heavy terminal
 *  flushes about 30 times a second. */
const appendStatements = new WeakMap<Database.Database, Database.Statement>();

export class TranscriptRepository {
  constructor(private db: Database.Database) {}

  /** Append one flush of ANSI-stripped text as the session's next piece. */
  appendChunk(sessionId: string, chunk: string): void {
    let append = appendStatements.get(this.db);
    if (!append) {
      append = this.db.prepare(`
        INSERT INTO session_transcript_chunks (session_id, seq, chars, bytes, created_at, text)
        VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM session_transcript_chunks WHERE session_id = ?), ?, ?, ?, ?)
      `);
      appendStatements.set(this.db, append);
    }
    append.run(sessionId, sessionId, chunk.length, Buffer.byteLength(chunk), new Date().toISOString(), chunk);
  }

  /** A legacy row's size and dates, without its text. */
  private legacyRow(sessionId: string): { chars: number; sizeBytes: number; createdAt: string; updatedAt: string } | null {
    const row = this.db.prepare(`
      SELECT length(transcript) AS chars, size_bytes AS sizeBytes, created_at AS createdAt, updated_at AS updatedAt
      FROM session_transcripts WHERE session_id = ?
    `).get(sessionId) as { chars: number; sizeBytes: number; createdAt: string; updatedAt: string } | undefined;
    return row ?? null;
  }

  /** The whole transcript, oldest first, or null when none was captured. */
  getTranscriptText(sessionId: string): string | null {
    const legacy = this.db.prepare('SELECT transcript FROM session_transcripts WHERE session_id = ?')
      .get(sessionId) as { transcript: string } | undefined;
    const pieces = (this.db.prepare('SELECT text FROM session_transcript_chunks WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ text: string }>).map((row) => row.text);
    if (!legacy && pieces.length === 0) return null;
    return (legacy?.transcript ?? '') + pieces.join('');
  }

  /**
   * The last `maxChars` characters of a session's transcript, its total
   * length, size and dates, without reading the whole transcript: the newest
   * pieces are read until the budget is met (an index seek and a few rows),
   * then a legacy row's own tail if the budget still wants more. Used by the
   * raw `get_transcript` MCP path, which only ever shows the tail. Null when
   * nothing was captured.
   */
  getTranscriptTail(sessionId: string, maxChars: number): {
    tail: string;
    fullLength: number;
    sizeBytes: number;
    createdAt: string;
    updatedAt: string;
  } | null {
    const budget = Math.max(0, maxChars);
    // `text` is the last column, so the totals read no overflow pages.
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS pieces, COALESCE(SUM(chars), 0) AS chars, COALESCE(SUM(bytes), 0) AS bytes,
             MIN(created_at) AS firstAt, MAX(created_at) AS lastAt
      FROM session_transcript_chunks WHERE session_id = ?
    `).get(sessionId) as { pieces: number; chars: number; bytes: number; firstAt: string | null; lastAt: string | null };
    const legacy = this.legacyRow(sessionId);
    if (totals.pieces === 0 && !legacy) return null;

    const newestFirst: string[] = [];
    let collected = 0;
    if (totals.pieces > 0 && budget > 0) {
      const newest = this.db.prepare('SELECT text FROM session_transcript_chunks WHERE session_id = ? ORDER BY seq DESC');
      for (const row of newest.iterate(sessionId) as IterableIterator<{ text: string }>) {
        newestFirst.push(row.text);
        collected += row.text.length;
        if (collected >= budget) break;
      }
    }
    let tail = newestFirst.reverse().join('');
    if (collected < budget && legacy && legacy.chars > 0) {
      // substr(X, -N) returns the last N characters, or all of X when shorter.
      const legacyTail = this.db.prepare('SELECT substr(transcript, ?) AS tail FROM session_transcripts WHERE session_id = ?')
        .get(-(budget - collected), sessionId) as { tail: string | null } | undefined;
      tail = (legacyTail?.tail ?? '') + tail;
    }
    if (tail.length > budget) tail = tail.slice(tail.length - budget);
    return {
      tail,
      fullLength: totals.chars + (legacy?.chars ?? 0),
      sizeBytes: totals.bytes + (legacy?.sizeBytes ?? 0),
      createdAt: legacy?.createdAt ?? totals.firstAt ?? '',
      updatedAt: totals.lastAt ?? legacy?.updatedAt ?? '',
    };
  }

  /** The transcript's size without its content. */
  getSizeBytes(sessionId: string): number {
    const pieces = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM session_transcript_chunks WHERE session_id = ?')
      .get(sessionId) as { bytes: number };
    return pieces.bytes + (this.legacyRow(sessionId)?.sizeBytes ?? 0);
  }
}
