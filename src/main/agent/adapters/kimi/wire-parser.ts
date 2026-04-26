import {
  Activity,
  EventType,
  AgentTool,
  IdleReason,
  type SessionHistoryParseResult,
  type SessionUsage,
  type SessionEvent,
} from '../../../../shared/types';

/**
 * Parser for Kimi CLI's `wire.jsonl` session telemetry.
 *
 * Wire protocol v1.9 (verified empirically against `kimi --print
 * --output-format stream-json` on v1.37.0 + the upstream schema in
 * `docs/en/customization/wire-mode.md`).
 *
 * On-disk layout:
 *   `~/.kimi/sessions/<work_dir_hash>/<session_uuid>/wire.jsonl`
 *
 * The `<work_dir_hash>` is a 32-char hex of the absolute work_dir path
 * (algorithm not exposed; we never compute it - the locator globs across
 * all hashes and matches by UUID).
 *
 * File format: append-only JSONL.
 *   Line 1 (always):
 *     {"type": "metadata", "protocol_version": "1.9"}
 *   Lines 2..N:
 *     {"timestamp": <unix_seconds_float>,
 *      "message": {"type": "<MessageName>", "payload": {...}}}
 *
 * Resume via `kimi -r <uuid>` *appends* to the same file, so this parser
 * is wired into runtime.sessionHistory with `isFullRewrite: false`.
 *
 * The wire protocol defines 19 Event types and 4 Request types. Both
 * share the `{type, payload}` envelope shape inside the wire.jsonl
 * line, so this parser dispatches on `message.type` regardless of
 * Event-vs-Request kind. Requests show up in wire.jsonl when the agent
 * blocks waiting for an external response (approval, question, hook
 * callback) - their presence drives the activity state into Idle with
 * an appropriate IdleReason.
 *
 * Mapping table:
 *
 *   Event              Activity      SessionEvent emitted
 *   ─────────────────  ────────────  ───────────────────────────
 *   TurnBegin          → Thinking    Prompt (detail = user input)
 *   TurnEnd            → Idle        (none)
 *   StepBegin          → Thinking    (none)
 *   StepInterrupted    → Idle        Interrupted
 *   CompactionBegin    → Thinking    Compact
 *   CompactionEnd      (preserve)    (none)
 *   StatusUpdate       (preserve)    (none; updates SessionUsage)
 *   ContentPart        (preserve)    (none; streaming text fragment)
 *   ToolCall           (preserve)    ToolStart (detail = tool name)
 *   ToolCallPart       (preserve)    (none; argument-streaming fragment)
 *   ToolResult         (preserve)    ToolEnd (detail = ok | error)
 *   ApprovalResponse   → Thinking    Notification (detail = response)
 *   SubagentEvent      (preserve)    Notification (detail = subagent_type)
 *   BtwBegin           (preserve)    SubagentStart (detail = "btw")
 *   BtwEnd             (preserve)    SubagentStop  (detail = "btw")
 *   SteerInput         → Thinking    Prompt (detail = user input)
 *   PlanDisplay        (preserve)    Notification (detail = file_path)
 *   HookTriggered      (preserve)    Notification (detail = "<event>:<target>")
 *   HookResolved       (preserve)    Notification (detail = "<event>:<action>")
 *
 *   Request            Activity      SessionEvent emitted
 *   ─────────────────  ────────────  ───────────────────────────
 *   ApprovalRequest    → Idle        Idle (detail = IdleReason.Permission)
 *   ToolCallRequest    (preserve)    ToolStart (detail = name)
 *   QuestionRequest    → Idle        Idle (detail = IdleReason.Permission)
 *   HookRequest        (preserve)    Notification (detail = "<event>:<target>")
 *
 * All other inputs (malformed JSON, unrecognized types, missing
 * envelope fields) are skipped silently. Defensive parsing throughout.
 */

/** Every wire-protocol message type we explicitly handle. */
const KIMI_DISPATCH_TYPES = [
  // Events
  'TurnBegin',
  'TurnEnd',
  'StepBegin',
  'StepInterrupted',
  'CompactionBegin',
  'CompactionEnd',
  'StatusUpdate',
  'ContentPart',
  'ToolCall',
  'ToolCallPart',
  'ToolResult',
  'ApprovalResponse',
  'SubagentEvent',
  'BtwBegin',
  'BtwEnd',
  'SteerInput',
  'PlanDisplay',
  'HookTriggered',
  'HookResolved',
  // Requests
  'ApprovalRequest',
  'ToolCallRequest',
  'QuestionRequest',
  'HookRequest',
] as const;

