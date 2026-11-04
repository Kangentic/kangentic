import { humanizeModelId } from '../../../../shared/model-id';

/**
 * Readers for the lines Aider writes to its chat history markdown and prints
 * to the terminal. Aider v0.86.1 source, `main` branch:
 *
 * - `aider/io.py`: the history opens each run with
 *   `# aider chat started at <YYYY-MM-DD HH:MM:SS>`. `user_input` writes every
 *   line of a prompt as `#### <line>`. `ai_output` writes the reply as plain
 *   text. `tool_output` writes EVERY message, `log_only` ones included, as a
 *   `> ` blockquote, with the `> ` on its first line only.
 * - `aider/main.py`: the command line is logged through `tool_output` with
 *   `log_only=True`, so it reaches the history as a `> ` line, and a multi-line
 *   `--message` spills unprefixed lines after it.
 * - `aider/coders/base_coder.py`: `show_announcements` prints
 *   `Model: <name> with <format> edit format` (`Main model:` when a separate
 *   weak model is set) through `tool_output`, so the model is in the history.
 *   `calculate_and_show_tokens_and_cost` prints
 *   `Tokens: <n> sent[, <n> cache write][, <n> cache hit], <n> received.` and
 *   `Cost: $<message> message, $<session> session.`, joined by a newline when
 *   both cache fields are present, else a space. `session` is that Aider
 *   process's running total, so it starts over in each run.
 *
 * Pure string functions, shared by the session-history parser, the transcript
 * parser and the answer run's usage reader.
 */

/** A run's opening header line. */
export const AIDER_SESSION_HEADER = /^# aider chat started at (.+?)\s*$/;

/** Token counts from one `Tokens:` report. */
export interface AiderTokenCounts {
  sent: number;
  received: number;
  cacheWrite: number;
  cacheHit: number;
}

/** One `Cost:` report: this message's price and the run's running total. */
export interface AiderCostReport {
  messageUsd: number;
  sessionUsd: number;
}

/** A history line with its blockquote prefix removed, or null when it has none. */
export function stripBlockquote(line: string): string | null {
  const match = /^>\s?(.*)$/.exec(line);
  return match ? match[1] : null;
}

const MODEL_ANNOUNCEMENT = /^(?:Main )?[Mm]odel: (\S.*?) with \S+ edit format\b/;

/** The model name in a `Model:` / `Main model:` announcement, or null. */
export function parseModelAnnouncement(text: string): string | null {
  const match = MODEL_ANNOUNCEMENT.exec(text.trim());
  return match ? match[1] : null;
}

/** One count in a `Tokens:` report, `<number>[k|M] <label>`, per label. */
const TOKEN_VALUE = {
  sent: /([0-9][0-9,.]*)\s*(k|M)?\s+sent/i,
  received: /([0-9][0-9,.]*)\s*(k|M)?\s+received/i,
  cacheWrite: /([0-9][0-9,.]*)\s*(k|M)?\s+cache write/i,
  cacheHit: /([0-9][0-9,.]*)\s*(k|M)?\s+cache hit/i,
} as const;

/**
 * The counts in a `Tokens:` report, or null when the text is not one or names
 * neither sent nor received tokens. Aider's `format_tokens` writes `1.2k` above
 * a thousand; `M` is read too.
 */
export function parseTokensReport(text: string): AiderTokenCounts | null {
  const match = /^Tokens:\s*(.+)$/.exec(text.trim());
  if (!match) return null;
  const counts: AiderTokenCounts = {
    sent: tokenValue(match[1], TOKEN_VALUE.sent),
    received: tokenValue(match[1], TOKEN_VALUE.received),
    cacheWrite: tokenValue(match[1], TOKEN_VALUE.cacheWrite),
    cacheHit: tokenValue(match[1], TOKEN_VALUE.cacheHit),
  };
  if (counts.sent === 0 && counts.received === 0) return null;
  return counts;
}

/** The `$<message> message, $<session> session` figures anywhere in `text`, or null. */
export function parseCostReport(text: string): AiderCostReport | null {
  const match = /Cost:\s*\$([0-9][0-9,.]*)\s+message,\s*\$([0-9][0-9,.]*)\s+session/.exec(text);
  if (!match) return null;
  const messageUsd = parseFloat(match[1].replace(/,/g, ''));
  const sessionUsd = parseFloat(match[2].replace(/,/g, ''));
  if (!Number.isFinite(messageUsd) || !Number.isFinite(sessionUsd)) return null;
  return { messageUsd, sessionUsd };
}

