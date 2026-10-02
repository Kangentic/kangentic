import { parseJsonLine, pickStringField, runCliPrint, type RunCliPrintOptions } from './cli-print';

/**
 * The ANSWER shape of a headless CLI run (`cli-print.ts`): its budgets, its
 * cleanup, and the readers for a Claude-compatible `--output-format
 * stream-json` stream, live as it arrives and settled once it ends. Adapters
 * whose CLI writes another stream format keep their reader beside them
 * (`adapters/<agent>/answer-stream.ts`) and emit the same `AnswerStreamEvent`.
 */

/**
 * Budgets for an answer.
 *
 * A title is one line, so 2KB of stdout and 15 seconds were generous. An answer
 * is several paragraphs with citations, over a prompt carrying about 10,000
 * tokens of retrieved conversation (measured on a real index), so both bounds
 * have to move by an order of magnitude. They stay BOUNDS: an agent that decides
 * to narrate its way through 24 excerpts is still cut off rather than left to run.
 */
const ANSWER_OUTPUT_BUDGET = 32_768;
export const ANSWER_TIMEOUT_MS = 120_000;

/**
 * The stdout budget for a STREAMED answer, which is a different quantity.
 *
 * `ANSWER_OUTPUT_BUDGET` bounds the answer text. A stream-json transcript with
 * partial messages carries ~250 bytes of envelope per text delta, a complete
 * copy of every turn, and every tool result in full - a hybrid search returns
 * twenty passages - so a three-turn answer runs to hundreds of kilobytes of
 * stdout for a two-paragraph answer. Measured: at 32KB the CLI was killed
 * after its second tool call, and the "answer" was the agent's own narration
 * joined together. Still a bound, against a genuine runaway; just sized for
 * what a stream is.
 */
export const ANSWER_STREAM_OUTPUT_BUDGET = 8 * 1024 * 1024;

/**
 * One event from a `--output-format stream-json` line, reduced to what the
 * answer path renders.
 *
 * Only two things reach the screen while an answer is in flight: text the
 * assistant has written so far, and the fact that it is calling a tool. Every
 * other line (init, result, usage) is machinery and yields null.
 */
export type AnswerStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string };

/**
 * One complete assistant turn: every text and tool_use block, in order.
 *
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"..."}]}}
 *
 * Degrades to nothing on a shape it does not recognise, as every reader of the
 * stream does: a stream that drops an event shows the user slightly less
 * progress, and a stream that throws on one costs the whole answer.
 */
function eventsFromAssistantMessage(record: Record<string, unknown>): AnswerStreamEvent[] {
  const message = record.message;
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];

  const events: AnswerStreamEvent[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as Record<string, unknown>;
    if (entry.type === 'text' && typeof entry.text === 'string' && entry.text.length > 0) {
      events.push({ kind: 'text', text: entry.text });
    } else if (entry.type === 'tool_use' && typeof entry.name === 'string') {
      events.push({ kind: 'tool', name: entry.name });
    }
  }
  return events;
}

/**
 * One partial-message event, from `--include-partial-messages`.
 *
 * This is what makes the stream a stream: without it the CLI emits one
 * `assistant` line per TURN, complete, so a one-turn answer arrives all at
 * once at the end (measured: first text at 4.8s of a 5.5s call). With it the
 * model's own deltas come through as they are written (measured: 1.3s), and
 * a tool call is visible the moment its block opens.
 *
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"..."}}}
 *
 * Everything else under `stream_event` (message_start, block stop, usage) is
 * machinery and yields nothing.
 */
function eventsFromStreamEvent(record: Record<string, unknown>): AnswerStreamEvent[] {
  const event = record.event;
  if (typeof event !== 'object' || event === null) return [];
  const entry = event as Record<string, unknown>;
  if (entry.type === 'content_block_delta') {
    const delta = entry.delta;
    if (typeof delta !== 'object' || delta === null) return [];
    const change = delta as Record<string, unknown>;
    if (change.type === 'text_delta' && typeof change.text === 'string' && change.text.length > 0) {
      return [{ kind: 'text', text: change.text }];
    }
    return [];
  }
  if (entry.type === 'content_block_start') {
    const block = entry.content_block;
    if (typeof block !== 'object' || block === null) return [];
    const opened = block as Record<string, unknown>;
    if (opened.type === 'tool_use' && typeof opened.name === 'string') {
      return [{ kind: 'tool', name: opened.name }];
    }
  }
  return [];
}

/**
 * Turn a stream of stdout chunks into whole lines.
 *
 * Chunk boundaries fall anywhere, including mid-line, so a partial line is held
 * until its newline arrives. The tail left after the final chunk is not flushed
 * on purpose: it is either empty or a line the CLI never finished, and neither
 * is an event.
 */
export function forwardStreamLines(onLine: (line: string) => void): (chunk: string) => void {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      onLine(pending.slice(0, newline).replace(/\r$/, ''));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  };
}

/**
 * A line-by-line reducer with one piece of state: whether partial messages
 * are flowing.
 *
 * With `--include-partial-messages` the CLI emits each turn TWICE - as deltas
 * while it is written, then as one complete `assistant` line - so once a
 * partial event has been seen, the complete line is the settled copy of text
 * already shown and is dropped. Without partials (an older CLI, a caller that
 * did not ask for them) the `assistant` lines are all there is, and they pass
 * through. `message_start` counts as a partial event, so the switch is thrown
 * before the first delta rather than by it.
 */
export function createAnswerStreamReducer(): (rawLine: string) => AnswerStreamEvent[] {
  let sawPartial = false;
  return (rawLine) => {
    const record = parseJsonLine(rawLine);
    if (!record) return [];
    if (record.type === 'stream_event') {
      sawPartial = true;
      return eventsFromStreamEvent(record);
    }
    if (record.type === 'assistant') return sawPartial ? [] : eventsFromAssistantMessage(record);
    return [];
  };
}