/**
 * Sentinel value emitted as the `detail` field of a `ToolStart` event when
 * a `ToolCall` arrives with neither `function.name` nor `payload.type`.
 * Exported so tests can reference the constant rather than duplicating the
 * literal, and so future renames flow through both sides automatically.
 */
export const KIMI_TOOL_FALLBACK_NAME = 'tool';

/**
 * Sentinel `detail` for `BtwBegin` / `BtwEnd` events (Kimi's "Brain
 * Truster" sidebar - a parallel reasoning context that runs alongside the
 * main turn). Surfaced as a Subagent start/stop pair to mirror Claude's
 * Task-tool subagent telemetry.
 */
export const KIMI_BTW_SUBAGENT_NAME = 'btw';

/**
 * Sentinel `detail` for a `SubagentEvent` whose payload omits both
 * `subagent_type` and `agent_id`. Falls through to "subagent" so the
 * Activity log row is meaningful instead of empty.
 */
export const KIMI_SUBAGENT_FALLBACK_NAME = 'subagent';

type KimiDispatchType = typeof KIMI_DISPATCH_TYPES[number];

function isKimiDispatchType(value: unknown): value is KimiDispatchType {
  return typeof value === 'string'
    && (KIMI_DISPATCH_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Captured StatusUpdate token-usage fields. Sparse on purpose: only fields
 * seen in this chunk are emitted, matching Codex's pattern so that the
 * downstream shallow-merge in `setSessionUsage()` doesn't clobber correct
 * base values with zeros.
 */
interface UsageAccumulator {
  usedTokens: number | undefined;
  totalInputTokens: number | undefined;
  totalOutputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  contextWindowSize: number | undefined;
  usedPercentage: number | undefined;
}

/**
 * Parse `content` (newly-appended JSONL bytes when isFullRewrite=false,
 * or the entire file when called from a resume reload) into a
 * consolidated `SessionHistoryParseResult`.
 *
 * Last-wins semantics for usage fields, append-only for events.
 *
 * Activity is set to whichever transition was observed last in the
 * chunk - so a chunk that contains TurnBegin → ToolCall → ToolResult →
 * TurnEnd settles on Idle, while a partial chunk that only includes
 * TurnBegin stays on Thinking. Events that don't have a defined activity
 * meaning (StatusUpdate, ContentPart, ToolCallPart, ...) DO NOT touch
 * the activity variable - they're observers, not transitioners.
 */
export function parseWireJsonl(
  content: string,
  _mode: 'full' | 'append',
): SessionHistoryParseResult {
  const events: SessionEvent[] = [];
  let activity: Activity | null = null;

  const usageAcc: UsageAccumulator = {
    usedTokens: undefined,
    totalInputTokens: undefined,
    totalOutputTokens: undefined,
    cachedInputTokens: undefined,
    contextWindowSize: undefined,
    usedPercentage: undefined,
  };

  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    // Header line: {"type": "metadata", "protocol_version": "1.9"}.
    // No timestamp / message envelope. Skip.
    if (parsed.type === 'metadata') continue;

    // Standard envelope: { timestamp, message: { type, payload } }.
    const message = parsed.message;
    if (!isRecord(message)) continue;
    const rawType = message.type;
    const payload = message.payload;
    if (!isKimiDispatchType(rawType)) continue;
    const messageType: KimiDispatchType = rawType;

    // Timestamp is unix seconds (float). SessionEvent.ts expects ms.
    const timestamp = parseTimestamp(parsed.timestamp);

    // Switch on the typed dispatch literal so TypeScript narrows each
    // branch. A new entry in KIMI_DISPATCH_TYPES that isn't handled here
    // surfaces as an exhaustiveness error at the default `assertNever`
    // branch below.
    switch (messageType) {
      // ── Lifecycle / activity transitions ────────────────────────────
      case 'TurnBegin': {
        activity = Activity.Thinking;
        if (isRecord(payload)) {
          const text = extractUserInputText(payload.user_input);
          if (text) {
            events.push({ ts: timestamp, type: EventType.Prompt, detail: text });
          }
        }
        break;
      }
      case 'TurnEnd': {
        activity = Activity.Idle;
        break;
      }
      case 'StepBegin': {
        activity = Activity.Thinking;
        break;
      }
      case 'StepInterrupted': {
        activity = Activity.Idle;
        events.push({ ts: timestamp, type: EventType.Interrupted });
        break;
      }
      case 'CompactionBegin': {
        activity = Activity.Thinking;
        events.push({ ts: timestamp, type: EventType.Compact });
        break;
      }
      case 'CompactionEnd': {
        // Compaction finished, but the turn may still be running. We do
        // NOT force activity here - the next TurnEnd or next StepBegin
        // will settle it. Surfacing a no-op preserves the activity that
        // preceded compaction (typically Thinking).
        break;
      }
      case 'SteerInput': {
        activity = Activity.Thinking;
        if (isRecord(payload)) {
          const text = extractUserInputText(payload.user_input);
          if (text) {
            events.push({ ts: timestamp, type: EventType.Prompt, detail: text });
          }
        }
        break;
      }

      // ── Telemetry ───────────────────────────────────────────────────
      case 'StatusUpdate': {
        if (isRecord(payload)) {
          accumulateStatusUpdate(payload, usageAcc);
        }
        break;
      }
      case 'ContentPart':
      case 'ToolCallPart': {
        // Streaming-fragment events. They arrive between StatusUpdates
        // and ToolCalls and don't carry independent activity meaning.
        // Skip silently. Listed explicitly so this case is exhaustive
        // and a future protocol bump that adds payload fields we want
        // to observe shows up at the dispatch list and forces a
        // decision rather than getting silently filtered.
        break;
      }

      // ── Tool calls ─────────────────────────────────────────────────
      case 'ToolCall': {
        if (isRecord(payload)) {
          const toolName = extractToolCallName(payload);
          events.push({
            ts: timestamp,
            type: EventType.ToolStart,
            tool: AgentTool.Bash,
            detail: toolName,
          });
        }
        break;
      }
      case 'ToolResult': {
        if (isRecord(payload)) {
          const returnValue = payload.return_value;
          const isError = isRecord(returnValue) && returnValue.is_error === true;
          events.push({
            ts: timestamp,
            type: EventType.ToolEnd,
            tool: AgentTool.Bash,
            detail: isError ? 'error' : 'ok',
          });
        }
        break;
      }

      // ── Approval / question flow ───────────────────────────────────
      case 'ApprovalRequest': {
        activity = Activity.Idle;
        events.push({
          ts: timestamp,
          type: EventType.Idle,
          detail: IdleReason.Permission,
        });
        break;
      }
      case 'QuestionRequest': {
        // Closest semantic match in our IdleReason enum. The agent is
        // blocked waiting for a user response; treat it identically to
        // a permission request for activity purposes.
        activity = Activity.Idle;
        events.push({
          ts: timestamp,
          type: EventType.Idle,
          detail: IdleReason.Permission,
        });
        break;
      }
      case 'ApprovalResponse': {
        // The user responded; the agent will resume work.
        activity = Activity.Thinking;
        if (isRecord(payload)) {
          const response = typeof payload.response === 'string' ? payload.response : null;
          events.push({
            ts: timestamp,
            type: EventType.Notification,
            detail: response ?? 'approval_response',
          });
        }
        break;
      }

      // ── Subagent / Brain-Truster lifecycle ─────────────────────────
      case 'SubagentEvent': {
        if (isRecord(payload)) {
          const subagentDetail = extractSubagentDetail(payload);
          events.push({
            ts: timestamp,
            type: EventType.Notification,
            detail: subagentDetail,
          });
        }
        break;
      }
      case 'BtwBegin': {
        events.push({
          ts: timestamp,
          type: EventType.SubagentStart,
          detail: KIMI_BTW_SUBAGENT_NAME,
        });
        break;
      }
      case 'BtwEnd': {
        events.push({
          ts: timestamp,
          type: EventType.SubagentStop,
          detail: KIMI_BTW_SUBAGENT_NAME,
        });
        break;
      }

      // ── Plan / hook telemetry ──────────────────────────────────────
      case 'PlanDisplay': {
        if (isRecord(payload)) {
          const filePath = typeof payload.file_path === 'string' && payload.file_path.length > 0
            ? payload.file_path
            : 'plan';
          events.push({
            ts: timestamp,
            type: EventType.Notification,
            detail: filePath,
          });
        }
        break;
      }
      case 'HookTriggered': {
        if (isRecord(payload)) {
          events.push({
            ts: timestamp,
            type: EventType.Notification,
            detail: formatHookDetail(payload),
          });
        }
        break;
      }
      case 'HookResolved': {
        if (isRecord(payload)) {
          events.push({
            ts: timestamp,
            type: EventType.Notification,
            detail: formatHookResolvedDetail(payload),
          });
        }
        break;
      }
      case 'HookRequest': {
        if (isRecord(payload)) {
          events.push({
            ts: timestamp,
            type: EventType.Notification,
            detail: formatHookDetail(payload),
          });
        }
        break;
      }

      // ── Bidirectional tool call (request form) ─────────────────────
      case 'ToolCallRequest': {
        // The Request form of a tool call - the agent waits for the
        // external Wire client to execute the tool. From our passive-
        // observer perspective it's identical telemetry to a ToolCall
        // event: emit ToolStart so activity tracking sees an in-flight
        // tool. The corresponding ToolResult (or ToolCallRequest's
        // response message in JSON-RPC) closes it.
        if (isRecord(payload)) {
          const name = typeof payload.name === 'string' && payload.name.length > 0
            ? payload.name
            : KIMI_TOOL_FALLBACK_NAME;
          events.push({
            ts: timestamp,
            type: EventType.ToolStart,
            tool: AgentTool.Bash,
            detail: name,
          });
        }
        break;
      }

      default: {
        // Exhaustiveness check - if KIMI_DISPATCH_TYPES grows without a
        // matching case here, this line becomes a TS2367 error.
        const exhaustive: never = messageType;
        void exhaustive;
      }
    }
  }

  const usage = buildUsage(usageAcc);
  return { usage, events, activity };
}

// ────────────────────────────────────────────────────────────────────
// Payload helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Extract a single human-readable string from a `user_input` payload
 * field. `user_input` is `string | ContentPart[]` per the wire schema,
 * where a ContentPart is one of TextPart, ThinkPart, ImageURLPart,
 * AudioURLPart, VideoURLPart.
 *
 * For a string, return it directly (trimmed). For an array, join all
 * `text` parts; ignore think/media parts since they aren't human prompt
 * content. Returns null when the result is empty so the caller can skip
 * emitting a no-op Prompt event.
 */
function extractUserInputText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(value)) return null;

  const textPieces: string[] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      const trimmed = part.text.trim();
      if (trimmed.length > 0) textPieces.push(trimmed);
    }
    // Other ContentPart shapes (think/image/audio/video) intentionally
    // skipped - they aren't user prompt content.
  }
  if (textPieces.length === 0) return null;
  return textPieces.join(' ');
}