const BARE_COST_LINE = /^Cost: \$\S+ message, \$\S+ session\.?$/;

/**
 * Whether a line is the `Cost:` half of a `Tokens:` report printed on a line
 * of its own. Aider does that when the report carries both cache fields, and
 * `tool_output` quotes only the first line, so in the history this half has
 * no `> `. The line counts as the report's half only right after a `Tokens:`
 * line; callers check that. The match is the whole line, so a reply that only
 * mentions a cost is not taken for it.
 */
export function isBareCostLine(line: string): boolean {
  return BARE_COST_LINE.test(line.trim());
}

function tokenValue(report: string, pattern: RegExp): number {
  const match = pattern.exec(report);
  if (!match) return 0;
  const value = parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return 0;
  if (match[2] === 'k') return Math.round(value * 1000);
  if (match[2] === 'M') return Math.round(value * 1_000_000);
  return Math.round(value);
}

/** What a whole chat history file says about the conversation's usage. */
export interface AiderHistorySummary {
  /** The model the newest announcement named, or null when none is in the file. */
  model: string | null;
  /** The newest `Tokens:` report: the prompt the model was last sent. */
  lastTokens: AiderTokenCounts | null;
  /** Every `Tokens:` report added up. */
  totals: AiderTokenCounts;
  /** How many `Tokens:` reports were read. */
  reportCount: number;
  /**
   * Each run's last `session` cost added up, or null when no cost was reported.
   * Aider's `session` figure starts over in every run, and a restored
   * conversation is several runs in one file.
   */
  totalCostUsd: number | null;
}

/**
 * Read a chat history for its model, tokens and cost. Only blockquoted lines
 * count, so an assistant reply that happens to say "Tokens: ..." is not read
 * as a report. The one exception is the `Cost:` line Aider puts on its own line
 * after a `Tokens:` report that carries both cache fields: `tool_output`
 * prefixes only the first line, so that line arrives bare.
 */
export function summarizeAiderHistory(content: string): AiderHistorySummary {
  const summary: AiderHistorySummary = {
    model: null,
    lastTokens: null,
    totals: { sent: 0, received: 0, cacheWrite: 0, cacheHit: 0 },
    reportCount: 0,
    totalCostUsd: null,
  };
  let finishedRunsCost = 0;
  let currentRunCost: number | null = null;
  let anyCost = false;
  let previousWasTokensReport = false;

  const readCost = (text: string): void => {
    const cost = parseCostReport(text);
    if (!cost) return;
    currentRunCost = cost.sessionUsd;
    anyCost = true;
  };

  for (const line of content.split(/\r?\n/)) {
    if (AIDER_SESSION_HEADER.test(line)) {
      if (currentRunCost !== null) finishedRunsCost += currentRunCost;
      currentRunCost = null;
      previousWasTokensReport = false;
      continue;
    }

    const quoted = stripBlockquote(line);
    if (quoted === null) {
      // The one unquoted line read: a report's `Cost:` half on its own line.
      if (previousWasTokensReport && isBareCostLine(line)) readCost(line);
      previousWasTokensReport = false;
      continue;
    }

    const model = parseModelAnnouncement(quoted);
    if (model) summary.model = model;

    const tokens = parseTokensReport(quoted);
    if (tokens) {
      summary.lastTokens = tokens;
      summary.totals.sent += tokens.sent;
      summary.totals.received += tokens.received;
      summary.totals.cacheWrite += tokens.cacheWrite;
      summary.totals.cacheHit += tokens.cacheHit;
      summary.reportCount += 1;
    }
    // A `Tokens:` line whose `Cost:` half shares it is a complete report.
    previousWasTokensReport = tokens !== null && parseCostReport(quoted) === null;
    readCost(quoted);
  }
  if (currentRunCost !== null) finishedRunsCost += currentRunCost;
  summary.totalCostUsd = anyCost ? finishedRunsCost : null;
  return summary;
}

/**
 * A label for an Aider model name. Aider names models as LiteLLM does,
 * `<provider>/<model>` or a bare name, so the provider prefix is dropped. An
 * Anthropic id is humanized the way the rest of the app shows it
 * (`claude-sonnet-4-5` -> "Sonnet 4.5"); any other name is shown as written,
 * since humanizing reads `gpt-4o` as "Gpt 4o".
 */
export function aiderModelDisplayName(modelName: string): string {
  const withoutProvider = modelName.trim().split('/').pop() ?? modelName.trim();
  if (/^claude-/i.test(withoutProvider)) return humanizeModelId(withoutProvider) ?? withoutProvider;
  return withoutProvider || modelName;
}
