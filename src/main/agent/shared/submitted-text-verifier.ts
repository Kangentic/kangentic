import type { SubmissionContext, SubmissionVerifier } from '../../../shared/types';
import { readTranscriptTailLines } from './transcript-tail-cache';

/**
 * Shared `command-injection` verifier for adapters whose session history
 * records a user turn as its own record.
 *
 * WHAT THIS ANSWERS
 * "Did exactly this text become a user turn after `sentAt`?" That is the
 * `submitted` verify mode, and it is the mode that matters: `prepareInjectionPlan`
 * tags the user's `auto_command` as `submitted`, and `TerminalSubmitScheduler`
 * only ever escalates a failed `submitted` command.
 *
 * WHY THE MATCH IS EXACT
 * The bug this exists to catch is a swallowed Enter, where the next keystrokes
 * concatenate into the same prompt buffer. The reported case submits
 * `instead can we/pull-request`, which CONTAINS `/pull-request`, so a substring
 * test would confirm precisely the failure the verifier is for. Comparison is
 * therefore trim-equality on the whole user turn, never `includes`.
 *
 * That same exactness makes one implementation serve `command-match` too: a
 * combined submission records as `"/model X\n/effort Y"`, which does not
 * trim-equal `"/model X"`, so it reads as a miss and the burst retries - the
 * same recovery Claude's tag-shaped matcher provides.
 *
 * SAFETY CONTRACT (read before adding an adapter)
 * A verifier is what AUTHORIZES a restart: a `failed` outcome escalates to a
 * session respawn that destroys live work. So a verifier must only ever be
 * wired for an agent whose history is measured to flush on SUBMIT, not on
 * turn-end (`scripts/measure-injection-flush.mjs`). Returning `false` here
 * means "not yet seen", and the caller keeps polling within its window; an
 * unreadable or missing file must therefore also return `false` rather than
 * asserting a failure, because a missing file is the normal state for the
 * first few hundred milliseconds after a spawn.
 */

/** Clock-skew tolerance when comparing a record timestamp against `sentAt`. */
const SENT_AT_TOLERANCE_MS = 50;

/**
 * One parsed history line.
 *
 * `timestampMs` is epoch MILLISECONDS. Adapters normalise their own units here
 * (Kimi's wire format uses unix seconds, OpenCode uses epoch ms integers), so
 * the shared scan never needs to know which agent it is reading. Return `null`
 * when the timestamp is absent; the scan then accepts the record on text alone
 * rather than discarding it.
 */
export interface UserTurnRecord {
  timestampMs: number | null;
  text: string;
}

/**
 * Parse one raw history line into a user turn, or `null` when the line is not a
 * user turn (an assistant message, a tool call, session metadata, a synthetic
 * context-priming turn, or an unparseable partial write mid-flush).
 *
 * This is the ONLY per-agent piece, and it stays in the adapter's own folder
 * per `agent-adapters-boundary`.
 */
export type UserTurnExtractor = (line: string) => UserTurnRecord | null;

/**
 * Scan the bounded tail of `filePath` backwards for a user turn whose text is
 * exactly `text`, written at or after `sentAt`.
 */
export async function scanForSubmittedText(
  filePath: string,
  text: string,
  sentAt: number,
  extractUserTurn: UserTurnExtractor,
): Promise<boolean> {
  const lines = await readTranscriptTailLines(filePath);
  if (!lines) return false;

  const expected = text.trim();
  if (!expected) return false;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;

    let record: UserTurnRecord | null;
    try {
      record = extractUserTurn(line);
    } catch {
      // A partial write mid-flush, or a shape this adapter does not recognise.
      continue;
    }
    if (!record) continue;

    // Walking backwards, the first record older than the watermark means every
    // remaining record is older still, so stop rather than keep reading. This
    // is what keeps the scan bounded to the last few hundred milliseconds and
    // makes the 25ms poll cadence affordable.
    if (record.timestampMs !== null && record.timestampMs < sentAt - SENT_AT_TOLERANCE_MS) {
      return false;
    }

    if (record.text.trim() === expected) return true;
  }

  return false;
}

/**
 * Build a `SubmissionVerifier` for the `command-injection` context.
 *
 * `resolvePath` MUST be synchronous. The caller rebuilds this verifier on every
 * poll (25ms, for up to ~2s per command), so an async locate that polls for
 * seconds - as every `SessionHistoryParser.locate` does - would never return
 * inside a single 400ms verify window. Adapters memoise their scan in a
 * module-global map instead; that memo must be persistent, not one-shot.
 */
export function createSubmittedTextSubmissionVerifier(options: {
  resolvePath: (agentSessionId: string, cwd: string) => string | null;
  extractUserTurn: UserTurnExtractor;
}): SubmissionVerifier {
  return async (context: SubmissionContext): Promise<boolean> => {
    if (context.type !== 'command-injection') return false;
    if (!context.agentSessionId || !context.cwd) return false;

    // `SubmissionContext.mode` is only 'command-match' | 'submitted'; the
    // unverifiable 'none' mode is filtered one layer up, in
    // `buildCommandInjectionVerifier` and in `submitKeystrokes`'s `canVerify`.
    // Both modes are answered by the same exact-match scan (see the header).
    const filePath = options.resolvePath(context.agentSessionId, context.cwd);
    if (!filePath) return false;

    return scanForSubmittedText(
      filePath,
      context.text,
      context.sentAt ?? Date.now(),
      options.extractUserTurn,
    );
  };
}
