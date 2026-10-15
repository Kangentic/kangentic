import type { TranscriptEntry } from '../../../shared/types';

/** One turn's text in the tail, cut at this length so a single long reply cannot fill it. */
const TURN_MAX_CHARS = 1_200;

/**
 * The newest turns of a conversation as plain text, for the recap a session
 * gets when it starts in place of a resume whose file the agent deleted. User
 * messages and the agent's prose only: tool calls, their output and thinking
 * are what the new agent can read again from the code. At most `maxChars`,
 * newest kept, in reading order. Null when there is no such turn.
 */
export function formatConversationTail(entries: ReadonlyArray<TranscriptEntry>, maxChars: number): string | null {
  if (maxChars <= 0) return null;
  const turns: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const turn = turnText(entries[index]);
    if (!turn) continue;
    const cost = turn.length + (turns.length > 0 ? 2 : 0);
    if (used + cost > maxChars) {
      // The newest turn alone is longer than the room: keep its end.
      if (turns.length === 0) turns.push(`...${turn.slice(turn.length - Math.max(0, maxChars - 3))}`);
      break;
    }
    turns.push(turn);
    used += cost;
  }
  if (turns.length === 0) return null;
  return turns.reverse().join('\n\n');
}

function turnText(entry: TranscriptEntry): string | null {
  if (entry.kind === 'user') {
    const text = entry.text.trim();
    return text ? `User: ${clip(text)}` : null;
  }
  if (entry.kind === 'assistant') {
    const text = entry.blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim();
    return text ? `Agent: ${clip(text)}` : null;
  }
  return null;
}

function clip(text: string): string {
  return text.length <= TURN_MAX_CHARS ? text : `${text.slice(0, TURN_MAX_CHARS - 3)}...`;
}
