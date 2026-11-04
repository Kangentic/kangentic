import type { TranscriptEntry, TranscriptUsage } from '../../../../shared/types';
import type { ParsedTranscript } from '../../agent-adapter';
import { readJsonlWindow } from '../../shared/history-scan';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { aiderHistoryPath } from './history-paths';
import { AIDER_SESSION_HEADER, isBareCostLine, parseTokensReport, stripBlockquote, summarizeAiderHistory } from './chat-history-markdown';

/**
 * Aider's chat history markdown as a structured conversation.
 *
 * The split follows Aider's own reader, `split_chat_history_markdown`
 * (aider/utils.py, v0.86.1), which is what `--restore-chat-history` loads a
 * conversation back with:
 * - `#### ` lines are the user's message, one line each;
 * - `> ` lines are tool output (Aider drops them when it restores);
 * - every other line is the assistant's reply;
 * - `# ` lines are skipped.
 *
 * Three refinements for a reader:
 * - Everything between a run's `# aider chat started at` header and its first
 *   `####` line is skipped. That is the logged command line, whose multi-line
 *   `--message` spills bare lines Aider's reader would take for a reply, and the
 *   model announcements.
 * - A user message that starts with `/` is a command (`system`/`command`), and
 *   the tool output after it is its output (`command_output`). `/ask`, `/code`,
 *   `/architect` and `/context` with text are messages sent in that mode
 *   (https://aider.chat/docs/usage/modes.html), so they stay user turns.
 * - A second or later run in the same file (a restored conversation) opens with
 *   a `session_boundary`.
 *
 * The split is by line prefix alone, as Aider's own reader does, so a reply
 * that writes a `#### ` heading or a `> ` quote line splits there: the heading
 * reads as a user turn and the quote as tool output. Aider restores such a
 * reply the same way, and the file carries nothing else to tell them apart.
 * The preamble skip has the same limit: a multi-line `--message` holding a
 * `#### ` line (a markdown heading in a task description) spills that line
 * bare into the logged command line, so the preamble ends there, the heading
 * reads as a user turn and the rest of the spill as a reply.
 *
 * The file records no time per entry, only each run's start in local time, so
 * every entry carries `ts: 0` (`transcriptHasTimestamps` is false). Uuids are
 * `<agentSessionId>:<line index>`, the line counted from the file's start even
 * when the read was cut, so a stored citation keeps pointing at its line.
 */

/** Commands whose text is a message to the model in that mode, not a client command. */
const MESSAGE_COMMANDS = /^\/(?:ask|code|architect|context)\s+\S/;

type BufferKind = 'user' | 'assistant' | 'tool';

interface PendingLines {
  kind: BufferKind;
  firstLineIndex: number;
  lines: string[];
}

