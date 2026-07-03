import fs from 'node:fs';
import type { SessionHistoryParseResult, SessionUsage } from '../../../../shared/types';
import { locateClaudeTranscriptFile } from './transcript-parser';
import { humanizeClaudeModelId } from './model-display-name';

/**
 * Live-telemetry fallback parser for Claude Code's native session JSONL
 * (`~/.claude/projects/<slug>/<sessionId>.jsonl`).
 *
 * Claude's authoritative telemetry comes from the hook-driven statusFile
 * pipeline (status.json), but Claude Code only runs the statusLine command
 * when its TUI actually paints the statusline. A background (never-opened)
 * session in Kangentic's pwsh-wrapped PTY never does that initial paint, so
 * status.json is never written and the board card stays on the spawn-time
 * model placeholder at 0% forever. Claude appends the transcript JSONL
 * continuously regardless of painting, so this parser tails it to derive a
 * live model + context % until status.json starts flowing. On the first
 * status.json parse, SessionManager detaches the transcript watcher and
 * status.json (richer: Claude's own used_percentage, cost, rate limits)
 * takes over via a full usage replace.
 *
 * Wired through the generic `runtime.sessionHistory` hook, the same pipeline
 * Codex and Gemini use. Emits a SPARSE SessionUsage (only the fields it can
 * derive) so the shallow spread merge in UsageAccumulator.setSessionUsage
 * never clobbers base values (cost, rate limits) with zeros. Never sets
 * activity or events - Claude's activity stays owned by the hooks pipeline.
 *
 * File format: append-only JSONL, one JSON object per line. Fields depended
 * on (per assistant entry): `type` (=== 'assistant'), `isSidechain`,
 * `message.model`, and `message.usage.{input_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`.
 *
 * Cross-platform: os.homedir() + path.join via locateClaudeTranscriptFile;
 * CRLF-tolerant line splitting; no shell-outs.
 */
export class ClaudeSessionHistoryParser {
  /**
   * Locate the transcript JSONL for a known Claude session UUID. The path is
   * deterministic (locateClaudeTranscriptFile reproduces the shipped CLI's
   * slug algorithm), so this only polls for the file to APPEAR rather than
   * scanning a directory.
   *
   * The budget is ~60s, far longer than Codex/Gemini's ~5s, because those
   * adapters locate AFTER capturing the session id from a running CLI,
   * whereas Claude's session id is caller-owned so the reader attaches at
   * spawn time - before the CLI has booted and persisted its first prompt
   * entry. A resumed session's file already exists and returns on attempt 1.
   * Returns null on give-up (the card degrades to the spawn-time model seed;
   * nothing re-attaches, hence the generous budget). Must confirm existence:
   * SessionHistoryReader treats ENOENT on its initial read as "file
   * disappeared" and permanently detaches.
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    const filePath = locateClaudeTranscriptFile(options.agentSessionId, options.cwd);
    const maxAttempts = 120; // 120 x 500ms = ~60s
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (fs.existsSync(filePath)) return filePath;
      await sleep(500);
    }
    return null;
  }

  /**
   * Parse newly-appended JSONL content (append mode, isFullRewrite === false)
   * into a sparse usage snapshot representing the current context occupancy.
   *
   * Keeps the LAST qualifying assistant entry in the chunk (latest-wins): its
   * per-message `usage` is the size of the prompt sent to the model on the
   * most recent turn, i.e. the current context occupancy. No message.id dedupe
   * is needed - lines sharing an id carry identical usage, so last-wins is
   * equivalent. No compaction special-casing is needed either: `compact_boundary`
   * is a `system` entry we skip, and the first post-compaction assistant entry
   * naturally carries the shrunken context, so the percentage drops on its own.
   *
   * Deliberately different from `parseClaudeTranscriptUsage` (transcript-parser.ts),
   * which SUMS deduped per-message usage into a CUMULATIVE lifetime total. The
   * cumulative sum over-reports current context, so it is wrong for a live %.
   */
  static parse(content: string, _mode: 'full' | 'append'): SessionHistoryParseResult {
    let latest: { input: number; cacheTokens: number; output: number; model: string } | null = null;

    // CRLF-tolerant split. Drops empty lines (a trailing \n produces one).
    for (const line of content.split(/\r?\n/)) {
      if (line.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        // Malformed line (partial write mid-flush) - skip.
        continue;
      }
      if (!isRecord(raw)) continue;
      if (raw.type !== 'assistant') continue;
      // Subagent turns carry the subagent's context, not the main thread's.
      if (raw.isSidechain === true) continue;

      const message = raw.message;
      if (!isRecord(message)) continue;
      const model = message.model;
      // Claude writes synthetic assistant entries for API-error notices; their
      // usage is not real context occupancy.
      if (typeof model !== 'string' || model.length === 0 || model === '<synthetic>') continue;

      const usage = message.usage;
      if (!isRecord(usage)) continue;

      const cacheTokens =
        numberOrZero(usage.cache_creation_input_tokens) +
        numberOrZero(usage.cache_read_input_tokens);
      const inputSide = numberOrZero(usage.input_tokens) + cacheTokens;
      // Skip entries with no input side - they carry no context signal.
      if (inputSide <= 0) continue;

      latest = {
        input: inputSide,
        cacheTokens,
        output: numberOrZero(usage.output_tokens),
        model,
      };
    }

    if (!latest) {
      // No qualifying entry in this chunk - leave the merged usage untouched.
      return { usage: null, events: [], activity: null };
    }

    const contextWindowSize = resolveClaudeContextWindowSize(latest.model);
    // Precompute usedPercentage when the window is known to avoid a 0% flash
    // (UsageAccumulator.setSessionUsage recomputes it after merge anyway).
    // Mirror the Codex/Gemini `as unknown as SessionUsage` sparse-usage cast:
    // omit cost, rateLimits, effort, sessionId, transcriptPath entirely so the
    // shallow spread merge never overwrites those base fields with defaults.
    const sparseUsage = {
      contextWindow: {
        usedPercentage:
          contextWindowSize !== null && contextWindowSize > 0
            ? (latest.input / contextWindowSize) * 100
            : 0,
        usedTokens: latest.input,
        cacheTokens: latest.cacheTokens,
        totalInputTokens: latest.input,
        totalOutputTokens: latest.output,
        // 0 is the "unknown size" sentinel - TaskCard hides the progress bar
        // and shows the model name only, rather than a bar against a guess.
        contextWindowSize: contextWindowSize ?? 0,
      },
      model: {
        id: latest.model,
        displayName: humanizeClaudeModelId(latest.model) ?? latest.model,
      },
    };

    return { usage: sparseUsage as unknown as SessionUsage, events: [], activity: null };
  }
}