/**
 * A run the CLI itself reports as failed is not an answer. Claude-compatible
 * CLIs end a failed run (an unknown model, an API error, an exhausted quota)
 * with a `result` line carrying `is_error: true`, and its `result` text is the
 * error message. Returned as text, that message reads as the agent's reply;
 * thrown, the runner rejects and the chat shows its failed turn, with the
 * message as the reason and a Try again button.
 *
 * Not every CLI puts the cause in `result`. Grok ended a quota failure with an
 * error result and no text, and the chat said only "the agent reported an
 * error" over what its own log called "429 ... free usage exhausted". So the
 * other fields such a line carries are read too, then the subtype.
 */
function throwIfErrorResult(record: Record<string, unknown>, resultText: string | null): void {
  if (record.is_error !== true) return;
  throw new Error(resultText || errorResultText(record) || 'the agent reported an error');
}

/** The cause an error result line names outside `result`, if any. */
function errorResultText(record: Record<string, unknown>): string | null {
  const describe = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const parts = value.map(describe).filter((part): part is string => part !== null);
      return parts.length > 0 ? parts.join('; ') : null;
    }
    if (value && typeof value === 'object') {
      const message = (value as { message?: unknown }).message;
      return typeof message === 'string' && message.trim() ? message.trim() : null;
    }
    return null;
  };
  for (const key of ['error', 'errors', 'message']) {
    const text = describe(record[key]);
    if (text) return text;
  }
  const subtype = typeof record.subtype === 'string' ? record.subtype : '';
  return subtype && subtype !== 'success' ? subtype.replace(/_/g, ' ') : null;
}

/**
 * The final answer text out of a complete stream-json transcript.
 *
 * In stream mode the CLI emits an `assistant` line per turn. A tool-calling
 * answer has several: the turn that decided to search, and the turn that wrote
 * the answer from what it found. The user's answer is the assistant text of the
 * LAST turn; earlier turns' text is the agent narrating its own search, which
 * the live stream showed as progress and the settled answer must not repeat.
 *
 * Falls back to every assistant text joined when no `result` line is present -
 * an output-budget cut lands mid-stream, and the partial answer is still worth
 * more than nothing.
 */
export function extractStreamedAnswer(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  let lastTurnText = '';
  let allText = '';
  let sawResult = false;
  for (const line of lines) {
    const record = parseJsonLine(line);
    if (!record) continue;
    if (record.type === 'result') {
      sawResult = true;
      const result = pickStringField(record, 'result');
      throwIfErrorResult(record, result);
      if (result) return result;
      continue;
    }
    // Complete turns only. The partial-message deltas carry the same text a
    // fragment at a time, and counting both would double every turn.
    if (record.type !== 'assistant') continue;
    const events = eventsFromAssistantMessage(record);
    const text = events.filter((event) => event.kind === 'text').map((event) => event.text).join('');
    if (!text) continue;
    lastTurnText = text;
    // Turns on their own lines: a cut stream is the agent's narration, and
    // run together it read as one sentence that made no sense.
    allText += allText ? `\n${text}` : text;
  }
  return sawResult ? lastTurnText : allText;
}

/**
 * The final answer out of a Claude-compatible stream-json transcript, taken
 * from the LAST assistant turn even when a `result` line is present.
 *
 * For a CLI whose `result` joins every turn's text rather than carrying only
 * the last one. Grok's `streaming-messages-json` is the case: a prompt read from
 * a file costs it a tool turn ("I'll look up row 377..."), and its result line
 * fuses that narration onto the answer with no separator. The last turn is the
 * answer; falls back to the result, then to every turn joined.
 */
export function extractLastTurnAnswer(stdout: string): string {
  let lastTurnText = '';
  let resultText = '';
  let allText = '';
  for (const line of stdout.split(/\r?\n/)) {
    const record = parseJsonLine(line);
    if (!record) continue;
    if (record.type === 'result') {
      const result = pickStringField(record, 'result');
      throwIfErrorResult(record, result);
      resultText = result ?? resultText;
      continue;
    }
    if (record.type !== 'assistant') continue;
    const text = eventsFromAssistantMessage(record)
      .filter((event) => event.kind === 'text')
      .map((event) => (event.kind === 'text' ? event.text : ''))
      .join('');
    if (!text) continue;
    lastTurnText = text;
    allText += allText ? `\n${text}` : text;
  }
  return lastTurnText || resultText || allText;
}

/**
 * Answer cleanup: trim, and nothing else.
 *
 * Deliberately not `cleanSummarizeOutput`, which strips code fences and keeps the
 * first non-empty line. An answer about a codebase legitimately contains fenced
 * code, several paragraphs, and citation markers, and every one of those is
 * content rather than formatting noise.
 */
export function cleanAnswerOutput(raw: string): string {
  return (raw ?? '').trim();
}

/**
 * A one-shot run shaped for an ANSWER: the answer budgets and cleanup.
 *
 * A wrapper rather than three options repeated per adapter, so the contract for
 * the shape lives in one place and the next adapter to adopt it inherits the
 * budgets rather than guessing at them, as `runCliPrintSummarize` does for a
 * title. No PTY and no `sessions` row, which is why Ask needs no spawn-parity
 * allowlist entry.
 */
export function runCliPrintAnswer(options: Omit<RunCliPrintOptions, 'shape'>): Promise<string> {
  return runCliPrint({
    ...options,
    timeoutMs: options.timeoutMs ?? ANSWER_TIMEOUT_MS,
    outputBudget: options.outputBudget ?? ANSWER_OUTPUT_BUDGET,
    shape: cleanAnswerOutput,
  });
}
