import {
  Activity,
  EventType,
  AgentTool,
  IdleReason,
  type SessionHistoryParseResult,
  type SessionUsage,
  type SessionEvent,
} from '../../../../shared/types';
import { HOOK_DETAIL_CAP } from '../../../git/push-command';

/**
 * Parser for Kimi Code CLI's `agents/main/wire.jsonl` (wire protocol 1.5).
 *
 * Sources (Kimi Code CLI 2.4.1, github.com/MoonshotAI/kimi-code, read
 * 2026-11-03):
 * - `packages/agent-core-v2/docs/wire-manifest.d.ts`, the generated manifest
 *   of every durable record type and its payload.
 * - `packages/agent-core-v2/src/wire/record.ts`: line 1 is
 *   `{"type":"metadata","protocol_version","created_at"}` (`Date.now()`), and
 *   every other line is `{"type", ...payload, "time"}`.
 * - `packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts`: the
 *   `event` of a `context.append_loop_event` is `step.begin`, `step.end`,
 *   `content.part`, `tool.call` (`toolCallId`, `name`, `args` as an object) or
 *   `tool.result` (`toolCallId`, `result: {output, isError}`).
 * - `packages/agent-core-v2/src/features/plan/exitPlanModeReview.ts`: an
 *   approved plan's result output starts `Exited plan mode.`; a rejected,
 *   revised or dismissed one never does.
 * Built from the source, not yet checked against a real run.
 *
 * Mapping:
 *
 *   Record                                Activity      SessionEvent
 *   ────────────────────────────────────  ────────────  ─────────────────────────
 *   turn.prompt / turn.steer              → Thinking    Prompt (detail = input text)
 *   turn.ended  completed / blocked       (released)    Idle
 *   turn.ended  cancelled                 (released)    Interrupted
 *   turn.ended  failed                    (released)    TurnFailed (detail = error)
 *   turn.step.retrying                    (preserve)    TurnRetrying (detail = errorName)
 *   turn.step.interrupted                 (preserve)    Notification (the turn.ended after it ends the turn)
 *   loop step.begin                       → Thinking    (none)
 *   loop tool.call                        (preserve)    ToolStart (toolId; detail = command for Bash, else name)
 *   loop tool.result                      (preserve)    ToolEnd (ok | error), ExitPlanMode for an
 *                                                       approved plan
 *   loop step.end                        (preserve)    (none; per-step token usage)
 *   interaction.request approval          (released)    Idle (Permission, waitKind approval; a plan review is one)
 *   interaction.request question          (released)    Idle (Permission, waitKind question)
 *   interaction.resolved                  → Thinking    (none)
 *   subagent.spawned                      (preserve)    SubagentStart (subagentId; detail = name)
 *   subagent.completed / failed / cancelled (preserve)  SubagentStop (subagentId)
 *   full_compaction.begin                 → Thinking    Compact
 *   plan_mode.enter / exit               (preserve)    Notification
 *   token_counting.*, llm.request,        (preserve)    (none; usage and model)
 *   usage.record
 *
 * "Released": the event alone moves the engine and the chunk forces no
 * activity, so a turn end reaches the On agent turn end automations.
 *
 * A `tool.result` names only its call id, so a session's parser remembers each
 * open call's tool (`openToolNames`) and tags both ends with it. Where it has
 * no memory, or the start was never read (a watcher that began at the end of
 * the file), the event is tagged `AgentTool.Bash`. The plan exit is named from
 * its result text alone (`eventToolName`).
 *
 * Background commands are not reported. `backgroundCommands` is a measured
 * claim that also needs a per-session MCP URL, and Kimi's is folder-shared, so a
 * background launch reads as a plain tool end (`background-commands.md`).
 */

/**
 * The CLI's shell tool (`en/reference/tools.md`), whose command is the
 * ToolStart's detail. The CLI's own name, which happens to equal `AgentTool.Bash`,
 * the engine's tag.
 */
const KIMI_SHELL_TOOL = 'Bash';

/** How an approved plan's result output starts (`exitPlanModeReview.ts`). */
const APPROVED_PLAN_PREFIX = 'Exited plan mode.';

/** Detail for a tool call with no name. */
const KIMI_TOOL_FALLBACK_NAME = 'tool';