/**
 * Resolve the tool name for a `ToolCall` payload, walking the
 * `function.name` → `payload.type` → fallback chain.
 */
function extractToolCallName(payload: Record<string, unknown>): string {
  const fn = payload.function;
  if (isRecord(fn) && typeof fn.name === 'string' && fn.name.length > 0) {
    return fn.name;
  }
  if (typeof payload.type === 'string' && payload.type.length > 0) {
    return payload.type;
  }
  return KIMI_TOOL_FALLBACK_NAME;
}

/**
 * Resolve the detail string for a `SubagentEvent` payload. Prefers
 * `subagent_type`, then `agent_id`, then a stable fallback so the
 * Activity log row always has a meaningful identifier.
 */
function extractSubagentDetail(payload: Record<string, unknown>): string {
  const subagentType = payload.subagent_type;
  if (typeof subagentType === 'string' && subagentType.length > 0) {
    return subagentType;
  }
  const agentId = payload.agent_id;
  if (typeof agentId === 'string' && agentId.length > 0) {
    return agentId;
  }
  return KIMI_SUBAGENT_FALLBACK_NAME;
}

/**
 * Format a hook event's `<event>:<target>` detail string. Used by both
 * `HookTriggered` and `HookRequest` since they share the same
 * `event` + `target` fields.
 */
