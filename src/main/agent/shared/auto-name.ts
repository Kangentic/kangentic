import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROMPT_BUDGET = 4000; // characters of input we forward to the CLI
const OUTPUT_BUDGET = 2048; // bytes of stdout we accept before terminating
const TITLE_LIMIT = 80;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Budgets for the ANSWER shape, where the same spawn returns prose rather than a
 * title.
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

function parseJsonLine(rawLine: string): Record<string, unknown> | null {
  const line = rawLine.trim();
  if (!line.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return parsed as Record<string, unknown>;
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

function pickStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
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

export interface RunCliPrintOptions {
  cliPath: string;
  /** Fixed CLI args (subcommand, flags). When `promptVia: 'arg'`, the prompt is appended
   *  to this list as the final positional argument. */
  args: string[];
  /** Wrapped prompt text (call buildSummarizePrompt first). */
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * How the prompt is delivered to the CLI:
   *   - 'stdin' (default): piped via the child's stdin, args are unchanged.
   *   - 'arg': appended to args as the final positional argument; stdin is closed empty.
   *   - 'file': written to a file in `cwd` whose path follows `promptFileFlag`, for a
   *     CLI that reads its prompt from a file and not from stdin.
   * Use 'arg' only for a short prompt (a title): Windows caps a command line at
   * 32,767 characters, and 8,191 through cmd.exe, so an answer-sized prompt must
   * use 'stdin' or 'file'.
   */
  promptVia?: 'stdin' | 'arg' | 'file';
  /** The flag that names the prompt file, when `promptVia` is 'file'
   *  (`--prompt-file`, `--message-file`). */
  promptFileFlag?: string;
  /** Where a `promptVia: 'file'` run writes its prompt. Defaults to `cwd`; an
   *  answer run passes its run directory, since its `cwd` is shared. */
  promptDirectory?: string;
  /**
   * Optional pre-cleanup transform: receives raw stdout, returns the candidate title text
   * to feed into `cleanSummarizeOutput`. Useful when the CLI emits NDJSON / stream-json:
   * the adapter parses each line, picks the final assistant message, and returns its
   * `text` field. Returning empty string (or throwing) marks the run as a failure.
   */
  extractRaw?: (stdout: string) => string;
  /**
   * Optional environment variables merged into the spawn. Adapters that need to disable
   * a TUI banner via env var (e.g. `NO_COLOR=1`, custom analytics opt-out) supply them here.
   */
  env?: Record<string, string>;
  /** Bytes of stdout accepted before the child is terminated. Defaults to a
   *  title's worth; the answer shape needs far more. */
  outputBudget?: number;
  /**
   * Turns captured stdout (after `extractRaw`) into the returned value.
   *
   * Defaults to `cleanSummarizeOutput`, which flattens to a single line - correct
   * for a title and destructive for anything else. The answer shape passes
   * `cleanAnswerOutput` instead, which is the whole reason this is a parameter:
   * one spawn, two output shapes, rather than a second copy of the spawn.
   */
  shape?: (candidate: string) => string;
  /**
   * Called for each stdout chunk as it arrives, BEFORE the buffered result is
   * assembled. The streaming answer path uses this to forward text deltas to
   * the renderer while the CLI is still writing; the buffered result is still
   * returned whole at the end so nothing structural is parsed off a partial.
   */
  onChunk?: (chunk: string) => void;
}

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
 * Reduce one stream-json line to an `AnswerStreamEvent`, or null.
 *
 * Degrades to null on anything it does not recognise: a malformed line, a
 * partial line at a chunk boundary, a schema the CLI has not shipped yet. A
 * stream that drops an event shows the user slightly less progress; a stream
 * that throws on one costs the whole answer.
 *
 * The line shapes handled, from the CLI's stream-json output:
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"..."}]}}
 * A content array can carry several blocks; each becomes its own event.
 */
export function parseAnswerStreamLine(rawLine: string): AnswerStreamEvent[] {
  const record = parseJsonLine(rawLine);
  if (!record) return [];
  if (record.type === 'assistant') return eventsFromAssistantMessage(record);
  if (record.type === 'stream_event') return eventsFromStreamEvent(record);
  return [];
}

