/**
 * Tracks what the USER has typed into a session's prompt and not yet sent.
 *
 * Why this exists: auto_command injection needs to know whether it is about to
 * type into an empty prompt or on top of someone's half-written message. The
 * reported bug is the second case - `instead can we` plus an injected
 * `/pull-request` submitted as one message, which both loses the command and
 * confuses the agent.
 *
 * Reading the prompt directly is not available to us: the main process sees a
 * raw ANSI byte stream, not a rendered screen, and the rendered screen lives
 * in a renderer that may not even be showing this session. But we DO see every
 * byte the user types, because renderer keystrokes, dictation, and the mobile
 * bridge all funnel through `SessionManager.write`. Accumulating those is a
 * direct measure rather than an inference.
 *
 * DELIBERATELY NOT LOAD-BEARING FOR CORRECTNESS. The clear decision is safe
 * without it (a warm session always clears), so a stale or missed ledger entry
 * degrades the message the user sees, never the delivery itself. It matters in
 * exactly one place where it does change behavior: the fresh-spawn path, whose
 * prompt is empty at SPAWN time but not necessarily at DELIVERY time, because
 * delivery waits for the agent to come alive and the user can type during that
 * window. There the ledger only ever ADDS a clear that would otherwise be
 * skipped, which is the safe direction.
 *
 * Accuracy limits, accepted: a draft Claude Code restores itself (history
 * recall) was never typed through us and is invisible here; text typed into a
 * TUI overlay rather than the prompt counts when it should not. Both are
 * tolerable precisely because of the paragraph above.
 */

/** Who produced a write. Injected keystrokes are `system`; humans are `user`. */
export type WriteOrigin = 'user' | 'system';

/**
 * Cap on remembered draft length. A draft is only ever shown back to the user
 * in a notice, so there is no reason to hold a whole pasted document.
 */
const MAX_DRAFT_LENGTH = 4096;

export class PromptDraftLedger {
  private drafts = new Map<string, string>();

  /**
   * Fold a write into the session's draft state.
   *
   * Submit (`\r` / `\n`) and clear (`\x03`) are honored regardless of origin,
   * because they empty the prompt no matter who sent them - including our own
   * injected keystrokes. Printable text is recorded only for `user` writes, so
   * an injected command passing through the prompt is never mistaken for
   * something the user was in the middle of writing.
   */
  record(sessionId: string, data: string, origin: WriteOrigin): void {
    let draft = this.drafts.get(sessionId) ?? '';

    for (let index = 0; index < data.length; index++) {
      const character = data[index];

      if (character === '\x1b') {
        // Skip the whole escape sequence: arrow keys and other CSI input move
        // the cursor, they do not add text, and counting their bytes as
        // characters would corrupt the draft.
        index = skipEscapeSequence(data, index);
        continue;
      }
      if (character === '\r' || character === '\n') {
        draft = '';
        continue;
      }
      if (character === '\x03') {
        draft = '';
        continue;
      }
      if (character === '\x7f' || character === '\b') {
        draft = draft.slice(0, -1);
        continue;
      }
      // Remaining C0 controls (Ctrl+key chords) are commands, not content.
      if (character < ' ') continue;
      if (origin !== 'user') continue;
      if (draft.length < MAX_DRAFT_LENGTH) draft += character;
    }

    if (draft.length === 0) this.drafts.delete(sessionId);
    else this.drafts.set(sessionId, draft);
  }

  /** Unsent user text for this session, or null when the prompt looks empty. */
  get(sessionId: string): string | null {
    const draft = this.drafts.get(sessionId);
    return draft && draft.length > 0 ? draft : null;
  }

  /** Forget this session's draft (session exit, or an explicit reset). */
  clear(sessionId: string): void {
    this.drafts.delete(sessionId);
  }
}

/**
 * Return the index of the last byte of the escape sequence starting at
 * `start`, so a `for` loop can continue past it.
 *
 * Handles the two shapes that arrive as terminal INPUT: CSI (`\x1b[`, ended by
 * a byte in `@`-`~`) and SS3 (`\x1bO`, one byte). A lone `\x1b` is the Escape
 * key and consumes nothing further.
 */
function skipEscapeSequence(data: string, start: number): number {
  const next = data[start + 1];
  if (next === '[') {
    for (let index = start + 2; index < data.length; index++) {
      const character = data[index];
      if (character >= '@' && character <= '~') return index;
    }
    return data.length - 1;
  }
  if (next === 'O') return Math.min(start + 2, data.length - 1);
  return start;
}
