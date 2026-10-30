import { stripAnsiEscapes } from '../../../../shared/ansi-strip';
import {
  EventType,
  type SessionEvent,
  type SessionUsage,
  type StreamOutputParser,
} from '../../../../shared/types';
import { resolveCachedCursorModel } from './capability-discovery';

/**
 * Cursor's interactive TUI paints the live model and occupancy on the status
 * bar as `Composer 2.5 · 7.8%` (forum: `Auto · 8.3% · 1 file edited`).
 * Interactive Skip Approvals (`--trust --force`) prints no stream-json, so
 * this is the only live percent and the only live model the card can read.
 * The separator is a middle dot, not a hyphen, so `7.8s` tool timings and
 * `12 output lines hidden · ctrl+o` do not match.
 */
const TUI_OCCUPANCY = /[·•∙]\s*(\d+(?:\.\d+)?)\s*%/g;

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

  parseTelemetry(data: string): {
    usage?: Partial<SessionUsage>;
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

    let usage: Partial<SessionUsage> | undefined;
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
          usage = {
            ...usage,
            model: {
              id: resolveCachedCursorModel(model),
              displayName: model,
              reportedByAgent: true,
            },
          };
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
      usage = {
        ...usage,
        contextWindow: { usedPercentage: tuiStatus.percent } as SessionUsage['contextWindow'],
      };
      if (tuiStatus.model) {
        usage = {
          ...usage,
          model: {
            id: resolveCachedCursorModel(tuiStatus.model),
            displayName: tuiStatus.model,
            reportedByAgent: true,
          },
        };
      }
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
   */
  private readTuiStatus(data: string): TuiStatus | null {
    const stripped = stripAnsiEscapes(data);
    const scan = this.tuiTail + stripped;
    this.tuiTail = scan.length > TUI_TAIL ? scan.slice(scan.length - TUI_TAIL) : scan;
    let latest: TuiStatus | null = null;
    for (const match of scan.matchAll(TUI_OCCUPANCY)) {
      const percent = Number.parseFloat(match[1]);
      if (!Number.isFinite(percent) || percent < 0) continue;
      latest = {
        percent: Math.min(100, percent),
        model: readTuiModelName(scan.slice(0, match.index ?? 0)),
      };
    }
    if (
      latest === null
      || (latest.percent === this.lastTuiPercent && latest.model === this.lastTuiModel)
    ) {
      return null;
    }
    this.lastTuiPercent = latest.percent;
    this.lastTuiModel = latest.model;
    return latest;
  }
}

/**
 * Display name immediately before `· 7.8%` on the same line. Walks left at
 * most five tokens so `done. Composer 2.5 · 7.8%` keeps `Composer 2.5` and
 * a glued conversation line does not become the whole prefix. No model
 * table: a token is letters, digits, dots, plus, parens, or hyphens, or a
 * version number (`2.5`). The leftmost token must start with a letter.
 */
function readTuiModelName(prefix: string): string | null {
  const lastLine = prefix.split(/\r?\n/).pop() ?? '';
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