// ---------- Internal helpers ----------

/** Type guard for a plain JSON object (not null, not array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite number or 0 (for tolerant transcript `usage` field reads). */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Simple async sleep helper for the locate polling loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Set of model ids we've already warned about, so the WARN log fires at most
 * once per unique unknown model per process lifetime.
 */
const unknownModelWarningsLogged = new Set<string>();

/**
 * Look up the context-window size Claude Code uses for a given model id.
 *
 * IMPORTANT: this is Claude Code's EFFECTIVE window, not the model's API
 * maximum. Claude Code uses a 200K context window for standard sessions and
 * 1M only for the 1M-context beta (the `[1m]` model variant). Even though
 * Opus 4.8 / Sonnet 5 / Fable 5 have a 1M API context window, a standard
 * Kangentic-spawned Claude session reports `context_window_size: 200000` in
 * status.json. Matching that here means the transcript fallback's percentage
 * lines up with what status.json reports later, so the handoff produces no
 * jump. Verified against real status.json fixtures
 * (tests/unit/claude-status-parser.test.ts): `claude-opus-4-7` -> 200000,
 * `claude-opus-4-7[1m]` -> 1000000.
 *
 * Returns null for unrecognized model families so the caller degrades to the
 * 0-sentinel (model name, no bar) rather than rendering a bar against a guess.
 * Matches by the name segment (opus/sonnet/haiku/fable/mythos) so new versions
 * and dated snapshots (e.g. `claude-opus-4-8-20260115`) still resolve.
 */
export function resolveClaudeContextWindowSize(modelId: string): number | null {
  const lower = modelId.toLowerCase();
  // 1M-context beta variant, marked by a bracketed [1m] suffix on the id.
  if (/\[1m\]/.test(lower)) return 1_000_000;
  // Standard tier: 200K for every recognized Claude model family.
  if (
    lower.includes('opus') ||
    lower.includes('sonnet') ||
    lower.includes('haiku') ||
    lower.includes('fable') ||
    lower.includes('mythos')
  ) {
    return 200_000;
  }
  // Unknown model family: warn once and return null so the caller can
  // gracefully degrade. Do not guess - a bar against a guessed limit would
  // give false precision, and status.json will supply the real size once it
  // flows.
  if (!unknownModelWarningsLogged.has(lower)) {
    unknownModelWarningsLogged.add(lower);
    console.warn(
      `[claude-session-history] unknown model "${modelId}" - context window size not in lookup table. `
      + `Card will show the model name without a progress bar until status.json flows. Update `
      + `resolveClaudeContextWindowSize() in src/main/agent/adapters/claude/session-history-parser.ts.`,
    );
  }
  return null;
}