/** Detail for a subagent spawn with no name. */
const KIMI_SUBAGENT_FALLBACK_NAME = 'subagent';

/** Every record type this parser acts on. */
const KIMI_DISPATCH_TYPES = [
  'turn.prompt',
  'turn.steer',
  'turn.ended',
  'turn.step.retrying',
  'turn.step.interrupted',
  'context.append_loop_event',
  'interaction.request',
  'interaction.resolved',
  'subagent.spawned',
  'subagent.completed',
  'subagent.failed',
  'subagent.cancelled',
  'full_compaction.begin',
  'plan_mode.enter',
  'plan_mode.exit',
  'token_counting.measured',
  'token_counting.rebased',
  'token_counting.truncated',
  'token_counting.turn_recorded',
  'llm.request',
  'usage.record',
] as const;

type KimiDispatchType = typeof KIMI_DISPATCH_TYPES[number];

function isKimiDispatchType(value: unknown): value is KimiDispatchType {
  return typeof value === 'string' && (KIMI_DISPATCH_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface WireParseOptions {
  /**
   * The context window of a model alias, from the user's `config.toml`
   * (`max_context_size`). The wire records the alias a request ran on
   * (`llm.request.modelAlias`) but not the window.
   */
  contextWindowForAlias?: (alias: string) => number | null;
  /** The display name of a model alias, from `config.toml` (`display_name`). */
  displayNameForAlias?: (alias: string) => string | null;
  /**
   * Each open call's tool name, by call id, kept across one session's chunks
   * (`KimiSessionHistoryParser.createParse`). Omitted, every chunk stands alone.
   */
  openToolNames?: Map<string, string>;
}

interface UsageCapture {
  usedTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  cachedInputTokens?: number;
  contextWindowSize?: number;
  modelId?: string;
  modelDisplayName?: string;
}

/**
 * Parse newly-appended `wire.jsonl` bytes (or the whole file) into events,
 * usage and an activity hint. Every chunk stands alone unless the caller passes
 * `openToolNames`.
 */
export function parseWireJsonl(
  content: string,
  _mode: 'full' | 'append',
  options: WireParseOptions = {},
): SessionHistoryParseResult {
  const events: SessionEvent[] = [];
  let activity: Activity | null = null;
  const usage: UsageCapture = {};

  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const type = parsed.type;
    if (!isKimiDispatchType(type)) continue;
    const ts = parseRecordTime(parsed.time);

    switch (type) {
      case 'turn.prompt':
      case 'turn.steer': {
        activity = Activity.Thinking;
        const text = contentPartsText(parsed.input);
        if (text) events.push({ ts, type: EventType.Prompt, detail: text });
        break;
      }
      case 'turn.ended': {
        activity = null;
        // A call a cancelled turn left open never gets its result.
        options.openToolNames?.clear();
        const reason = parsed.reason;
        if (reason === 'cancelled') {
          events.push({ ts, type: EventType.Interrupted });
        } else if (reason === 'failed') {
          events.push({ ts, type: EventType.TurnFailed, detail: turnErrorDetail(parsed.error) });
        } else {
          events.push({ ts, type: EventType.Idle });
        }
        break;
      }
      case 'turn.step.retrying': {
        const errorName = typeof parsed.errorName === 'string' && parsed.errorName.length > 0 ? parsed.errorName : 'retry';
        events.push({ ts, type: EventType.TurnRetrying, detail: errorName });
        break;
      }
      case 'turn.step.interrupted': {
        const reason = typeof parsed.reason === 'string' ? parsed.reason : 'interrupted';
        events.push({ ts, type: EventType.Notification, detail: `step interrupted: ${reason}` });
        break;
      }
      case 'context.append_loop_event': {
        const loopEvent = parsed.event;
        if (!isRecord(loopEvent)) break;
        const loopActivity = applyLoopEvent(loopEvent, ts, events, usage, options.openToolNames);
        if (loopActivity) activity = loopActivity;
        break;
      }
      case 'interaction.request': {
        const kind = parsed.kind;
        if (kind !== 'approval' && kind !== 'question') break;
        activity = null;
        events.push({ ts, type: EventType.Idle, detail: IdleReason.Permission, waitKind: kind });
        break;
      }
      case 'interaction.resolved': {
        activity = Activity.Thinking;
        break;
      }
      case 'subagent.spawned': {
        const subagentId = stringField(parsed.subagentId);
        const name = stringField(parsed.subagentName) ?? KIMI_SUBAGENT_FALLBACK_NAME;
        events.push({ ts, type: EventType.SubagentStart, detail: name, ...(subagentId ? { subagentId } : {}) });
        break;
      }
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.cancelled': {
        const subagentId = stringField(parsed.subagentId);
        events.push({
          ts,
          type: EventType.SubagentStop,
          detail: subagentId ?? KIMI_SUBAGENT_FALLBACK_NAME,
          ...(subagentId ? { subagentId } : {}),
        });
        break;
      }
      case 'full_compaction.begin': {
        activity = Activity.Thinking;
        events.push({ ts, type: EventType.Compact });
        break;
      }
      case 'plan_mode.enter':
      case 'plan_mode.exit': {
        events.push({ ts, type: EventType.Notification, detail: type === 'plan_mode.enter' ? 'plan mode on' : 'plan mode off' });
        break;
      }
      case 'token_counting.measured':
      case 'token_counting.rebased':
      case 'token_counting.truncated':
      case 'token_counting.turn_recorded': {
        const tokens = numberField(parsed.tokens);
        if (tokens !== undefined) usage.usedTokens = tokens;
        break;
      }
      case 'llm.request': {
        const alias = stringField(parsed.modelAlias);
        const model = stringField(parsed.model);
        const id = alias ?? model;
        if (id) {
          usage.modelId = id;
          usage.modelDisplayName = (alias ? options.displayNameForAlias?.(alias) : null) ?? id;
        }
        if (alias) {
          const window = options.contextWindowForAlias?.(alias);
          if (window && window > 0) usage.contextWindowSize = window;
        }
        break;
      }
      case 'usage.record': {
        // The model id is a fallback: `llm.request` names the alias the picker uses.
        const model = stringField(parsed.model);
        if (model && !usage.modelId) {
          usage.modelId = model;
          usage.modelDisplayName = model;
        }
        break;
      }
      default: {
        const exhaustive: never = type;
        void exhaustive;
      }
    }
  }

  return { usage: buildUsage(usage), events, activity };
}

