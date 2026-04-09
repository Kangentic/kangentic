import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EventType,
  AgentTool,
  type SessionHistoryParseResult,
  type SessionUsage,
  type SessionEvent,
} from '../../../../shared/types';

/**
 * Parser for Claude Code's native session history files (project JSONL).
 *
 * Path: `~/.claude/projects/<projectSlug>/<sessionId>.jsonl`
 *
 * The `<projectSlug>` is NOT a hash - it is the cwd with every `/`, `\`,
 * `:`, and `.` character replaced by `-`. Verified empirically:
 *
 *   C:\Users\dev\project        → C--Users-dev-project
 *   /home/dev/project           → -home-dev-project
 *   C:\Users\dev\my.app         → C--Users-dev-my-app
 *
 * File format: append-only JSONL, one JSON object per line. Each entry
 * has top-level `type`, `timestamp`, `uuid`, `sessionId`, and (for
 * `user`/`assistant`) a nested `message` object. Recognized types we
 * care about for telemetry:
 *
 * - `user`              → ignored (no telemetry, content tracked elsewhere)
 * - `assistant`         → `message.model`, `message.usage`, and `tool_use`
 *                         content blocks become SessionEvents
 * - `system`/`summary`  → ignored
 *
 * This parser coexists with the hook-based pipeline (status.json +
 * events.jsonl). Both pipelines feed `UsageTracker.setSessionUsage`,
 * which 3-level merges partial updates - the native log ends up
 * authoritative for cumulative counts because it writes after the hook.
 *
 * Activity is intentionally always `null`: the hook pipeline already
 * drives Claude's activity state via `ActivityDetection.hooks()`. Two
 * sources fighting over activity transitions would cause flicker.
 *
 * All other entries are ignored. Defensive parsing throughout: any
 * malformed line is skipped without throwing.
 *
 * Cross-platform: uses os.homedir() + path.join. No shell-outs.
 * CRLF-tolerant line splitting.
 */
export class ClaudeSessionHistoryParser {
  /**
   * Locate the project JSONL file for a known session UUID. Called
   * after the PTY scraper (or caller-owned session ID) registers the
   * session ID. Polls for up to 5 seconds (disk write latency varies).
   *
   * Unlike Codex, Claude's filename is exactly `<sessionId>.jsonl` -
   * no timestamp prefix to regex around.
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    const { agentSessionId, cwd } = options;
    const slug = claudeProjectSlug(cwd);
    const filePath = path.join(
      os.homedir(),
      '.claude',
      'projects',
      slug,
      `${agentSessionId}.jsonl`,
    );

    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (fileExists(filePath)) return filePath;
      await sleep(500);
    }
    return null;
  }

  /**
   * Parse newly-appended JSONL content. Walks the entries in order and
   * builds a consolidated SessionHistoryParseResult. Usage is taken
   * from the LAST assistant turn in the chunk (per-turn snapshot, like
   * Codex's `last_token_usage`); events are append-only.
   */
  static parse(content: string, _mode: 'full' | 'append'): SessionHistoryParseResult {
    let modelId: string | undefined;
    let lastUsage: ClaudeUsageBlock | undefined;
    const events: SessionEvent[] = [];

    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

    for (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;

      if (entry.type !== 'assistant') continue;

      const message = entry.message;
      if (!isRecord(message)) continue;

      const model = message.model;
      if (typeof model === 'string' && model.length > 0) {
        modelId = model;
      }

      const usage = message.usage;
      if (isRecord(usage)) {
        const captured = readUsageBlock(usage);
        if (captured) lastUsage = captured;
      }

      const contentBlocks = message.content;
      if (Array.isArray(contentBlocks)) {
        const timestamp = parseTimestamp(entry.timestamp);
        for (const block of contentBlocks) {
          if (!isRecord(block)) continue;
          if (block.type !== 'tool_use') continue;
          const toolName = typeof block.name === 'string' ? block.name : 'tool';
          events.push({
            ts: timestamp,
            type: EventType.ToolStart,
            tool: mapClaudeToolName(toolName),
            detail: toolName,
          });
        }
      }
    }

    const usage = buildUsage(modelId, lastUsage);
    return { usage, events, activity: null };
  }
}

// ---------- Slug helper (exported for tests) ----------

