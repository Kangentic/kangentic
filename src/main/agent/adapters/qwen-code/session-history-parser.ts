import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type SessionHistoryParseResult,
  type SessionUsage,
  type SessionEvent,
} from '../../../../shared/types';

/**
 * Parser for Qwen Code's native session JSONL file.
 *
 * Empirically verified against Qwen Code 0.15.3 on disk. NOTE: Despite
 * being a fork of gemini-cli, Qwen Code does NOT inherit Gemini's
 * `~/.gemini/tmp/<basename>/chats/session-<timestamp><shortId>.json`
 * scheme. The fork moved chat persistence to a different layout
 * entirely.
 *
 * **Path scheme:** `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`
 *
 * **`<sanitized-cwd>` derivation** (per `sanitizeCwd` in qwen-code/cli.js):
 *   1. Lowercase the cwd path on Windows (no-op on Unix).
 *   2. Replace every non-alphanumeric character with `-`.
 *
 *   Example: `C:\Users\dev\proj\.qwen\worktrees\X` lowercased becomes
 *   `c:\users\dev\proj\.qwen\worktrees\x`, then every `:`, `\`, and `.`
 *   becomes `-` -> `c--users-dev-proj--qwen-worktrees-x`.
 *
 * **`<sessionId>.jsonl`**: filename is exactly the session UUID with no
 *   prefix or timestamp. The session UUID is also embedded in every
 *   event record's `sessionId` field. Since we use caller-owned UUIDs
 *   via `--session-id`, locate() is a direct path construction.
 *
 * **File format**: append-only JSONL. Each line is one JSON event:
 *
 *   - `type: "user"` -- user prompt
 *       { message: { role: "user", parts: [{ text }] } }
 *
 *   - `type: "assistant"` -- model response (the line we care about)
 *       {
 *         model: "claude-...",
 *         message: { role: "model", parts: [...] },
 *         usageMetadata: {
 *           cachedContentTokenCount,
 *           promptTokenCount,
 *           candidatesTokenCount,
 *           totalTokenCount
 *         },
 *         contextWindowSize: 200000   // <-- real window size, no lookup needed
 *       }
 *
 *   - `type: "system"` with `subtype: "ui_telemetry"` -- api_response /
 *     api_error telemetry. Useful for surfacing per-call latency or
 *     error info, ignored here.
 *
 * Walks the file backwards to find the most recent `type: "assistant"`
 * record with `usageMetadata`, since later turns may downgrade the
 * model via `/model` and we want the active model + its current totals.
 */
export class QwenSessionHistoryParser {
  /**
   * Locate the JSONL file for a known session UUID. Real Qwen names
   * the file exactly `<sessionId>.jsonl`, and we always know the UUID
   * up front because the adapter passes `--session-id <uuid>`. Polls
   * briefly because the file may not exist until after the first user
   * turn lands.
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    const { agentSessionId, cwd } = options;
    const directory = qwenChatsDir(cwd);
    const filePath = path.join(directory, `${agentSessionId}.jsonl`);

    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (fs.existsSync(filePath)) return filePath;
      await sleep(500);
    }
    return null;
  }

  /**
   * Parse the JSONL chat file. The watcher passes either the full file
   * (`mode: 'full'`) or just newly-appended bytes (`mode: 'append'`).
   * Both modes go through the same line-walker because each line is a
   * self-contained JSON event - there is no whole-file structure to
   * reconstruct.
   *
   * We walk lines backwards to find the most recent `type: "assistant"`
   * record carrying `usageMetadata`. That gives us the latest model and
   * cumulative token counts, respecting any mid-session `/model`
   * switches.
   */
  static parse(content: string, _mode: 'full' | 'append'): SessionHistoryParseResult {
    const lines = content.split('\n');
    let latestAssistant: AssistantEvent | null = null;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { continue; }
      if (!isRecord(parsed)) continue;
      if (parsed.type !== 'assistant') continue;
      // Safe cast: we just narrowed `type === 'assistant'` and isRecord
      // confirmed object shape. Other AssistantEvent fields are
      // optional and individually validated below.
      latestAssistant = parsed as unknown as AssistantEvent;
      break;
    }

    if (!latestAssistant) {
      return { usage: null, events: [], activity: null };
    }

    const modelId = typeof latestAssistant.model === 'string' ? latestAssistant.model : '';
    const usageMetadata = isRecord(latestAssistant.usageMetadata) ? latestAssistant.usageMetadata : null;
    const inputTokens = toNumber(usageMetadata?.promptTokenCount) ?? 0;
    const outputTokens = toNumber(usageMetadata?.candidatesTokenCount) ?? 0;
    const cachedTokens = toNumber(usageMetadata?.cachedContentTokenCount) ?? 0;

    // Qwen 0.15.3 records the actual context window size on every
    // assistant event - no model lookup table needed. Fall back to 0
    // if the field is missing (older builds).
    const contextWindowSize = toNumber(latestAssistant.contextWindowSize) ?? 0;
    const percentage = contextWindowSize > 0
      ? (inputTokens / contextWindowSize) * 100
      : 0;

    const usage: SessionUsage = {
      contextWindow: {
        usedPercentage: percentage,
        usedTokens: inputTokens,
        cacheTokens: cachedTokens,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        contextWindowSize,
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

    const events: SessionEvent[] = [];
    return { usage, events, activity: null };
  }
}

// ---------- Internal helpers ----------

interface AssistantEvent {
  type: 'assistant';
  model?: string;
  contextWindowSize?: number;
  usageMetadata?: {
    cachedContentTokenCount?: number;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** Type guard for a plain JSON object (not null, not array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce an unknown value to a finite number, or undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

/**
 * Compute the chats directory path for a given cwd. Mirrors the real
 * Qwen Code's `Storage.getProjectDir()` + "/chats" derivation:
 *
 *   ~/.qwen/projects/<sanitizeCwd(cwd)>/chats
 *
 * Where `sanitizeCwd` lowercases the path on Windows and replaces every
 * non-alphanumeric character with `-`. Verified against the bundled
 * cli.js (`function sanitizeCwd(cwd6) { ... .replace(/[^a-zA-Z0-9]/g, "-") }`)
 * and against real on-disk directory names.
 *
 * Exported so tests (and any future caller that needs to reason about
 * Qwen's per-cwd file layout) can derive the same path the parser uses
 * internally - guarantees the test mkdir and the parser scan agree
 * byte-for-byte.
 */
export function qwenChatsDir(cwd: string): string {
  return path.join(os.homedir(), '.qwen', 'projects', sanitizeCwd(cwd), 'chats');
}

/**
 * Match `sanitizeCwd` from the real Qwen Code source so our adapter
 * scans the same directory the CLI writes to. Exported (via the
 * module-level wrapper above) only as needed; tests import it via the
 * same chats-dir helper.
 */
function sanitizeCwd(cwd: string): string {
  const normalized = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Simple async sleep helper for polling loops. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
