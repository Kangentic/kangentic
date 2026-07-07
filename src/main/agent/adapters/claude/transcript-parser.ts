import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  TranscriptEntry,
  TranscriptBlock,
  TranscriptUsage,
  TranscriptTurnUsage,
  TranscriptToolCounts,
  PerToolStat,
} from '../../../../shared/types';

// Maximum slug length before Claude Code truncates and appends a hash suffix.
// Matches the `jgH`/`NmK` constant in the shipped CLI (Claude Code 2.x).
const CLAUDE_SLUG_MAX_LENGTH = 200;

/**
 * Java-style string hash (`h = h * 31 + charCode | 0`) over the ORIGINAL,
 * un-sanitized path string. Claude Code uses this to disambiguate slugs that
 * collide after truncation. Reproduced exactly from the shipped CLI.
 */
function claudeStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash = hash | 0;
  }
  return hash;
}

/**
 * Compute Claude Code's `~/.claude/projects/<slug>/` directory name from a cwd.
 *
 * The algorithm was extracted from the shipped Claude Code CLI binary
 * (verified against Claude Code 2.x, 2026-06) and validated against the local
 * transcript directories: replace EVERY non-alphanumeric character with `-`
 * (so `/`, `\`, `:`, `.`, `_`, spaces, and unicode all become `-`); if the
 * result exceeds 200 characters, truncate to 200 and append `-<base36 hash>`
 * where the hash is taken over the original path string.
 *
 * Because both `/` and `\` map to `-`, the slug is separator-agnostic for any
 * path whose sanitized form is at most 200 characters (the overwhelming case).
 */
export function claudeProjectSlug(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= CLAUDE_SLUG_MAX_LENGTH) return sanitized;
  const suffix = Math.abs(claudeStringHash(cwd)).toString(36);
  return `${sanitized.slice(0, CLAUDE_SLUG_MAX_LENGTH)}-${suffix}`;
}

/**
 * Parse Claude Code's native session JSONL into a list of full transcript
 * entries (user prompts, assistant turns with text/thinking/tool_use blocks,
 * and tool results). Runs on demand from the renderer's Transcript tab.
 *
 * Claude's authoritative live telemetry comes from the hook-driven
 * `statusFile` pipeline (status.json + events.jsonl). The native session
 * JSONL is a secondary source: read on demand here (Transcript tab,
 * lifetime-token refinement) and tailed as a background-session fallback by
 * `session-history-parser.ts` until status.json starts flowing.
 */
