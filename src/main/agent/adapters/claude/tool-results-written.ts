import { readJsonlWindow } from '../../shared/history-scan';
import { isPlainRecord } from '../../shared/plain-record';
import { timeSyncWork } from '../../../diagnostics/event-loop-lag';

/**
 * How much of the transcript's tail the check reads. One tool result can run past 100 KB; a
 * window that no longer holds the call answers null, and the session waits for its turn end.
 */
export const TOOL_RESULTS_WINDOW_BYTES = 1024 * 1024;

/**
 * Whether Claude has written the result of every tool call in the assistant message that made
 * `toolUseId`, so a restart now loses none of them. Null when the window does not hold that call.
 *
 * Measured on Claude Code 2.1.331 (task #1200): a call's `tool_result` is not in the transcript
 * when its PostToolUse hook fires. Claude appends the results of a message's calls when the next
 * call starts, or 130 to 170 ms after the last one ends (15 of 15 tool ends, lags of 128 ms to
 * 2.4 s). A message's parallel calls share its `message.id` and are written one line each.
 */
export function toolResultsWrittenIn(lines: readonly string[], toolUseId: string): boolean | null {
  const messageToolUseIds = new Map<string, string[]>();
  const resultIds = new Set<string>();
  let messageIdOfCall: string | null = null;
  for (const line of lines) {
    // Most lines are neither; skip the parse for them.
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // report-ok: a line cut by a concurrent append is read again on the next check.
    }
    if (!isPlainRecord(entry) || !isPlainRecord(entry.message) || !Array.isArray(entry.message.content)) continue;
    const messageId = typeof entry.message.id === 'string' ? entry.message.id : null;
    for (const block of entry.message.content) {
      if (!isPlainRecord(block)) continue;
      if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && messageId) {
        const calls = messageToolUseIds.get(messageId) ?? [];
        calls.push(block.id);
        messageToolUseIds.set(messageId, calls);
        if (block.id === toolUseId) messageIdOfCall = messageId;
      } else if (entry.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resultIds.add(block.tool_use_id);
      }
    }
  }
  if (messageIdOfCall === null) return null;
  return (messageToolUseIds.get(messageIdOfCall) ?? []).every((id) => resultIds.has(id));
}

/**
 * The first, short read. The call asked about is almost always in a transcript's last few KB, and a
 * session waiting to move is asked about up to six times per tool end, most of them before its
 * result is written.
 */
export const TOOL_RESULTS_FIRST_WINDOW_BYTES = 64 * 1024;

/**
 * `toolResultsWrittenIn` over the tail of the transcript at `filePath`. A `false` from the short
 * window stands: results follow their call, so a call in the window with a result missing from it
 * has none written. Anything else on a longer file is read again over the full window, since a
 * window that starts inside the call's message can miss a sibling call, and `true` moves a session.
 */
export async function readToolResultsWritten(filePath: string, toolUseId: string): Promise<boolean | null> {
  const first = await readJsonlWindow(filePath, { maxBytes: TOOL_RESULTS_FIRST_WINDOW_BYTES });
  if (first.totalBytes === 0) return null;
  const firstAnswer = timeSyncWork('transcript:parse-tool-results', () => toolResultsWrittenIn(first.text.split('\n'), toolUseId));
  if (firstAnswer === false || first.totalBytes <= TOOL_RESULTS_FIRST_WINDOW_BYTES) return firstAnswer;
  const window = await readJsonlWindow(filePath, { maxBytes: TOOL_RESULTS_WINDOW_BYTES });
  return timeSyncWork('transcript:parse-tool-results', () => toolResultsWrittenIn(window.text.split('\n'), toolUseId));
}
