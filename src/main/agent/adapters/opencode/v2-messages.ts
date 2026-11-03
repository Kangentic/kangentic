import type { OpenCodeRemoteMessageEntry, OpenCodeRemotePart } from './remote-client';

/**
 * OpenCode 2 keeps a session's conversation as one record per message, in the
 * `session_message` table of the same `opencode.db` (`type` and a JSON `data`
 * column, ordered by `seq`), and prints the same records from
 * `opencode session export <id>`. Measured on 2.2.5:
 *
 *   user       { time, text, files }
 *   assistant  { time, agent, model: { id, providerID }, content: [...], finish, tokens }
 *                content: { type: 'text', text }
 *                         { type: 'reasoning', text }
 *                         { type: 'tool', id, name, state: { status, input, content: [{ type: 'text', text }] } }
 *                         a failed tool: state { status: 'error', input, error: { type, message } }, no content
 *   synthetic, agent-switched, idle, ...   (not conversation)
 *
 * OpenCode 1 kept a message and its parts apart (`message` / `part`), and its
 * server API and `export` return `{ info, parts }`. This turns an OpenCode 2
 * record into that `{ info, parts }` entry, so every reader keeps one mapper
 * (`mapOpenCodeRemoteEntries`) and one submit check for both majors.
 */
export function openCodeV2MessageEntry(
  id: string,
  type: string,
  createdMs: number,
  data: Record<string, unknown>,
): OpenCodeRemoteMessageEntry | null {
  const time = { created: createdMs };
  if (type === 'user') {
    const text = typeof data.text === 'string' ? data.text : '';
    return { info: { id, role: 'user', time }, parts: text ? [{ type: 'text', text }] : [] };
  }
  if (type !== 'assistant') return null;
  const model = isRecord(data.model) && typeof data.model.id === 'string' ? data.model.id : undefined;
  const parts: OpenCodeRemotePart[] = [];
  for (const block of Array.isArray(data.content) ? data.content : []) {
    if (!isRecord(block)) continue;
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      parts.push({ type: block.type, text: block.text });
    } else if (block.type === 'tool') {
      const state = isRecord(block.state) ? block.state : {};
      parts.push({
        type: 'tool',
        callID: typeof block.id === 'string' ? block.id : '',
        tool: typeof block.name === 'string' ? block.name : 'tool',
        state: {
          input: state.input,
          output: contentText(state.content) ?? errorMessage(state.error) ?? state.output,
          status: typeof state.status === 'string' ? state.status : undefined,
        },
      });
    }
  }
  return { info: { id, role: 'assistant', time, ...(model ? { modelID: model } : {}) }, parts };
}

/** A `session_message` row as the database readers select it. */
export interface OpenCodeV2MessageRow {
  id: string;
  type: string;
  time_created: number;
  data: string;
}

/** `session_message` rows as `{ info, parts }` entries, without the rows that are not conversation or whose `data` does not parse. */
export function openCodeV2RowEntries(rows: ReadonlyArray<OpenCodeV2MessageRow>): OpenCodeRemoteMessageEntry[] {
  return rows.flatMap((row) => {
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      return [];
    }
    const entry = isRecord(data) ? openCodeV2MessageEntry(row.id, row.type, row.time_created, data) : null;
    return entry ? [entry] : [];
  });
}

/** A record's own creation time, the `time.created` every OpenCode 2 message carries. */
export function openCodeV2CreatedMs(data: Record<string, unknown>, fallback: number): number {
  return isRecord(data.time) && typeof data.time.created === 'number' ? data.time.created : fallback;
}

/** The text of a tool result's `content` blocks, or undefined when it has none. */
function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts = value.filter(isRecord).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/** A failed tool's `error.message` (a rejected permission, bad arguments), or undefined. */
function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.message === 'string' ? value.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
