import {
  type SessionUsage,
  type SessionEvent,
  type StreamOutputParser,
} from '../../../../shared/types';

/**
 * Parses GitHub Copilot CLI's PTY output for runtime telemetry.
 *
 * Empirical context (captured 2026-04-15 against Copilot CLI v1.0.27 via a
 * real Windows ConPTY session):
 *
 * - The documented `statusLine` config in ~/.copilot/config.json does NOT
 *   fire reliably in interactive PTY sessions. A synthetic statusLine
 *   command that writes to a file never executed across multiple capture
 *   runs, so we cannot depend on it for the model pill.
 * - Copilot's TUI renders the model name in its own bottom status bar,
 *   e.g. `GPT-5 mini (medium)` or `Claude Sonnet 4.6`. The name appears
 *   between a path segment and either a closing bracket or the
 *   `Remaining reqs.: NN%` suffix, separated by ASCII spaces.
 * - Copilot's `--output-format json` non-interactive mode streams NDJSON
 *   with `session.tools_updated` (carries `model`) and a terminal `result`
 *   (carries `sessionId` + token usage). That flow is not currently used
 *   by Kangentic's interactive spawn but is handled here so we would also
 *   light up when called non-interactively.
 *
 * Strategy: try NDJSON parse first (cheap, deterministic). If nothing
 * parses as the known JSON events, fall back to a regex scan over the
 * ANSI-stripped text for a known Copilot model label. Only emit the model
 * once per session; ignore later chunks to avoid oscillation when the
 * user switches models mid-session (ContextBar will still catch
 * subsequent `session.tools_updated` JSONL events if the JSON stream
 * is active).
 */
export class CopilotStreamParser implements StreamOutputParser {
  /** Cap on the rolling partial-line buffer for NDJSON reassembly. */
  private static readonly MAX_CARRY = 8192;

  private carry = '';
  private modelEmitted = false;

  parseTelemetry(data: string): {
    usage?: Partial<SessionUsage>;
    events?: SessionEvent[];
  } | null {
    let usage: Partial<SessionUsage> | undefined;

    // First pass: NDJSON events (works when `--output-format json` is
    // active, which happens in scripted non-interactive spawns).
    const ndjsonUsage = this.parseNdjson(data);
    if (ndjsonUsage) {
      usage = { ...usage, ...ndjsonUsage };
      if (ndjsonUsage.model) this.modelEmitted = true;
    }

    // Second pass: regex scan over ANSI-stripped PTY text for a known
    // model label in Copilot's TUI status bar. Skip once we've already
    // emitted a model - further scans would churn the store with
    // identical updates.
    if (!this.modelEmitted) {
      const stripped = stripAnsiEscapes(data);
      const matchedModel = matchModelLabel(stripped);
      if (matchedModel) {
        usage = { ...usage, model: matchedModel };
        this.modelEmitted = true;
      }
    }

    if (!usage) return null;
    return { usage };
  }

  private parseNdjson(data: string): Partial<SessionUsage> | null {
    const combined = this.carry + data;
    const lines = combined.split(/\r?\n/);
    const tail = lines.pop() ?? '';
    this.carry = tail.length > CopilotStreamParser.MAX_CARRY
      ? tail.slice(tail.length - CopilotStreamParser.MAX_CARRY)
      : tail;

    let usage: Partial<SessionUsage> | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let entry: unknown;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (!isRecord(entry)) continue;
      const type = entry.type;

      // session.tools_updated carries `{ model: "gpt-5-mini" }` each time
      // the active model changes or is first assigned.
      if (type === 'session.tools_updated' && isRecord(entry.data)) {
        const modelId = entry.data.model;
        if (typeof modelId === 'string' && modelId.length > 0) {
          usage = { ...usage, model: { id: modelId, displayName: prettifyModelId(modelId) } };
        }
      }
      // session.model_change emitted when /model switches mid-session.
      else if (type === 'session.model_change' && isRecord(entry.data)) {
        const modelId = entry.data.newModel;
        if (typeof modelId === 'string' && modelId.length > 0) {
          usage = { ...usage, model: { id: modelId, displayName: prettifyModelId(modelId) } };
        }
      }
      // result is the terminal event in --output-format json. Carries
      // sessionId + total usage stats.
      else if (type === 'result') {
        const usageBlock = entry.usage;
        if (isRecord(usageBlock)) {
          const totalApiDurationMs = usageBlock.totalApiDurationMs;
          if (typeof totalApiDurationMs === 'number' && totalApiDurationMs > 0) {
            usage = {
              ...usage,
              cost: { totalCostUsd: 0, totalDurationMs: totalApiDurationMs },
            };
          }
        }
      }
    }