/**
 * A `tool.call`'s event name. Only a session's parser, which can name the end
 * too, tags a call by its tool. The engine pairs an end with its start by name,
 * so with no memory every call stays `Bash`. `ExitPlanMode` stays `Bash` as
 * well: an end tagged `ExitPlanMode` means an approved plan, so a rejected
 * plan's end must not carry that name.
 */
function eventToolName(name: string, toolId: string | null | undefined, openToolNames: Map<string, string> | undefined): string {
  if (!openToolNames || !toolId || name === AgentTool.ExitPlanMode) return AgentTool.Bash;
  return name;
}

/** Apply one `context.append_loop_event` event; returns an activity to force, if any. */
function applyLoopEvent(
  loopEvent: Record<string, unknown>,
  ts: number,
  events: SessionEvent[],
  usage: UsageCapture,
  openToolNames: Map<string, string> | undefined,
): Activity | null {
  switch (loopEvent.type) {
    case 'step.begin':
      return Activity.Thinking;
    case 'step.end': {
      applyTokenUsage(loopEvent.usage, usage);
      return null;
    }
    case 'tool.call': {
      const name = stringField(loopEvent.name) ?? KIMI_TOOL_FALLBACK_NAME;
      const toolId = stringField(loopEvent.toolCallId);
      const command = name === KIMI_SHELL_TOOL ? shellCommand(loopEvent.args) : null;
      const tool = eventToolName(name, toolId, openToolNames);
      if (toolId && tool !== AgentTool.Bash) openToolNames?.set(toolId, tool);
      events.push({
        ts,
        type: EventType.ToolStart,
        tool,
        ...(toolId ? { toolId } : {}),
        // Capped as a hook's detail is: the event cache keeps it and the
        // command detectors scan it per event.
        detail: command !== null ? command.slice(0, HOOK_DETAIL_CAP) : name,
      });
      return null;
    }
    case 'tool.result': {
      const toolId = stringField(loopEvent.toolCallId);
      const result = isRecord(loopEvent.result) ? loopEvent.result : {};
      const isError = result.isError === true;
      const output = contentPartsText(result.output) ?? '';
      const planApproved = !isError && output.trimStart().startsWith(APPROVED_PLAN_PREFIX);
      const openTool = toolId ? openToolNames?.get(toolId) : undefined;
      if (toolId) openToolNames?.delete(toolId);
      events.push({
        ts,
        type: EventType.ToolEnd,
        tool: planApproved ? AgentTool.ExitPlanMode : openTool ?? AgentTool.Bash,
        ...(toolId ? { toolId } : {}),
        detail: isError ? 'error' : 'ok',
      });
      return null;
    }
    default:
      return null;
  }
}