/** One complete assistant turn: every text and tool_use block, in order. */
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
 * Spawns the agent's CLI in non-interactive mode, writes the prompt to stdin, captures up
 * to OUTPUT_BUDGET bytes of stdout, optionally runs an adapter-specific extractor, then
 * cleans the result into a single-line title. Throws on non-zero exit, timeout, or empty
 * output.
 */
export async function runCliPrintSummarize(options: RunCliPrintOptions): Promise<string> {
  const {
    cliPath,
    args,
    prompt,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    promptVia = 'stdin',
    promptFileFlag,
    promptDirectory = cwd,
    extractRaw,
    env,
    outputBudget = OUTPUT_BUDGET,
    shape = cleanSummarizeOutput,
    onChunk,
  } = options;

  // Written before the spawn and removed when the call ends, whatever the
  // outcome. The caller owns the directory; this owns only the one file it
  // wrote there.
  let promptFilePath: string | null = null;
  if (promptVia === 'file') {
    if (!promptFileFlag) throw new Error('promptVia "file" needs a promptFileFlag');
    promptFilePath = path.join(promptDirectory, PROMPT_FILE_NAME);
    // sync-write-ok: the CLI cannot run without its prompt file, so a failed
    // write rejects this call, and the answer handler reports it to the user.
    fs.writeFileSync(promptFilePath, prompt, 'utf-8');
  }

  try {
    return await runCliPrint({
      cliPath, args, prompt, cwd, timeoutMs, promptVia, promptFilePath, promptFileFlag,
      extractRaw, env, outputBudget, shape, onChunk,
    });
  } finally {
    // `force` because Windows may still hold the handle for a beat after exit.
    if (promptFilePath) fs.rmSync(promptFilePath, { force: true });
  }
}

/** The file a `promptVia: 'file'` run writes into its `cwd`. */
const PROMPT_FILE_NAME = 'kangentic-prompt.md';

/** `RunCliPrintOptions` with every default applied and the prompt file resolved. */
interface ResolvedPrintOptions {
  cliPath: string;
  args: string[];
  prompt: string;
  cwd: string;
  timeoutMs: number;
  promptVia: 'stdin' | 'arg' | 'file';
  promptFilePath: string | null;
  promptFileFlag: string | undefined;
  extractRaw: ((stdout: string) => string) | undefined;
  env: Record<string, string> | undefined;
  outputBudget: number;
  shape: (candidate: string) => string;
  onChunk: ((chunk: string) => void) | undefined;
}