function formatHookDetail(payload: Record<string, unknown>): string {
  const event = typeof payload.event === 'string' ? payload.event : 'hook';
  const target = typeof payload.target === 'string' ? payload.target : '';
  return target.length > 0 ? `${event}:${target}` : event;
}

/**
 * Format a `HookResolved` detail string emphasizing the `action`
 * (allow|block) since that is what changes the agent's behavior. The
 * `reason` field, when present, is appended for diagnostic context.
 */
function formatHookResolvedDetail(payload: Record<string, unknown>): string {
  const event = typeof payload.event === 'string' ? payload.event : 'hook';
  const action = typeof payload.action === 'string' ? payload.action : 'unknown';
  const reason = typeof payload.reason === 'string' && payload.reason.length > 0
    ? payload.reason
    : null;
  const head = `${event}:${action}`;
  return reason ? `${head} (${reason})` : head;
}

/**
 * Fold a `StatusUpdate` payload into the running usage accumulator.
 * Mutates `acc` in place; only fields actually seen in the payload are
 * touched so `setSessionUsage()`'s shallow merge doesn't overwrite
 * established base values with zeros.
 */
function accumulateStatusUpdate(
  payload: Record<string, unknown>,
  acc: UsageAccumulator,
): void {
  const ratio = payload.context_usage;
  if (typeof ratio === 'number' && Number.isFinite(ratio)) {
    // context_usage is a 0..1 ratio per upstream docs. Convert to %
    // for the SessionUsage contract.
    acc.usedPercentage = ratio * 100;
  }
  const ctxTokens = payload.context_tokens;
  if (typeof ctxTokens === 'number' && Number.isFinite(ctxTokens)) {
    acc.usedTokens = ctxTokens;
  }
  const maxTokens = payload.max_context_tokens;
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
    acc.contextWindowSize = maxTokens;
  }

  const tokenUsage = payload.token_usage;
  if (!isRecord(tokenUsage)) return;

  // Aggregate token_usage subfields into a per-StatusUpdate snapshot.
  // input_other is fresh input (excludes cache hits), so the running
  // input total for the current step is input_other + input_cache_read +
  // input_cache_creation.
  //
  // IMPORTANT: token_usage in StatusUpdate is the *current step*
  // count per upstream (docs/customization/wire-mode.md), NOT a
  // session-cumulative total. Multiple StatusUpdates per turn each
  // report a different per-step value. Last-wins here means
  // contextWindow.totalInputTokens reflects the most recent step's
  // input count, mirroring Codex's `last_token_usage` semantics.
  // Context occupancy is driven separately by the `context_tokens` /
  // `max_context_tokens` pair which Kimi reports as cumulative
  // session size.
  const inputOther = numericField(tokenUsage.input_other);
  const inputCacheRead = numericField(tokenUsage.input_cache_read);
  const inputCacheCreation = numericField(tokenUsage.input_cache_creation);
  const output = numericField(tokenUsage.output);

  if (
    inputOther !== undefined
    || inputCacheRead !== undefined
    || inputCacheCreation !== undefined
  ) {
    acc.totalInputTokens = (inputOther ?? 0)
      + (inputCacheRead ?? 0)
      + (inputCacheCreation ?? 0);
  }
  if (output !== undefined) acc.totalOutputTokens = output;
  if (inputCacheRead !== undefined || inputCacheCreation !== undefined) {
    acc.cachedInputTokens = (inputCacheRead ?? 0) + (inputCacheCreation ?? 0);
  }
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * wire.jsonl timestamps are unix seconds (float) per empirical capture
 * (1777229783.576391). Convert to epoch ms for SessionEvent.ts.
 * Falls back to Date.now() for malformed values.
 */
