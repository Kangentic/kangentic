import type { TranscriptEntry } from '../../../shared/types';

/**
 * The agent's reply at the end of its last turn: what `{{agentReply}}` resolves
 * to. The same final answer `kangentic_get_transcript` returns for
 * `view: "result"` (`filterTranscriptView`), with two differences that make it
 * safe to hand to another agent:
 *
 * - **It never walks back past the turn.** `view: "result"` returns the last
 *   assistant text anywhere, so a turn that ended on a tool call would hand on
 *   the previous turn's reply. This stops at the last real prompt: a user
 *   message, or a slash command. A `<task-notification>` is not one: it is a
 *   background job's completion restarting the agent, and the reply the user
 *   is waiting on can sit before it.
 * - **It keeps the whole message.** Claude writes each content block of one
 *   message on its own transcript line, so a message with two text blocks
 *   parses as two assistant entries in a row. The final run of assistant
 *   entries is joined, text blocks only, with its line breaks.
 *
 * Null when the turn said nothing a reader could hand on.
 */
export interface AgentReply {
  text: string;
  /** The last entry of the reply, for a caller that wants to tell replies apart. */
  uuid: string;
  ts: number;
}

/** A user entry that starts a turn of the user's, as opposed to a background job's. */
function isRealPrompt(entry: TranscriptEntry): boolean {
  if (entry.kind === 'user') return !entry.text.trimStart().startsWith('<task-notification>');
  if (entry.kind === 'system') return entry.subtype === 'command' || entry.subtype === 'session_boundary';
  return false;
}

function textOf(entry: TranscriptEntry): string {
  if (entry.kind !== 'assistant') return '';
  return entry.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

export function finalAgentReply(entries: ReadonlyArray<TranscriptEntry>): AgentReply | null {
  // The newest assistant entry with text, after the last real prompt.
  let lastIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isRealPrompt(entry)) break;
    if (entry.kind === 'assistant' && textOf(entry).trim()) {
      lastIndex = index;
      break;
    }
  }
  if (lastIndex < 0) return null;

  // The run of assistant entries it ends: the other blocks of the same message.
  // A tool result, a user line, or a system line ends the run.
  let firstIndex = lastIndex;
  while (firstIndex > 0 && entries[firstIndex - 1].kind === 'assistant') firstIndex -= 1;
  const text = entries
    .slice(firstIndex, lastIndex + 1)
    .map(textOf)
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
  if (!text) return null;
  const last = entries[lastIndex];
  return { text, uuid: last.uuid, ts: last.ts };
}