/**
 * Compute Claude Code's `~/.claude/projects/<slug>/` directory name
 * from a cwd. Replace every `/`, `\`, `:`, and `.` character with `-`.
 * Each character is replaced individually (not collapsed), so
 * `C:\Users` becomes `C--Users` (one dash from `:`, one from `\`).
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/\\:.]/g, '-');
}

// ---------- Internal helpers ----------

interface ClaudeUsageBlock {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function readUsageBlock(usage: Record<string, unknown>): ClaudeUsageBlock | null {
  const inputTokens = toNumber(usage.input_tokens);
  const outputTokens = toNumber(usage.output_tokens);
  const cacheCreationTokens = toNumber(usage.cache_creation_input_tokens);
  const cacheReadTokens = toNumber(usage.cache_read_input_tokens);
  if (
    inputTokens === null
    && outputTokens === null
    && cacheCreationTokens === null
    && cacheReadTokens === null
  ) {
    return null;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
  };
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Claude tool names map to Kangentic's coarse `AgentTool` enum. The
 * activity state machine only cares about ToolStart/ToolEnd transitions,
 * not the specific tool identity, so all tool calls bucket as Bash. The
 * raw tool name is preserved in `SessionEvent.detail` for display.
 */
function mapClaudeToolName(_name: string): AgentTool {
  return AgentTool.Bash;
}

/**
 * Set of model names we've already warned about, so the WARN log fires
 * at most once per unique unknown model per process lifetime.
 */
const unknownModelWarningsLogged = new Set<string>();

/**
 * Look up the context window size for a given Claude model name.
 * Source: Anthropic's published model cards. Returns `null` for unknown
 * models so the caller can gracefully degrade rather than render a
 * misleading percentage against a guessed limit.
 *
 * The `[1m]` suffix on Opus 4.6 indicates the 1M-context variant.
 */
function resolveClaudeContextWindowSize(modelId: string): number | null {
  const lower = modelId.toLowerCase();
  if (lower.includes('[1m]')) return 1_000_000;
  // Claude 4.x generation
  if (lower.startsWith('claude-opus-4')) return 200_000;
  if (lower.startsWith('claude-sonnet-4')) return 1_000_000;
  if (lower.startsWith('claude-haiku-4')) return 200_000;
  // Claude 3.x generation (defensive - older sessions)
  if (lower.startsWith('claude-3-5-sonnet')) return 200_000;
  if (lower.startsWith('claude-3-5-haiku')) return 200_000;
  if (lower.startsWith('claude-3-opus')) return 200_000;
  if (lower.startsWith('claude-3-sonnet')) return 200_000;
  if (lower.startsWith('claude-3-haiku')) return 200_000;
  if (!unknownModelWarningsLogged.has(lower)) {
    unknownModelWarningsLogged.add(lower);
    console.warn(
      `[claude-session-history] unknown model "${modelId}" - context window size not in lookup table. `
      + `Card will show model name without progress bar. Update resolveClaudeContextWindowSize() `
      + `in src/main/agent/adapters/claude/session-history-parser.ts with the window size from Anthropic's model card.`,
    );
  }
  return null;
}

/**
 * Build a partial SessionUsage from the model + usage block captured in
 * a parse pass. Returns null when no signal was seen, or when the model
 * is unknown (degrades gracefully rather than guessing the window).
 */
function buildUsage(
  modelId: string | undefined,
  usage: ClaudeUsageBlock | undefined,
): SessionUsage | null {
  if (!modelId && !usage) return null;
  if (!modelId) return null;

  const windowSize = resolveClaudeContextWindowSize(modelId);
  if (windowSize === null) return null;

  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cacheCreationTokens = usage?.cacheCreationTokens ?? 0;
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;

  // Context occupancy = all input categories sent on the most recent
  // turn (regular input + freshly-cached prompt + cache-read prompt).
  // Output tokens are the model response and aren't held in context
  // until the next turn, so we exclude them from `usedTokens`.
  const usedTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  const percentage = windowSize > 0 ? (usedTokens / windowSize) * 100 : 0;

  return {
    contextWindow: {
      usedPercentage: percentage,
      usedTokens,
      cacheTokens: cacheReadTokens,
      totalInputTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
      totalOutputTokens: outputTokens,
      contextWindowSize: windowSize,
    },
    cost: {
      totalCostUsd: 0,
      totalDurationMs: 0,
    },
    model: {
      id: modelId,
      displayName: modelId,
    },
  };
}