export async function parseClaudeTranscript(filePath: string): Promise<TranscriptEntry[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  const lines = content.split(/\r?\n/);
  // A single assistant message (one `message.id`) can be written across several
  // JSONL lines; its `usage` must be attributed to exactly one turn, not every
  // line, or per-turn burn analysis double-counts it. Track which message ids
  // have already carried their usage onto an entry.
  const usageAttributedMessageIds = new Set<string>();

  for (const line of lines) {
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;

    const uuid = typeof raw.uuid === 'string' ? raw.uuid : '';
    const ts = parseTimestamp(raw.timestamp);
    const type = raw.type;

    // Conversation-compaction boundary: a system entry Claude writes when it
    // compacts the context. Surface it explicitly so the post-compaction
    // summary that follows is not read as a fresh start.
    if (type === 'system' && raw.subtype === 'compact_boundary') {
      entries.push({
        kind: 'system',
        uuid,
        ts,
        subtype: 'compaction',
        text: describeCompactBoundary(raw),
      });
      continue;
    }

    if (type === 'user') {
      // Skip Claude's own meta injections (skill preambles, queued-message
      // bookkeeping). They are not real user turns and otherwise render as
      // "## User" noise.
      if (raw.isMeta === true) continue;

      const message = raw.message;
      if (!isRecord(message)) continue;
      const messageContent = message.content;

      // Collect the user-authored text (string shorthand or text blocks) and
      // emit any tool_result blocks the SDK injected as synthetic user turns.
      let userText = '';
      if (typeof messageContent === 'string') {
        userText = messageContent;
      } else if (Array.isArray(messageContent)) {
        const textParts: string[] = [];
        for (const block of messageContent) {
          if (!isRecord(block)) continue;
          if (block.type === 'tool_result') {
            entries.push({
              kind: 'tool_result',
              uuid,
              ts,
              toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
              content: stringifyToolResultContent(block.content),
              isError: block.is_error === true,
            });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
        }
        userText = textParts.join('\n');
      }

      // Compaction summary: Claude writes the post-compaction recap as a
      // single user entry flagged isCompactSummary. Surface it as a
      // compaction system entry, not a "## User" turn.
      if (raw.isCompactSummary === true) {
        if (userText.length > 0) {
          entries.push({ kind: 'system', uuid, ts, subtype: 'compaction', text: userText });
        }
        continue;
      }

      if (userText.length === 0) continue;

      // Slash-command invocations: when the ENTIRE message is command XML,
      // collapse it to a compact marker (or drop empty local stdout) instead
      // of rendering raw <command-name>/<local-command-stdout> tags.
      const commandEntry = parseCommandEntry(userText, uuid, ts);
      if (commandEntry !== null) {
        if (commandEntry !== 'drop') entries.push(commandEntry);
        continue;
      }

      // Strip <system-reminder> spans from real user text; drop the entry
      // entirely if nothing meaningful remains (a reminder-only injection).
      const stripped = stripSystemReminders(userText);
      if (stripped.length === 0) continue;
      entries.push({ kind: 'user', uuid, ts, text: stripped });
      continue;
    }

    if (type === 'assistant') {
      const message = raw.message;
      if (!isRecord(message)) continue;
      const model = typeof message.model === 'string' ? message.model : undefined;
      const messageId = typeof message.id === 'string' ? message.id : null;

      const blocks: TranscriptBlock[] = [];

      const messageContent = message.content;
      if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            blocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            // Real Claude Code session JSONL never persists thinking text
            // (it stores only an encrypted `signature`). Empty thinking
            // blocks would render as useless empty disclosures, so skip
            // them. Kept the branch in case a future Claude version starts
            // persisting plaintext thinking - then it will be captured.
            if (typeof block.thinking === 'string' && block.thinking.length > 0) {
              blocks.push({ type: 'thinking', text: block.thinking });
            }
          } else if (block.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: typeof block.id === 'string' ? block.id : '',
              name: typeof block.name === 'string' ? block.name : 'tool',
              input: block.input,
            });
          }
        }
      }

      // A line that yields no blocks produces no entry, so skip it BEFORE
      // claiming this message's usage. With extended thinking, Claude writes a
      // turn as two lines under one message id - a thinking-only line (which we
      // drop, since persisted thinking is empty) followed by the text line. If
      // usage were claimed on the dropped thinking line, the message id would be
      // marked "attributed" and the following text entry (same id) would be
      // deduped out of its own usage, silently losing the whole turn's per-turn
      // tokens. Claiming usage only when an entry is actually emitted keeps it on
      // the first VISIBLE line of each message id.
      if (blocks.length === 0) continue;

      // Attribute this turn's usage to exactly one emitted entry per message id
      // (a single message can still span several emitted lines, e.g. text +
      // tool_use); the first emitted line claims it so a burn-rate sum never
      // double-counts a turn.
      let usage: TranscriptTurnUsage | undefined;
      if (!messageId || !usageAttributedMessageIds.has(messageId)) {
        usage = extractTurnUsage(message);
        if (usage && messageId) usageAttributedMessageIds.add(messageId);
      }

      entries.push(
        usage
          ? { kind: 'assistant', uuid, ts, model, usage, blocks }
          : { kind: 'assistant', uuid, ts, model, blocks },
      );
    }
  }

  return entries;
}

/**
 * Parse Claude's native session JSONL into CUMULATIVE lifetime token usage.
 *
 * The transcript is the only truly-cumulative token source on Claude Code
 * 2.1.132+: the statusLine `context_window` counts are a current-context-window
 * snapshot (summing them across `--resume` runs double-counts; taking the latest
 * under-reports), whereas this file is append-only across resumes/compactions.
 *
 * Per-message `usage` is deduped by `message.id` (the Claude Code cost-tracking
 * guidance: parallel tool calls in one turn, and any streamed re-emission of the
 * same assistant message, share a `message.id`, so its usage must be counted
 * once). Input is the full input side (input + cache creation + cache read);
 * output is `output_tokens`. Returns null when the file is missing/unreadable or
 * carries no assistant usage, so the caller can fall back to the live snapshot.
 */
