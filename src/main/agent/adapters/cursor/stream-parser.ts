import { stripAnsiControlCodes } from '../../../../shared/ansi-strip';
import {
  EventType,
  type SessionEvent,
  type SessionUsage,
  type SessionUsagePatch,
  type StreamOutputParser,
} from '../../../../shared/types';
import { resolveCachedCursorModel } from './capability-discovery';

/**
 * Cursor's interactive TUI paints the live model and occupancy on the status
 * bar as `Composer 2.5 · 7.8%` (recorded: `Auto · 9.2% · 1 file edited`, in
 * tests/captures/fixtures/demo/contoso-web-cursor-integration.json).
 * Interactive Skip Approvals (`--trust --force`) prints no stream-json, so
 * this is the only live percent and the only live model the card can read.
 * The separator is the middle dot (U+00B7), written as an escape so a re-save
 * in another code page cannot change it. `7.8s` tool timings and
 * `12 output lines hidden · ctrl+o` do not match, and neither does a `•` list
 * bullet in the agent's own answer (`• 50% of tests pass`).
 */
const TUI_OCCUPANCY = /·\s*(\d+(?:\.\d+)?)\s*%/g;

/** Tail of stripped TUI text kept across chunks so `Composer 2.5 · 7.8%` can straddle a flush. */
const TUI_TAIL = 64;

/** Cap on a TUI model name. Display names are short (`Grok 4.6 High`). */
const TUI_MODEL_MAX_CHARS = 48;

/** Cap on tokens collected walking left from `· 7.8%`. */
const TUI_MODEL_MAX_TOKENS = 5;

interface TuiStatus {
  percent: number;
  model: string | null;
}

/**
 * Parses Cursor CLI's `--output-format stream-json` NDJSON stream as it
 * arrives over the PTY. Each session gets its own instance via
 * `CursorAdapter.runtime.streamOutput.createParser()`.
 *
 * Event shapes are documented at:
 * https://cursor.com/docs/cli/reference/output-format
 *
 * Init event (non-interactive stream-json model + session id):
 *   {"type":"system","subtype":"init","session_id":"<uuid>",
 *    "model":"<display name>","permissionMode":"default",...}
 *
 * Tool events drive Thinking/Idle through the activity state machine:
 *   {"type":"tool_call","subtype":"started","call_id":"...","tool_call":{...}}
 *   {"type":"tool_call","subtype":"completed","call_id":"...","tool_call":{...}}
 *
 * Terminal result event (carries duration; optional cost surface):
 *   {"type":"result","subtype":"success","duration_ms":5234,...}
 *
 * Cursor uses a single `model` string (e.g. "Claude 4 Sonnet") with no
 * separate id/displayName split. The pill shows that display name. The stored
 * id is resolved against `--list-models` when a catalog is cached, so a
 * later spawn does not pass the display spelling to `--model`.
 */
export class CursorStreamParser implements StreamOutputParser {
  /**
   * Cap on the rolling partial-line buffer. Cursor's init event runs
   * well under 1KB; 8KB matches `SessionIdScanner.bufferMax` and is two
   * ConPTY flush boundaries. Without this cap, a producer that emits
   * data with no newlines (raw TUI output in interactive mode, a
   * malformed unbroken stream) would grow `carry` without bound.
   */
  private static readonly MAX_CARRY = 8192;

  /**
   * Trailing partial line carried into the next parse pass. Cursor's
   * init event is well under ConPTY's ~4KB flush boundary so it almost
   * always arrives intact, but a chunk boundary can land mid-line at
   * any point and a buffered carry-over keeps us safe.
   */
  private carry = '';
  /** Last occupancy percent emitted from the TUI path, to skip identical redraws. */
  private lastTuiPercent: number | null = null;
  /** Last TUI model emitted with occupancy, to skip identical redraws and to catch a mid-session switch. */
  private lastTuiModel: string | null = null;
  /** Trailing stripped TUI text, so occupancy can straddle a ConPTY flush. */
  private tuiTail = '';
  /** True once `tuiTail` was cut to its cap, so its first token may be a word's end. */
  private tuiTailCut = false;