function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 1000);
  }
  return Date.now();
}

/**
 * Build a sparse SessionUsage. Only includes fields seen in this chunk
 * so the downstream shallow merge does not clobber correct base values
 * with zeros. Returns null when nothing was captured.
 */
function buildUsage(captured: UsageAccumulator): SessionUsage | null {
  const {
    usedTokens,
    totalInputTokens,
    totalOutputTokens,
    cachedInputTokens,
    contextWindowSize,
    usedPercentage,
  } = captured;

  if (
    usedTokens === undefined
    && totalInputTokens === undefined
    && totalOutputTokens === undefined
    && cachedInputTokens === undefined
    && contextWindowSize === undefined
    && usedPercentage === undefined
  ) {
    return null;
  }

  const contextWindow: Record<string, number> = {};
  if (usedTokens !== undefined) contextWindow.usedTokens = usedTokens;
  if (totalInputTokens !== undefined) contextWindow.totalInputTokens = totalInputTokens;
  if (totalOutputTokens !== undefined) contextWindow.totalOutputTokens = totalOutputTokens;
  if (cachedInputTokens !== undefined) contextWindow.cacheTokens = cachedInputTokens;
  if (contextWindowSize !== undefined) contextWindow.contextWindowSize = contextWindowSize;
  if (usedPercentage !== undefined) {
    contextWindow.usedPercentage = usedPercentage;
  } else if (contextWindowSize !== undefined && contextWindowSize > 0 && usedTokens !== undefined) {
    // Fall back to derived percentage when StatusUpdate sent tokens
    // but not the ratio. Same belt-and-suspenders pattern as Codex.
    contextWindow.usedPercentage = (usedTokens / contextWindowSize) * 100;
  }

  return { contextWindow } as unknown as SessionUsage;
}