/** Parse chat history markdown. `firstLineIndex` is the absolute index of `text`'s first line. */
export function parseAiderHistoryMarkdown(text: string, conversationId: string, firstLineIndex = 0): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // Typed by assertion so the flushes the closures make are not narrowed away.
  let buffer = null as PendingLines | null;
  // Before a run's first `####` line, which is its command line and announcements.
  let inPreamble = true;
  let runsSeen = 0;
  let lastFlushedWasCommand = false;
  let previousWasTokensReport = false;

  const uuidFor = (lineIndex: number): string => `${conversationId}:${lineIndex}`;

  const flush = (): void => {
    if (!buffer) return;
    const flushed = buffer;
    buffer = null;
    if (flushed.kind === 'user') {
      const message = flushed.lines.join('\n').trim();
      if (!message) return;
      const isCommand = message.startsWith('/') && !MESSAGE_COMMANDS.test(message);
      if (isCommand) {
        entries.push({ kind: 'system', subtype: 'command', uuid: uuidFor(flushed.firstLineIndex), ts: 0, text: message });
      } else {
        entries.push({ kind: 'user', uuid: uuidFor(flushed.firstLineIndex), ts: 0, text: message });
      }
      lastFlushedWasCommand = isCommand;
      return;
    }
    if (flushed.kind === 'assistant') {
      const reply = flushed.lines.join('\n').trim();
      if (!reply) return;
      entries.push({ kind: 'assistant', uuid: uuidFor(flushed.firstLineIndex), ts: 0, blocks: [{ type: 'text', text: reply }] });
      lastFlushedWasCommand = false;
      return;
    }
    const output = flushed.lines.join('\n').trim();
    if (output && lastFlushedWasCommand) {
      entries.push({ kind: 'system', subtype: 'command_output', uuid: uuidFor(flushed.firstLineIndex), ts: 0, text: output });
    }
  };

  const append = (kind: BufferKind, lineIndex: number, line: string): void => {
    if (buffer && buffer.kind !== kind) flush();
    if (!buffer) buffer = { kind, firstLineIndex: lineIndex, lines: [] };
    buffer.lines.push(line);
  };

  const lines = text.split(/\r?\n/);
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset];
    const lineIndex = firstLineIndex + offset;

    const header = AIDER_SESSION_HEADER.exec(line);
    if (header) {
      flush();
      runsSeen += 1;
      if (runsSeen > 1 || entries.length > 0) {
        entries.push({
          kind: 'system',
          subtype: 'session_boundary',
          uuid: uuidFor(lineIndex),
          ts: 0,
          text: `Aider chat started at ${header[1]}`,
        });
      }
      inPreamble = true;
      lastFlushedWasCommand = false;
      previousWasTokensReport = false;
      continue;
    }

    const userLine = /^####(?: (.*))?$/.exec(line);
    if (userLine) {
      inPreamble = false;
      previousWasTokensReport = false;
      append('user', lineIndex, (userLine[1] ?? '').trimEnd());
      continue;
    }
    if (inPreamble) continue;

    const quoted = stripBlockquote(line);
    if (quoted !== null) {
      append('tool', lineIndex, quoted.trimEnd());
      previousWasTokensReport = parseTokensReport(quoted) !== null;
      continue;
    }
    // The `Cost:` half of a `Tokens:` report with both cache fields arrives on
    // its own line without the `> ` (tool_output quotes only the first line).
    if (previousWasTokensReport && isBareCostLine(line)) {
      append('tool', lineIndex, line.trimEnd());
      previousWasTokensReport = false;
      continue;
    }
    previousWasTokensReport = false;
    if (line.startsWith('# ')) continue;
    if (buffer?.kind === 'tool' && line.trim() === '') continue;
    append('assistant', lineIndex, line);
  }
  flush();
  return entries;
}

/**
 * The structured transcript of one Aider conversation: the file Kangentic
 * named for it, read through the shared bounded tail window, with the notice
 * the cut requires. Never throws: a missing or unreadable file is no entries.
 */
export async function parseAiderTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
  const sourcePath = aiderHistoryPath(cwd, agentSessionId);
  try {
    const window = await readJsonlWindow(sourcePath, { maxBytes: parseWindowBytes(), countOmittedLines: true });
    if (window.totalBytes === 0) return { entries: [], sourcePath: null };
    const entries = parseAiderHistoryMarkdown(window.text, agentSessionId, window.omittedLineCount);
    return { entries: prependTruncationMarker(entries, window.omittedBytes, window.totalBytes), sourcePath };
  } catch {
    return { entries: [], sourcePath: null };
  }
}

/**
 * Lifetime tokens of one Aider conversation: every `Tokens:` report in its
 * file added up, read window by window so no read holds more than the parse
 * cap. Null when the file is missing or reports none.
 */
export async function aiderTranscriptUsage(agentSessionId: string, cwd: string): Promise<TranscriptUsage | null> {
  const filePath = aiderHistoryPath(cwd, agentSessionId);
  try {
    let inputTokens = 0;
    let outputTokens = 0;
    let reportCount = 0;
    let startByte = 0;
    for (;;) {
      const window = await readJsonlWindow(filePath, { startByte, maxBytes: parseWindowBytes() });
      const summary = summarizeAiderHistory(window.text);
      inputTokens += summary.totals.sent;
      outputTokens += summary.totals.received;
      reportCount += summary.reportCount;
      if (window.nextByteOffset <= startByte || window.nextByteOffset >= window.totalBytes) break;
      startByte = window.nextByteOffset;
    }
    if (reportCount === 0) return null;
    return { inputTokens, outputTokens };
  } catch {
    return null;
  }
}