function runCliPrint(resolved: ResolvedPrintOptions): Promise<string> {
  const {
    cliPath,
    args,
    prompt,
    cwd,
    timeoutMs,
    promptVia,
    promptFilePath,
    promptFileFlag,
    extractRaw,
    env,
    outputBudget,
    shape,
    onChunk,
  } = resolved;

  return new Promise<string>((resolve, reject) => {
    const finalArgs = promptVia === 'arg'
      ? [...args, prompt]
      : promptVia === 'file' && promptFilePath && promptFileFlag
        ? [...args, promptFileFlag, promptFilePath]
        : args;
    const child = spawnCli(cliPath, finalArgs, cwd, env);

    let stdoutSize = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let terminated = false;

    const timer = setTimeout(() => {
      terminated = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1000).unref();
      reject(new Error('summarize timed out'));
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > outputBudget) {
        terminated = true;
        child.kill('SIGTERM');
      } else {
        stdoutChunks.push(chunk);
        // Forwarded as it lands, so a streaming consumer sees the text while
        // the CLI is still writing. The buffered copy above is still what the
        // returned value is assembled from.
        onChunk?.(chunk.toString('utf-8'));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    const finish = (rawStdout: string, code: number | null, partial: boolean): void => {
      let candidate = rawStdout;
      if (extractRaw) {
        try {
          candidate = extractRaw(rawStdout);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      const cleaned = shape(candidate);
      if (cleaned) {
        resolve(cleaned);
        return;
      }
      if (partial) {
        reject(new Error('summarize terminated before producing output'));
        return;
      }
      if (code !== 0) {
        const stderr = stderrExcerpt(Buffer.concat(stderrChunks).toString('utf-8'));
        reject(new Error(`summarize CLI exited ${code}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      reject(new Error('summarize produced empty output'));
    };

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      finish(stdout, code, terminated);
    });

    try {
      if (promptVia === 'stdin') {
        child.stdin.end(prompt);
      } else {
        child.stdin.end();
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Whether `spawnCli` runs this CLI through cmd.exe: a Windows `.cmd` or `.bat` shim. */
export function cliRunsThroughShell(cliPath: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
}

/**
 * Spawn an agent CLI with piped stdio, the way every headless run does.
 *
 * A Windows `.cmd` or `.bat` shim (an npm-installed CLI) runs through cmd.exe,
 * so its args are interpolated into one command string and each is quoted for
 * cmd.exe (`quoteForCmdShell`). Everything else gets its args passed literally.
 */
export function spawnCli(cliPath: string, args: string[], cwd: string, env?: Record<string, string>): ChildProcessWithoutNullStreams {
  const useShell = cliRunsThroughShell(cliPath);
  const command = useShell ? `"${cliPath}" ${args.map(quoteForCmdShell).join(' ')}` : cliPath;
  return spawn(command, useShell ? [] : args, {
    cwd,
    shell: useShell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** Longest stderr excerpt a failure message carries. */
const STDERR_EXCERPT_CHARS = 240;

/**
 * The part of a failed CLI's stderr worth showing: its last line that names an
 * error, else its last few lines.
 *
 * The first 200 characters, which is what this used to show, are usually a
 * banner. Codex prints its version, working directory, model and sandbox before
 * the 401 that explains the failure, so the message cut off at "sandbox:
 * read-only reason" and named everything but the cause.
 * @internal Exported for unit tests only; not part of the public API.
 */
export function stderrExcerpt(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /error|denied|unauthori[sz]ed|forbidden|not (?:found|available)|limit/i.test(line));
  const chosen = errorLine ?? lines.slice(-3).join(' ');
  return chosen.length > STDERR_EXCERPT_CHARS ? `${chosen.slice(0, STDERR_EXCERPT_CHARS - 3)}...` : chosen;
}

/**
 * Quote an arbitrary argument for cmd.exe parsing when invoking via `shell: true` on
 * Windows. Wraps the value in double quotes and escapes:
 *   - embedded double quotes by doubling them ("" is the cmd convention)
 *   - percent signs by doubling them (cmd expands %VAR% inside any string, even
 *     inside double quotes; %% prevents expansion when the prompt contains
 *     env-var-like text such as a user pasting a Windows path with %APPDATA%)
 * We never run our prompt through cmd-builtin redirection or pipes, so backticks
 * and `^` need no special handling.
 * @internal Exported for unit tests only; not part of the public API.
 */
export function quoteForCmdShell(value: string): string {
  if (!/[\s"&<>|^()%]/.test(value) && value.length > 0) return value;
  const escaped = value.replace(/"/g, '""').replace(/%/g, '%%');
  return `"${escaped}"`;
}

/**
 * The same one-shot spawn, shaped for an ANSWER instead of a title.
 *
 * A wrapper rather than three options repeated per adapter, for the reason the
 * summarize path already has `buildSummarizePrompt` and `cleanSummarizeOutput`:
 * the contract for a shape belongs in one place, so the second adapter to adopt
 * it inherits the budgets rather than guessing at them.
 *
 * Everything else is the summarize path unchanged - no PTY, no `sessions` row,
 * prompt on stdin or as an argument, SIGTERM then SIGKILL on the timeout - which
 * is why Ask needs no spawn-parity allowlist entry.
 */
export async function runCliPrintAnswer(
  options: Omit<RunCliPrintOptions, 'shape'>,
): Promise<string> {
  try {
    return await runCliPrintSummarize({
      timeoutMs: ANSWER_TIMEOUT_MS,
      outputBudget: ANSWER_OUTPUT_BUDGET,
      ...options,
      shape: cleanAnswerOutput,
    });
  } catch (error) {
    throw new Error(describeAnswerFailure(error), { cause: error });
  }
}

/**
 * The runner's failure text, worded for an answer.
 *
 * The Memory Graph shows why an answer failed verbatim, and the shared runner
 * names every failure after the feature it was written for: "summarize CLI
 * exited 1: Error: Model ... is not available" sat under a question the user had
 * asked, about nothing they had summarized. The CLI's own text after the colon
 * is kept as it is, because it is usually the part that says what to fix.
 */
function describeAnswerFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^summarize CLI exited/, 'the agent exited')
    .replace(/^summarize /, 'the agent ');
}
