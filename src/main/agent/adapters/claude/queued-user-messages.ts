import { readJsonlWindow } from '../../shared/history-scan';
import { timeSyncWork } from '../../../diagnostics/event-loop-lag';
import { isTaskNotificationText } from '../../shared/agent-reply';

/**
 * The most a queued-message read takes from the transcript, from the turn's
 * anchor: the user-message read's own bound (`TURN_USER_MESSAGES_MAX_WINDOWS`
 * in `message-trail-read.ts`, 8 MB) plus room for a turn that grew while it
 * was read. A read that cannot reach the end of the file answers null: an
 * unseen queued message could be the one that counts.
 *
 * One read, not a walk of small windows: a window walk skips a line longer
 * than its window, and a Design turn's screenshot lines pass 1 MB, so the walk
 * would lose a queued message or refuse the turns this read exists for. The
 * read allocates the turn's own size, from the anchor to the end of the file.
 */
const QUEUED_READ_MAX_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A message a person typed while Claude was mid-turn, if this transcript line
 * is one. Claude writes it as an attachment, not a user turn, so it fires no
 * UserPromptSubmit and the transcript parse leaves it out:
 *
 * `{"type":"attachment","timestamp":"...","attachment":{"type":"queued_command",
 *  "prompt":"...","commandMode":"prompt","origin":{"kind":"human"},...}}`
 *
 * A background job's notice uses the same shape with `commandMode:
 * "task-notification"`, and is never a person's. Only `commandMode: "prompt"`
 * from a human origin counts.
 */
export function queuedHumanMessageOf(raw: unknown): { text: string; ts: number } | null {
  if (!isRecord(raw) || raw.type !== 'attachment' || !isRecord(raw.attachment)) return null;
  const attachment = raw.attachment;
  if (attachment.type !== 'queued_command' || attachment.commandMode !== 'prompt') return null;
  if (!isRecord(attachment.origin) || attachment.origin.kind !== 'human') return null;
  if (typeof attachment.prompt !== 'string') return null;
  if (isTaskNotificationText(attachment.prompt)) return null;
  const stamp = typeof raw.timestamp === 'string' ? raw.timestamp : typeof attachment.timestamp === 'string' ? attachment.timestamp : null;
  const ts = stamp === null ? Number.NaN : Date.parse(stamp);
  if (!Number.isFinite(ts)) return null;
  return { text: attachment.prompt, ts };
}

/**
 * Every queued human message from `startByte` to the end of the transcript,
 * in file order. Null when the file cannot be read to its end, so the caller
 * treats the turn as unreadable rather than missing the message that counts.
 */
export async function readClaudeQueuedUserMessages(
  filePath: string | null,
  startByte: number,
): Promise<Array<{ text: string; ts: number }> | null> {
  if (!filePath) return null;
  try {
    const window = await readJsonlWindow(filePath, { startByte, maxBytes: QUEUED_READ_MAX_BYTES });
    // `readJsonlWindow` answers a file it could not open with an empty window,
    // so no bytes at all is a failed read, not a turn with no queued messages.
    if (window.totalBytes === 0 || window.endByte < window.totalBytes) return null;
    // Parsed in this adapter's own code after the read's await, so it names its own span.
    return timeSyncWork('transcript:parse-queued', () => {
      const messages: Array<{ text: string; ts: number }> = [];
      for (const line of window.text.split('\n')) {
        // Cheap pre-filter: most lines are not attachments. The bare word, so a
        // writer that spaces its JSON still gets through to the parse.
        if (!line.includes('queued_command')) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const message = queuedHumanMessageOf(parsed);
        if (message) messages.push(message);
      }
      return messages;
    });
  } catch {
    return null;
  }
}