  parseTelemetry(data: string): {
    usage?: SessionUsagePatch;
    events?: SessionEvent[];
  } | null {
    const combined = this.carry + data;
    const lines = combined.split(/\r?\n/);
    // The last element is whatever followed the final newline (or the
    // entire chunk if no newline appeared) - hold it back as carry.
    const tail = lines.pop() ?? '';
    this.carry = tail.length > CursorStreamParser.MAX_CARRY
      ? tail.slice(tail.length - CursorStreamParser.MAX_CARRY)
      : tail;

    let usage: SessionUsagePatch | undefined;
    let events: SessionEvent[] | undefined;

    for (const rawLine of lines) {
      if (rawLine.length === 0) continue;
      // Real Cursor PTY output prefixes the very first JSON line with
      // terminal init sequences (`\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H`
      // on Windows ConPTY) and can intersperse OSC title updates between
      // later lines too. JSON.parse would reject the whole line for those
      // leading bytes, so locate the first `{` and parse from there.
      // Anything before that brace is guaranteed to be non-JSON because
      // Cursor's stream-json events are one balanced object per line.
      const jsonStart = rawLine.indexOf('{');
      if (jsonStart < 0) continue;
      const line = rawLine.slice(jsonStart);
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;
      const type = entry.type;
      const subtype = entry.subtype;

      if (type === 'system' && subtype === 'init') {
        const model = entry.model;
        if (typeof model === 'string' && model.length > 0) {
          usage = { ...usage, model: reportedCursorModel(model) };
        }
      } else if (type === 'tool_call' && subtype === 'started') {
        const toolName = extractToolName(entry.tool_call);
        events = events ?? [];
        events.push({
          ts: Date.now(),
          type: EventType.ToolStart,
          tool: toolName,
          detail: toolName,
        });
      } else if (type === 'tool_call' && subtype === 'completed') {
        const toolName = extractToolName(entry.tool_call);
        events = events ?? [];
        events.push({
          ts: Date.now(),
          type: EventType.ToolEnd,
          tool: toolName,
          detail: toolName,
        });
      } else if (type === 'result' && subtype === 'success') {
        const durationMs = entry.duration_ms;
        if (typeof durationMs === 'number' && durationMs > 0) {
          usage = {
            ...usage,
            cost: { totalCostUsd: 0, totalDurationMs: durationMs },
          };
        }
      }
    }

    const tuiStatus = this.readTuiStatus(data);
    if (tuiStatus) {
      // The percent alone: the bar paints no window and no token counts, and
      // the merge keeps the rest of the session's window.
      usage = {
        ...usage,
        contextWindow: { usedPercentage: tuiStatus.percent },
        ...(tuiStatus.model ? { model: reportedCursorModel(tuiStatus.model) } : {}),
      };
    }

    if (!usage && !events) return null;
    return { usage, events };
  }