    return usage ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip common ANSI CSI / OSC / DCS sequences and cursor-position codes
 * so model-name regexes don't have to match through them. Keeps plain
 * text readable while discarding ESC-prefixed control sequences.
 */
function stripAnsiEscapes(data: string): string {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[?]?[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
}

/**
 * Known Copilot model labels mapped to (canonical id, prettified display).
 * Matched case-insensitively against ANSI-stripped PTY text. The id
 * values are the documented Copilot model ids from `copilot help config`,
 * so the regex and NDJSON paths produce identical `{ id, displayName }`
 * shapes for downstream consumers (analytics, model-switcher UI).
 *
 * Order matters: more-specific patterns must come before less-specific
 * ones (`Opus 4.6 Fast` before `Opus 4.6`, `GPT-5.4 mini` before
 * `GPT-5.4`) so the first match wins.
 */
const MODEL_PATTERNS: Array<{ id: string; displayName: string; regex: RegExp }> = [
  { id: 'claude-opus-4.6-fast', displayName: 'Claude Opus 4.6 Fast', regex: /Claude[- ]Opus[- ]4\.6[- ]Fast/i },
  { id: 'claude-opus-4.6', displayName: 'Claude Opus 4.6', regex: /Claude[- ]Opus[- ]4\.6(?!\s*[- ]Fast)/i },
  { id: 'claude-opus-4.5', displayName: 'Claude Opus 4.5', regex: /Claude[- ]Opus[- ]4\.5/i },
  { id: 'claude-sonnet-4.6', displayName: 'Claude Sonnet 4.6', regex: /Claude[- ]Sonnet[- ]4\.6/i },
  { id: 'claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5', regex: /Claude[- ]Sonnet[- ]4\.5/i },
  { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4', regex: /Claude[- ]Sonnet[- ]4(?!\.\d)/i },
  { id: 'claude-haiku-4.5', displayName: 'Claude Haiku 4.5', regex: /Claude[- ]Haiku[- ]4\.5/i },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', regex: /GPT[- ]5\.4[- ]mini/i },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', regex: /GPT[- ]5\.4(?!\s*[- ]mini)/i },
  { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', regex: /GPT[- ]5\.3[- ]codex/i },
  { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', regex: /GPT[- ]5\.2[- ]codex/i },
  { id: 'gpt-5.2', displayName: 'GPT-5.2', regex: /GPT[- ]5\.2(?!\s*[- ]codex)/i },
  { id: 'gpt-5.1', displayName: 'GPT-5.1', regex: /GPT[- ]5\.1/i },
  { id: 'gpt-5-mini', displayName: 'GPT-5 mini', regex: /GPT[- ]5[- ]mini/i },
  { id: 'gpt-4.1', displayName: 'GPT-4.1', regex: /GPT[- ]4\.1/i },
];

function matchModelLabel(text: string): { id: string; displayName: string } | null {
  for (const { id, displayName, regex } of MODEL_PATTERNS) {
    if (regex.test(text)) return { id, displayName };
  }
  return null;
}

/**
 * Convert a Copilot model id like `gpt-5-mini` into a friendlier display
 * form like `GPT-5 mini`. Unknown ids pass through untouched so we never
 * render an empty model pill.
 */
function prettifyModelId(id: string): string {
  const lowered = id.toLowerCase();
  if (lowered.startsWith('gpt-')) {
    const rest = id.slice(4);
    return `GPT-${rest.replace(/^(\d[^-]*)-/, '$1 ')}`;
  }
  if (lowered.startsWith('claude-')) {
    const rest = id.slice(7);
    return `Claude ${rest.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())}`;
  }
  return id;
}