/** Fold a step's `TokenUsage` (`inputOther`, `output`, `inputCacheRead`, `inputCacheCreation`). */
function applyTokenUsage(value: unknown, usage: UsageCapture): void {
  if (!isRecord(value)) return;
  const inputOther = numberField(value.inputOther);
  const output = numberField(value.output);
  const cacheRead = numberField(value.inputCacheRead);
  const cacheCreation = numberField(value.inputCacheCreation);
  if (inputOther !== undefined || cacheRead !== undefined || cacheCreation !== undefined) {
    usage.totalInputTokens = (inputOther ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
  }
  if (cacheRead !== undefined || cacheCreation !== undefined) {
    usage.cachedInputTokens = (cacheRead ?? 0) + (cacheCreation ?? 0);
  }
  if (output !== undefined) usage.totalOutputTokens = output;
}

/**
 * A sparse usage report: only the fields this chunk saw, so the downstream
 * shallow merge keeps earlier values. Null when it saw none.
 */
function buildUsage(captured: UsageCapture): SessionUsage | null {
  const contextWindow: Partial<SessionUsage['contextWindow']> = {};
  if (captured.usedTokens !== undefined) contextWindow.usedTokens = captured.usedTokens;
  if (captured.totalInputTokens !== undefined) contextWindow.totalInputTokens = captured.totalInputTokens;
  if (captured.totalOutputTokens !== undefined) contextWindow.totalOutputTokens = captured.totalOutputTokens;
  if (captured.cachedInputTokens !== undefined) contextWindow.cacheTokens = captured.cachedInputTokens;
  if (captured.contextWindowSize !== undefined) contextWindow.contextWindowSize = captured.contextWindowSize;
  if (captured.usedTokens !== undefined && captured.contextWindowSize !== undefined && captured.contextWindowSize > 0) {
    contextWindow.usedPercentage = (captured.usedTokens / captured.contextWindowSize) * 100;
  }
  const hasWindow = Object.keys(contextWindow).length > 0;
  const model = captured.modelId
    ? { id: captured.modelId, displayName: captured.modelDisplayName ?? captured.modelId, reportedByAgent: true }
    : null;
  if (!hasWindow && !model) return null;
  return {
    ...(hasWindow ? { contextWindow } : {}),
    ...(model ? { model } : {}),
  } as unknown as SessionUsage;
}

/**
 * The text of a `ContentPart[]` (or a plain string): every `text` part joined,
 * think and media parts skipped. Null when nothing is left.
 */
export function contentPartsText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : null;
  }
  if (!Array.isArray(value)) return null;
  const pieces: string[] = [];
  for (const part of value) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
      pieces.push(part.text);
    }
  }
  return pieces.length > 0 ? pieces.join('\n') : null;
}

/** The `command` of a `Bash` call's `args` (an object, or a JSON string). */
function shellCommand(args: unknown): string | null {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const command = value.command;
  return typeof command === 'string' && command.trim().length > 0 ? command : null;
}

/** A failed turn's detail: its error's name or code, else its message. */
function turnErrorDetail(error: unknown): string {
  if (!isRecord(error)) return 'failed';
  return stringField(error.name) ?? stringField(error.code) ?? stringField(error.message) ?? 'failed';
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A record's `time` as epoch ms. The metadata line's `created_at` is
 * `Date.now()` (`record.ts`); a value that reads as seconds is scaled, so a
 * record written in either unit lands on the right clock.
 */
export function parseRecordTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  return Date.now();
}
