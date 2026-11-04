import fs from 'node:fs';
import type {
  SessionHistoryParseResult,
  SessionUsage,
  SessionUsagePatch,
} from '../../../../shared/types';
import { aiderHistoryPath } from './history-paths';
import { aiderModelDisplayName, summarizeAiderHistory } from './chat-history-markdown';

/**
 * Live usage for an Aider session, read from its chat history markdown.
 *
 * Path: `<cwd>/.aider.chat.history.<agentSessionId>.md`, the file Kangentic
 * names with `--chat-history-file` (see `history-paths.ts`), or Aider's default
 * `<cwd>/.aider.chat.history.md` for a session with no id.
 *
 * The file's shape is in `chat-history-markdown.ts`. It carries three things a
 * usage card needs, all as `> ` blockquotes Aider's `tool_output` writes:
 * - the model, from the startup announcement (`> Model: <name> with <format>
 *   edit format`, or `> Main model: ...`), repeated after an in-chat `/model`;
 * - the tokens of every message (`> Tokens: 1.2k sent, 500 received.`);
 * - the cost (`Cost: $0.01 message, $0.05 session.`), whose `session` figure
 *   starts over in each Aider run.
 *
 * No context window size is reported: Aider serves hundreds of models, and a
 * per-model table is exactly what `.claude/rules/cli-features-over-custom-layers.md`
 * forbids, so the card shows the "unknown size" sentinel.
 */
export class AiderSessionHistoryParser {
  /**
   * The session's history file, when it exists. One file per Kangentic
   * session (or per directory, for a session with no id).
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    const filePath = aiderHistoryPath(options.cwd, options.agentSessionId);
    try {
      return fs.existsSync(filePath) ? filePath : null;
    } catch {
      return null;
    }
  }

  /**
   * Parse the whole history (`isFullRewrite`) into a usage patch:
   * - `usedTokens` is the newest message's `sent` count, the prompt the model
   *   last saw; the input and output totals add up every message.
   * - The cost adds up each run's last `session` figure.
   * - The model is included only when the file names one, marked as reported
   *   by the agent. Leaving it out otherwise matters: the usage merge would
   *   replace a model seeded from `--model` with an empty one.
   */
  static parse(content: string, _mode: 'full' | 'append'): SessionHistoryParseResult {
    if (!content.trim()) {
      return { usage: null, events: [], activity: null };
    }

    const summary = summarizeAiderHistory(content);
    if (summary.reportCount === 0 && summary.totalCostUsd === null && summary.model === null) {
      return { usage: null, events: [], activity: null };
    }

    const patch: SessionUsagePatch = {};
    if (summary.reportCount > 0 || summary.totalCostUsd !== null) {
      const lastTokens = summary.lastTokens;
      patch.contextWindow = {
        usedPercentage: 0,
        usedTokens: lastTokens?.sent ?? 0,
        cacheTokens: (lastTokens?.cacheWrite ?? 0) + (lastTokens?.cacheHit ?? 0),
        totalInputTokens: summary.totals.sent,
        totalOutputTokens: summary.totals.received,
        // 0 = "unknown size" sentinel: the card shows no progress bar.
        contextWindowSize: 0,
      };
      patch.cost = {
        totalCostUsd: summary.totalCostUsd ?? 0,
        totalDurationMs: 0,
      };
    }
    if (summary.model) {
      patch.model = { id: summary.model, displayName: aiderModelDisplayName(summary.model), reportedByAgent: true };
    }

    // A sparse patch, as the other adapters' parsers return: the usage merge
    // keeps every field the patch leaves out.
    return { usage: patch as SessionUsage, events: [], activity: null };
  }
}