export async function parseClaudeTranscriptUsage(filePath: string): Promise<TranscriptUsage | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null; // transcript rotated/absent -> caller falls back to the snapshot
  }

  // message.id -> deduped per-message usage (last write wins; usage is identical
  // across lines that share an id).
  const usageByMessageId = new Map<string, { input: number; output: number }>();
  for (const line of content.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw) || raw.type !== 'assistant') continue;
    const message = raw.message;
    if (!isRecord(message)) continue;
    const messageId = typeof message.id === 'string' ? message.id : null;
    const usage = message.usage;
    if (!messageId || !isRecord(usage)) continue;
    const input =
      numberOrZero(usage.input_tokens) +
      numberOrZero(usage.cache_creation_input_tokens) +
      numberOrZero(usage.cache_read_input_tokens);
    usageByMessageId.set(messageId, { input, output: numberOrZero(usage.output_tokens) });
  }

  if (usageByMessageId.size === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const entry of usageByMessageId.values()) {
    inputTokens += entry.input;
    outputTokens += entry.output;
  }
  return { inputTokens, outputTokens };
}

/**
 * Parse Claude's native session JSONL into a cumulative tool-call count + a
 * callCount-only per-tool breakdown. Backfills `UsageAccumulator.getToolCallCount`
 * for sessions whose ToolStart/ToolEnd hook events never reached the live
 * accumulator (e.g. a suspended/parked session reports 0 despite real work).
 *
 * Counts DISTINCT `tool_use.id` values, not raw blocks: parallel tool calls in
 * one assistant message have distinct ids and are all counted, but a single
 * assistant message re-emitted across several JSONL lines (the same pattern
 * `parseClaudeTranscriptUsage` dedups by `message.id` for) carries the same
 * `tool_use.id` on each re-emission and must not be double-counted. MCP tools
 * and `TodoWrite` are ordinary `tool_use` blocks and are counted like any other
 * tool. Returns null when the file is missing/unreadable or the transcript has
 * no tool_use blocks, so the caller keeps the live count.
 */
export async function parseClaudeTranscriptToolCounts(filePath: string): Promise<TranscriptToolCounts | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null; // transcript rotated/absent -> caller falls back to the live count
  }

  const countByTool = new Map<string, number>();
  const seenToolUseIds = new Set<string>();
  let toolCallCount = 0;

  for (const line of content.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw) || raw.type !== 'assistant') continue;
    const message = raw.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const toolUseId = typeof block.id === 'string' ? block.id : '';
      if (toolUseId.length > 0) {
        if (seenToolUseIds.has(toolUseId)) continue;
        seenToolUseIds.add(toolUseId);
      }
      const toolName = typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool';
      countByTool.set(toolName, (countByTool.get(toolName) ?? 0) + 1);
      toolCallCount += 1;
    }
  }

  if (toolCallCount === 0) return null;
  const toolBreakdown: PerToolStat[] = Array.from(countByTool, ([toolName, callCount]) => ({
    toolName,
    callCount,
    totalDurationMs: 0,
    interruptedCount: 0,
  }));
  return { toolCallCount, toolBreakdown };
}

/**
 * Locate the JSONL file for a Claude session given its agent session id
 * and original cwd. Returns null if the file does not exist (no polling -
 * unlike SessionHistoryReader.locate, this is called on demand and the
 * caller already knows the session has run).
 */
