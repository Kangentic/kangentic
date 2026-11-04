import fs from 'node:fs/promises';
import type { SubmissionContext, SubmissionVerifier } from '../../../../shared/types';
import { readTranscriptTailLines } from '../../shared/transcript-tail-cache';
import { aiderHistoryPath } from './history-paths';

/**
 * Aider's `command-injection` verifier. CONFIRM-ONLY.
 *
 * Aider is the odd one out and does NOT use the shared submitted-text scan,
 * because its history format cannot support it safely.
 *
 * The chat history is plain markdown, appended to, and it carries no
 * per-entry timestamp - only a `# aider chat started at ...` banner per run. A
 * task session writes its own file (`.aider.chat.history.<id>.md`, see
 * `history-paths.ts`), which a resume keeps appending to; a session with no
 * id writes Aider's default `.aider.chat.history.md`, ONE FILE PER PROJECT
 * DIRECTORY, appended to forever. The shared scan bounds itself with a
 * `sentAt` watermark read off each record; with no such timestamp, every
 * historical entry would look eligible, so an auto_command that had been run
 * before in the same file would confirm instantly from an old entry without
 * anything being submitted at all.
 *
 * Two guards replace the missing timestamp:
 *
 *   1. The FILE's mtime must be at or after `sentAt`. If aider has not written
 *      anything since we pressed Enter, nothing landed, full stop.
 *   2. Only the LAST user block counts. Our submission, if it landed, is the
 *      most recent user turn in the file; a match anywhere earlier is a stale
 *      repeat, not evidence.
 *
 * Aider is not installed on the development machine, so its flush latency is
 * unmeasured and `AiderAdapter.canEscalateOnVerificationFailure()` returns
 * false. This verifier confirms and retries; it never authorizes a restart.
 */

/** Clock-skew tolerance, matching the shared scan. */
const SENT_AT_TOLERANCE_MS = 50;

/**
 * Return the final user block, or null when the file ends on assistant output.
 *
 * Aider prefixes EVERY line of a user prompt with `####`, so a multi-line
 * prompt is a contiguous run of them. Walking back over the trailing blank
 * lines and then over that run reconstructs the prompt as sent. Trailing
 * whitespace is stripped because aider appends two spaces to force a markdown
 * line break.
 */
export function extractLastAiderUserPrompt(lines: string[]): string | null {
  let index = lines.length - 1;
  while (index >= 0 && lines[index].trim() === '') index -= 1;
  if (index < 0) return null;
  if (!lines[index].startsWith('####')) return null;

  const collected: string[] = [];
  while (index >= 0 && lines[index].startsWith('####')) {
    collected.push(lines[index].slice(4).trim());
    index -= 1;
  }
  collected.reverse();
  return collected.join('\n').trim();
}

export function createAiderCommandInjectionVerifier(): SubmissionVerifier {
  return async (context: SubmissionContext): Promise<boolean> => {
    if (context.type !== 'command-injection') return false;
    // A session's id names its history file; with none, `cwd` alone identifies
    // the shared default file. A missing `agentSessionId` is expected here.
    if (!context.cwd) return false;

    // The session's own file when it has an id, else Aider's default file.
    const filePath = aiderHistoryPath(context.cwd, context.agentSessionId);
    const sentAt = context.sentAt ?? Date.now();

    // Guard 1: nothing written since Enter means nothing landed. This also
    // makes a missing file read as "keep polling" rather than a hard failure.
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      return false;
    }
    if (mtimeMs < sentAt - SENT_AT_TOLERANCE_MS) return false;

    const lines = await readTranscriptTailLines(filePath);
    if (!lines) return false;

    // Guard 2: only the most recent user block is evidence.
    const lastPrompt = extractLastAiderUserPrompt(lines);
    if (lastPrompt === null) return false;

    return lastPrompt === context.text.trim();
  };
}