  /**
   * Occupancy and live model from the interactive status bar. Returns null
   * when this chunk has no new status (nothing matched, or the same percent
   * and model as last time). Uses the LAST occupancy match so a tail that
   * still holds the previous `· 7.8%` cannot hide a later `· 9.1%` on the
   * same scan.
   *
   * A match wholly inside the carried tail was read on the scan that brought
   * it, with more of its line in front. It is skipped: read again, with each
   * later chunk cutting the tail further, its model came back cut from the
   * left (`poser 2.5`) and replaced the real one.
   *
   * Escapes are stripped with whitespace kept. `stripAnsiEscapes` trims each
   * line's trailing spaces, and a chunk's end counts as a line end, so a flush
   * between `Composer ` and `2.5 · 7.8%` read as `Composer2.5`: a name with no
   * space, which the picker then kept as a model id `--model` rejects.
   */
  private readTuiStatus(data: string): TuiStatus | null {
    const carried = this.tuiTail;
    const carriedWasCut = this.tuiTailCut;
    const scan = carried + stripAnsiControlCodes(data);
    if (scan.length > TUI_TAIL) {
      this.tuiTail = scan.slice(scan.length - TUI_TAIL);
      this.tuiTailCut = true;
    } else {
      this.tuiTail = scan;
    }
    let latestPercent: number | null = null;
    let latestMatchStart = 0;
    for (const match of scan.matchAll(TUI_OCCUPANCY)) {
      const matchStart = match.index ?? 0;
      if (matchStart + match[0].length <= carried.length) continue;
      const percent = Number.parseFloat(match[1]);
      if (!Number.isFinite(percent) || percent < 0) continue;
      latestPercent = Math.min(100, percent);
      latestMatchStart = matchStart;
    }
    if (latestPercent === null) return null;
    const model = readTuiModelName(scan, latestMatchStart, carriedWasCut);
    if (latestPercent === this.lastTuiPercent && model === this.lastTuiModel) return null;
    this.lastTuiPercent = latestPercent;
    this.lastTuiModel = model;
    return { percent: latestPercent, model };
  }
}

/** The usage model block for a name Cursor itself reported (init event or status bar). */
function reportedCursorModel(displayName: string): SessionUsage['model'] {
  return { id: resolveCachedCursorModel(displayName), displayName, reportedByAgent: true };
}

/**
 * Display name immediately before `· 7.8%` (at `matchStart` in `scan`) on the
 * same line. Walks left at most five tokens so `done. Composer 2.5 · 7.8%`
 * keeps `Composer 2.5` and a glued conversation line does not become the
 * whole prefix. No model table: a token is letters, digits, dots, plus,
 * parens, or hyphens, or a version number (`2.5`). The leftmost token must
 * start with a letter. When the walk takes every token back to the start of
 * a scan that begins at a cut (`scanStartCut`), the first token may be the end
 * of a word, so no name is read.
 */
function readTuiModelName(scan: string, matchStart: number, scanStartCut: boolean): string | null {
  // A carriage return starts a line too: the escapes were stripped without
  // the line-ending normalization.
  const lineStart = Math.max(scan.lastIndexOf('\n', matchStart - 1), scan.lastIndexOf('\r', matchStart - 1)) + 1;
  const lastLine = scan.slice(lineStart, matchStart);
  const tokens = lastLine.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  const collected: string[] = [];
  for (
    let tokenIndex = tokens.length - 1;
    tokenIndex >= 0 && collected.length < TUI_MODEL_MAX_TOKENS;
    tokenIndex--
  ) {
    const token = tokens[tokenIndex];
    if (!isTuiModelToken(token)) break;
    collected.unshift(token);
  }
  if (collected.length === 0 || !/^[A-Za-z]/.test(collected[0])) return null;
  if (scanStartCut && lineStart === 0 && collected.length === tokens.length) return null;
  const name = collected.join(' ');
  if (name.length > TUI_MODEL_MAX_CHARS) return null;
  return name;
}

function isTuiModelToken(token: string): boolean {
  if (/^\d+(?:\.\d+)?$/.test(token)) return true;
  // A trailing `.` is sentence punctuation (`done.`), not part of a name.
  // Dots inside a token stay (`GPT-5.4`).
  if (token.endsWith('.')) return false;
  return /^[A-Za-z][A-Za-z0-9.+()-]*$/.test(token);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cursor wraps each tool call in a single-key object whose key is the
 * tool name (`readToolCall`, `writeToolCall`, ...). Strip the trailing
 * `ToolCall` to get the bare tool name; fall back to `'tool'` when the
 * shape doesn't match. Activity tracking only reads ToolStart/ToolEnd
 * transitions, so an opaque label is fine when extraction fails.
 */
function extractToolName(toolCall: unknown): string {
  if (!isRecord(toolCall)) return 'tool';
  const keys = Object.keys(toolCall);
  if (keys.length === 0) return 'tool';
  const key = keys[0];
  return key.endsWith('ToolCall') ? key.slice(0, -'ToolCall'.length) : key;
}
