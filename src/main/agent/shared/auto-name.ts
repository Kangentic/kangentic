import { parseJsonLine, pickStringField, runCliPrint, type RunCliPrintOptions } from './cli-print';

/**
 * The TITLE shape of a headless CLI run (`cli-print.ts`): auto-name asks an
 * agent for a short task title from its description.
 */

const PROMPT_BUDGET = 4000; // characters of input we forward to the CLI
const OUTPUT_BUDGET = 2048; // bytes of stdout we accept before terminating
const TITLE_LIMIT = 80;
const DEFAULT_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT_PREFIX =
  'Summarize the following task description as a concise imperative title (4-8 words). '
  + 'Use Title Case. No quotes, no trailing period, no markdown formatting. '
  + 'Output exactly one line, the title only.\n\nTask description:\n';

export function buildSummarizePrompt(input: string): string {
  const trimmed = input.trim().slice(0, PROMPT_BUDGET);
  return SYSTEM_PROMPT_PREFIX + trimmed;
}

export function cleanSummarizeOutput(raw: string): string {
  let text = raw ?? '';

  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`/g, '');

  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';

  let cleaned = firstLine
    .replace(/^['"“‘]+|['"”’]+$/g, '')
    .replace(/^[*_>\-#\s]+/, '')
    .replace(/[.!?\s]+$/, '')
    .trim();

  if (cleaned.length > TITLE_LIMIT) {
    cleaned = cleaned.slice(0, TITLE_LIMIT).replace(/[\s\-_,;:]+$/, '').trim();
  }
  return cleaned;
}

/**
 * Lines whose `type` field marks them as the final assistant turn we want to
 * extract a title from. Stream-json formats vary across CLIs:
 *   - Codex / Droid emit `type: 'completion' | 'result'`
 *   - Cursor's stream-json uses `type: 'assistant'` / `type: 'message'`
 *   - Anthropic-style APIs use `type: 'assistant' | 'message_delta'`
 * We accept the union and ignore unrelated event lines (`init`, `tool_call`,
 * `tool_result`, `system`, etc.) that may carry a `text` field with metadata
 * unrelated to the assistant's response.
 */
const FINAL_MESSAGE_TYPES = new Set(['assistant', 'message', 'completion', 'result', 'final']);

/**
 * Extractor for adapters whose non-interactive output is NDJSON (one JSON object per line).
 * Walks the stream from the end and, for lines whose `type` field appears in
 * FINAL_MESSAGE_TYPES, returns the first non-empty `text` / `finalText` /
 * `content` / `delta` / `message.content` field. If no `type`-tagged line
 * matches, falls back to the same field probe on any JSON line. If neither
 * yields anything, returns the raw stdout so `cleanSummarizeOutput` can still
 * try heuristics.
 *
 * Used by Cursor (`--output-format stream-json`) and any future adapter that
 * opts into stream-json by passing this as `extractRaw` to `runCliPrintSummarize`.
 */
export function extractFinalAssistantText(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  // First pass: prefer lines explicitly tagged as a final assistant message.
  for (let index = lines.length - 1; index >= 0; index--) {
    const record = parseJsonLine(lines[index]);
    if (!record) continue;
    const recordType = typeof record.type === 'string' ? record.type : null;
    if (!recordType || !FINAL_MESSAGE_TYPES.has(recordType)) continue;
    const candidate = pickAssistantText(record);
    if (candidate) return candidate;
  }

  // Fallback: untagged stream (some CLIs omit `type` on the final line).
  for (let index = lines.length - 1; index >= 0; index--) {
    const record = parseJsonLine(lines[index]);
    if (!record) continue;
    const candidate = pickAssistantText(record);
    if (candidate) return candidate;
  }
  return stdout;
}

function pickAssistantText(record: Record<string, unknown>): string | null {
  return (
    pickStringField(record, 'text')
    ?? pickStringField(record, 'finalText')
    ?? pickStringField(record, 'content')
    ?? pickStringField(record, 'delta')
    ?? pickAssistantMessage(record)
  );
}

function pickAssistantMessage(record: Record<string, unknown>): string | null {
  const message = record.message;
  if (typeof message === 'string' && message.trim().length > 0) return message;
  if (typeof message === 'object' && message !== null) {
    const inner = message as Record<string, unknown>;
    return pickStringField(inner, 'content') ?? pickStringField(inner, 'text');
  }
  return null;
}

/**
 * A one-shot run shaped for a TITLE: the title's budgets, and its output
 * cleaned to a single line unless the caller passes another `shape`. Throws on
 * a non-zero exit, a timeout, or empty output.
 */
export function runCliPrintSummarize(options: RunCliPrintOptions): Promise<string> {
  return runCliPrint({
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputBudget: options.outputBudget ?? OUTPUT_BUDGET,
    shape: options.shape ?? cleanSummarizeOutput,
  });
}
