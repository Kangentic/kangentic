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
 *   event record's `sessionId` field.
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
   * Scan `~/.qwen/projects/<sanitized-cwd>/chats/` for a session file
   * whose first event's `timestamp` says it was created by our spawn,
   * and return the file's session UUID. Primary capture path for Qwen
   * Code, since hooks may not fire reliably and PTY output only shows
   * the session ID at shutdown.
   *
   * Two-stage filter (matching Gemini's pattern):
   *   1. mtime >= spawnedAt - 30s    (cheap pre-filter)
   *   2. JSON `timestamp` of first event within +/- 30s of spawnedAt
   */
  static async captureSessionIdFromFilesystem(options: {
    spawnedAt: Date;
    cwd: string;
    maxAttempts?: number;
  }): Promise<string | null> {
    const spawnedAtMs = options.spawnedAt.getTime();
    const mtimeFloorMs = spawnedAtMs - 30_000;
    const startTimeFloorMs = spawnedAtMs - 30_000;
    const startTimeCeilMs = spawnedAtMs + 30_000;

    const directory = qwenChatsDir(options.cwd);
    // Real Qwen filenames are bare `<uuid>.jsonl`. Anchored UUID match
    // avoids picking up non-session JSONL files that may appear later.
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

    const maxAttempts = options.maxAttempts ?? 60;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const entries = safeReaddirWithStats(directory)
        .filter((entry) => pattern.test(entry.name) && entry.mtimeMs >= mtimeFloorMs);

      if (attempt === 0 && entries.length === 0) {
        console.log(`[qwen] captureSessionId: scanning ${directory} (no matching files yet)`);
      }

      for (const entry of entries) {
        const filePath = path.join(directory, entry.name);
        const meta = readQwenSessionMeta(filePath);
        if (!meta) continue;
        if (meta.startTimeMs < startTimeFloorMs) continue;
        if (meta.startTimeMs > startTimeCeilMs) continue;
        // Cache the discovered path so locate() can skip its own scan.
        discoveredSessionPaths.set(meta.sessionId, filePath);
        console.log(`[qwen] captureSessionId: found session ${meta.sessionId.slice(0, 8)} on attempt ${attempt}`);
        return meta.sessionId;
      }
      await sleep(500);
    }
    console.warn(
      `[qwen] captureSessionId: no matching session file found after `
      + `${Math.round(maxAttempts * 500 / 1000)}s in ${directory}`,
    );
    return null;
  }

  /**
   * Locate the JSONL file for a known session UUID. Real Qwen names
   * the file exactly `<sessionId>.jsonl` so this is a direct path
   * lookup with no scan needed. We poll briefly because the file may
   * not exist until after the first user turn lands.
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    const { agentSessionId, cwd } = options;

    // Fast path: captureSessionIdFromFilesystem already found this file.
    const cached = discoveredSessionPaths.get(agentSessionId);
    if (cached) {
      discoveredSessionPaths.delete(agentSessionId);
      if (fs.existsSync(cached)) return cached;
    }

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

/**
 * Read a directory and return each entry as `{ name, mtimeMs }`,
 * skipping anything that fails to stat. Returns an empty array when
 * the directory does not exist.
 */
function safeReaddirWithStats(directory: string): Array<{ name: string; mtimeMs: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const results: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(directory, name));
      results.push({ name, mtimeMs: stat.mtimeMs });
    } catch {
      // File vanished between readdir and stat - skip.
    }
  }
  return results;
}

/**
 * Read just enough of the JSONL file to extract `sessionId` and the
 * `timestamp` of its first event. Avoids loading the whole file when
 * we only need to time-window-filter candidates.
 *
 * Filename UUID == sessionId, but we cross-check the first line as a
 * defense against renamed/copied files.
 */
function readQwenSessionMeta(filePath: string): { sessionId: string; startTimeMs: number } | null {
  try {
    // Read up to ~4KB - one event line is well under that for a fresh session.
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.slice(0, bytesRead).toString('utf-8');
      const newlineIndex = text.indexOf('\n');
      const firstLine = newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
      if (!firstLine) return null;
      const parsed: unknown = JSON.parse(firstLine);
      if (!isRecord(parsed)) return null;
      const { sessionId, timestamp } = parsed;
      if (typeof sessionId !== 'string' || typeof timestamp !== 'string') return null;
      const startTimeMs = Date.parse(timestamp);
      if (!Number.isFinite(startTimeMs)) return null;
      return { sessionId, startTimeMs };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Module-level cache populated by `captureSessionIdFromFilesystem` and
 * consumed by `locate()`. Eliminates a redundant scan when the
 * session-manager pipeline calls capture -> locate in sequence.
 */
const discoveredSessionPaths = new Map<string, string>();

/** Exported for testing only - clears the module-level path cache. */
export function clearDiscoveredSessionPaths(): void {
  discoveredSessionPaths.clear();
}

/** Simple async sleep helper for polling loops. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