export function locateClaudeTranscriptFile(agentSessionId: string, cwd: string): string {
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    claudeProjectSlug(cwd),
    `${agentSessionId}.jsonl`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite number or 0 (for tolerant transcript `usage` field reads). */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Extract one assistant message's per-turn token usage, or undefined when the
 *  message carries no `usage` object. Keeps the raw component counts (fresh
 *  input, output, cache write, cache read) rather than a single sum. */
function extractTurnUsage(message: Record<string, unknown>): TranscriptTurnUsage | undefined {
  const usage = message.usage;
  if (!isRecord(usage)) return undefined;
  return {
    inputTokens: numberOrZero(usage.input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    cacheCreationInputTokens: numberOrZero(usage.cache_creation_input_tokens),
    cacheReadInputTokens: numberOrZero(usage.cache_read_input_tokens),
  };
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// The command-name / command-message / command-args blocks of a whole-message
// slash-command invocation. Claude emits these in EITHER order (older
// transcripts led with <command-name>, current ones lead with
// <command-message>), and they may carry leading indentation, so each is
// matched independently rather than pinned to a fixed sequence.
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
// Strips every recognized command-* block; if nothing but whitespace remains,
// the message was purely a command invocation (not command-plus-prose).
const COMMAND_BLOCKS_RE = /<(command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

// Whole-message local command stdout, e.g. <local-command-stdout>Goodbye!</local-command-stdout>
const COMMAND_STDOUT_RE = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/;

/**
 * Recognize a user entry whose ENTIRE text is slash-command XML and clean it up.
 * A slash-command invocation IS a user-role message (the user, or the board on
 * their behalf, ran the command), so it is returned as a normal `user` entry
 * carrying just the command as typed ("/code-review") rather than the raw
 * `<command-message>/<command-name>` wrapper - it should read as a message from
 * You, not a system divider. A local command's stdout stays a `command_output`
 * system entry. Returns the entry to push, the sentinel `'drop'` for empty
 * command stdout (no useful content), or `null` when the text is not a
 * whole-message command (so normal user-text handling applies). Mixed
 * command-plus-prose text is intentionally left to the caller.
 */
function parseCommandEntry(
  text: string,
  uuid: string,
  ts: number,
): TranscriptEntry | 'drop' | null {
  const trimmed = text.trim();

  const nameMatch = COMMAND_NAME_RE.exec(trimmed);
  if (nameMatch) {
    // Confirm the WHOLE message is command-* blocks (in any order) - anything
    // left after stripping them means it is command-plus-prose, which the
    // caller handles as normal user text.
    const residue = trimmed.replace(COMMAND_BLOCKS_RE, '').trim();
    if (residue.length === 0) {
      const name = nameMatch[1].trim();
      const args = (COMMAND_ARGS_RE.exec(trimmed)?.[1] ?? '').trim();
      const label = args ? `${name} ${args}` : name;
      return { kind: 'user', uuid, ts, text: label };
    }
  }

  const stdoutMatch = COMMAND_STDOUT_RE.exec(trimmed);
  if (stdoutMatch) {
    const output = stdoutMatch[1].trim();
    if (output.length === 0) return 'drop';
    return { kind: 'system', uuid, ts, subtype: 'command_output', text: output };
  }

  return null;
}

/** Remove `<system-reminder>...</system-reminder>` spans and trim. */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * Build a one-line description of a `compact_boundary` system entry from its
 * content and `compactMetadata` (trigger and pre-compaction token count).
 */
function describeCompactBoundary(raw: Record<string, unknown>): string {
  const content =
    typeof raw.content === 'string' && raw.content.length > 0
      ? raw.content
      : 'Conversation compacted';
  const meta = raw.compactMetadata;
  if (!isRecord(meta)) return content;

  const annotations: string[] = [];
  if (typeof meta.trigger === 'string' && meta.trigger.length > 0) {
    annotations.push(meta.trigger);
  }
  if (typeof meta.preTokens === 'number') {
    annotations.push(`${meta.preTokens} tokens before compaction`);
  }
  return annotations.length > 0 ? `${content} (${annotations.join(', ')})` : content;
}

/**
 * Tool result content can be a plain string or an array of content blocks.
 * Observed shapes in real Claude Code session JSONL:
 *
 * - Plain string (most common, ~97% of tool results)
 * - Array of `text` blocks (e.g. multi-paragraph Bash output)
 * - Array containing `tool_reference` blocks (e.g. ExitPlanMode results
 *   reference the approved tool by name as a sibling to text content)
 * - Array containing `image` blocks (rare, e.g. screenshot tools)
 *
 * Anything else collapses to an empty string. Unknown block types are
 * elided rather than dropped silently so the user can see something
 * happened.
 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (isRecord(block)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (block.type === 'image') {
          parts.push('[image]');
        } else if (block.type === 'tool_reference' && typeof block.tool_name === 'string') {
          parts.push(`[tool_reference: ${block.tool_name}]`);
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}
