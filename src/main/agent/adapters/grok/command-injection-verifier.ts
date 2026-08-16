import fs from 'node:fs';
import {
  createSubmittedTextSubmissionVerifier,
  type UserTurnRecord,
} from '../../shared/submitted-text-verifier';
import { grokChatHistoryPath } from './session-paths';
import { extractTextContent, unwrapUserQuery } from './transcript-parser';
import type { SubmissionVerifier } from '../../../../shared/types';

/**
 * Command-injection verifier for Grok Build, scanning `chat_history.jsonl`.
 *
 * MEASURED (grok 1.0.0, interactive TUI via node-pty on Windows): the user
 * turn is appended to `chat_history.jsonl` 313ms after Enter - a
 * flush-on-SUBMIT write that landed well before the turn finished (2.1s),
 * comfortably inside the ~2s delivery budget. `updates.jsonl` flushed the
 * same turn only at 1.7s, which is why the verifier reads chat_history and
 * not the chunked updates stream (whose `user_message_chunk` records can
 * also split a long message and would never trim-equal the submitted
 * text).
 *
 * Record shape: `{ type: 'user', content: {type:'text',text} | string,
 * synthetic_reason? }`. Genuine typed turns carry NO `synthetic_reason` and
 * wrap the text in `<user_query>` tags, which the extractor strips before
 * the exact-match comparison. Records carry NO timestamps, so
 * `timestampMs` is null - the shared scan then matches on text alone
 * within the bounded tail instead of stopping at a `sentAt` watermark.
 *
 * TIER: CONFIRM-ONLY (`canEscalateOnVerificationFailure -> false` on the
 * adapter). Two reasons, per the escalation contract in agent-adapter.ts:
 * (1) escalation additionally requires this adapter's own verifier proven
 * end to end in a running app (the mock-CLI recipe), which has not been
 * run; (2) with no record timestamps, a byte-identical PRIOR submission in
 * the same session could false-confirm - harmless for confirm-only (a
 * skipped retry), disqualifying for a restart authorization.
 */
export function extractGrokUserTurn(line: string): UserTurnRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.type !== 'user') return null;
  if (typeof record.synthetic_reason === 'string' && record.synthetic_reason.length > 0) return null;

  // Shared with parseGrokTranscript so both readers of chat_history.jsonl
  // accept the same content shapes (string / {text} block / block array,
  // including plain-string array items).
  const text = extractTextContent(record.content);
  if (text === null) return null;

  return { timestampMs: null, text: unwrapUserQuery(text) };
}

/**
 * Build the verifier. `resolvePath` is synchronous deterministic
 * construction (caller-owned session UUID + cwd), which trivially satisfies
 * the shared wrapper's sync-resolve requirement; existence is probed so the
 * first few hundred milliseconds after spawn read as "not yet seen" rather
 * than an error.
 */
export function createGrokCommandInjectionVerifier(): SubmissionVerifier {
  return createSubmittedTextSubmissionVerifier({
    resolvePath: (agentSessionId, cwd) => {
      const filePath = grokChatHistoryPath(cwd, agentSessionId);
      try {
        return fs.existsSync(filePath) ? filePath : null;
      } catch {
        return null;
      }
    },
    extractUserTurn: extractGrokUserTurn,
  });
}
