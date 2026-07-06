import type { TranscriptEntry, TranscriptBlock } from './types';
import { sanitizeTranscriptText } from './ansi-strip';

/**
 * Which slice of the conversation a structured transcript request wants.
 * Mirrors the Claude Agent SDK message vocabulary: `responses` are the
 * assistant text turns; `result` is the final assistant text of the session
 * (the SDK's `ResultMessage.result`). `full` is the whole conversation.
 */
export type TranscriptView = 'full' | 'responses' | 'result';

/**
 * Default character budget for a rendered structured transcript. A long
 * session would otherwise blow up the consuming agent's context, so output is
 * trimmed to the most recent entries that fit, with an explicit truncation
 * note. Roughly 12k tokens. Callers can raise it up to TRANSCRIPT_CHAR_BUDGET_MAX.
 */
export const TRANSCRIPT_CHAR_BUDGET = 50_000;

/** Hard ceiling for a caller-supplied char budget (the `maxChars` override). */
export const TRANSCRIPT_CHAR_BUDGET_MAX = 500_000;

/** Hard ceiling for the `tail` entry count, mirroring get_session_events. */
export const TRANSCRIPT_TAIL_MAX = 2000;

/**
 * Format a parsed transcript as a markdown document suitable for pasting
 * into issues, PRs, chat, or for handing off as cross-agent context. Tool
 * results are inlined under their owning tool_use block by id; any tool
 * result whose owning tool_use is not present (orphaned, e.g. after a resume
 * or compaction) is surfaced in a trailing section instead of being dropped.
 *
 * All rendered content is run through `sanitizeTranscriptText` so terminal
 * escape sequences or stray control bytes captured inside tool output never
 * leak into the markdown.
 *
 * Lives in `shared/` because both the renderer (Transcript tab copy button)
 * and the main process (MCP `get_transcript` structured format) call it.
 */
export function transcriptToMarkdown(entries: TranscriptEntry[]): string {
  const resultsByUseId = buildResultsByUseId(entries);

  // Track which tool_use ids actually appear in an assistant turn so we can
  // detect tool_result entries with no owner and render them rather than
  // silently dropping them.
  const renderedUseIds = new Set<string>();

  const sections: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'tool_result') continue;
    if (entry.kind === 'system') {
      sections.push(renderSystemEntry(entry.subtype, entry.text));
      continue;
    }
    if (entry.kind === 'user') {
      sections.push(`## User\n\n${sanitizeTranscriptText(entry.text).trim()}`);
      continue;
    }
    // assistant
    for (const block of entry.blocks) {
      if (block.type === 'tool_use') renderedUseIds.add(block.id);
    }
    const heading = entry.model ? `## Assistant (${entry.model})` : '## Assistant';
    sections.push(`${heading}\n\n${renderAssistantBlocksMarkdown(entry.blocks, resultsByUseId)}`);
  }

  // Surface orphaned tool results (a tool_use id never emitted in this file)
  // in a trailing section so the content is visible instead of dropped.
  const orphans = entries.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: 'tool_result' }> =>
      entry.kind === 'tool_result' && (!entry.toolUseId || !renderedUseIds.has(entry.toolUseId)),
  );
  if (orphans.length > 0) {
    const orphanParts: string[] = ['## Orphaned tool results', ''];
    for (const orphan of orphans) {
      const label = orphan.toolUseId ? `\`${orphan.toolUseId}\`` : '(unknown tool)';
      orphanParts.push(orphan.isError ? `**Error for ${label}:**` : `**Result for ${label}:**`);
      orphanParts.push('');
      orphanParts.push('```');
      orphanParts.push(sanitizeTranscriptText(orphan.content));
      orphanParts.push('```');
      orphanParts.push('');
    }
    sections.push(orphanParts.join('\n').trimEnd());
  }

  return sections.join('\n\n').trim() + '\n';
}

/**
 * Reduce a parsed transcript to a `view`:
 *
 * - `full`: the entries unchanged.
 * - `responses`: only assistant turns, each reduced to its `text` blocks
 *   (tool_use / thinking dropped); assistant turns with no text are dropped.
 * - `result`: the single last assistant turn that has text, reduced to its
 *   text blocks (the SDK's `ResultMessage.result`). Walks backward past a
 *   trailing tool-call-only turn. Returns `[]` when there is no assistant text.
 *
 * Operates purely on the agent-agnostic `TranscriptEntry[]`, so no adapter
 * branching is introduced (agent-adapters-boundary).
 */
export function filterTranscriptView(entries: TranscriptEntry[], view: TranscriptView): TranscriptEntry[] {
  if (view === 'full') return entries;

  if (view === 'responses') {
    return entries.flatMap((entry) => {
      if (entry.kind !== 'assistant') return [];
      const textBlocks = entry.blocks.filter((block) => block.type === 'text');
      if (textBlocks.length === 0) return [];
      return [{ ...entry, blocks: textBlocks }];
    });
  }

  // view === 'result'
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.kind !== 'assistant') continue;
    const textBlocks = entry.blocks.filter((block) => block.type === 'text');
    if (textBlocks.length > 0) return [{ ...entry, blocks: textBlocks }];
  }
  return [];
}

/**
 * Keep only the entries whose content contains `term` (case-insensitive
 * substring). An assistant turn matches on any block text, a tool name, its
 * JSON input, or the content of a tool result inlined under it; user and
 * system entries match on their text; a standalone tool_result matches on its
 * content (so orphans are findable). For every kept assistant turn the paired
 * tool_result entries are also kept, so `transcriptToMarkdown` can still inline
 * the result under its owning tool call.
 */
export function searchTranscript(entries: TranscriptEntry[], term: string): TranscriptEntry[] {
  const needle = term.toLowerCase();
  if (!needle) return entries;
  const resultsByUseId = buildResultsByUseId(entries);

  const matches = entries.map((entry) => entryMatchesSearch(entry, needle, resultsByUseId));

  // tool_use ids referenced by a matching assistant turn, so we can keep the
  // matching turn's results even when the result text itself did not match.
  const keepResultIds = new Set<string>();
  entries.forEach((entry, index) => {
    if (!matches[index] || entry.kind !== 'assistant') return;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use') keepResultIds.add(block.id);
    }
  });

  return entries.filter((entry, index) => {
    if (matches[index]) return true;
    return entry.kind === 'tool_result' && !!entry.toolUseId && keepResultIds.has(entry.toolUseId);
  });
}

/**
 * Return a window of `context` entries either side of the entry with `uuid` (the
 * turn-anchored fetch behind the citation-first MCP recall flow: recall cites a
 * turnUuid, get_transcript fetches just that neighborhood). When the uuid is not
 * found, returns all entries unchanged so the caller can fall back with a note.
 */
export function sliceTranscriptAroundUuid(
  entries: TranscriptEntry[],
  uuid: string,
  context: number,
): TranscriptEntry[] {
  const index = entries.findIndex((entry) => entry.uuid === uuid);
  if (index < 0) return entries;
  const radius = Math.max(0, context);
  const start = Math.max(0, index - radius);
  const end = Math.min(entries.length, index + radius + 1);
  return entries.slice(start, end);
}

/** Result of rendering a transcript under an entry/char budget. */
export interface BudgetedTranscript {
  markdown: string;
  /** Entries handed in (after any view / search filtering, before tail / budget). */
  totalEntries: number;
  /** Entries actually rendered. */
  renderedEntries: number;
  omittedByTail: number;
  omittedByBudget: number;
  truncated: boolean;
}

/**
 * Render a transcript to markdown bounded by a tail entry count and a character
 * budget. Trimming keeps the most recent entries (consistent with
 * get_session_events). At least the newest entry is always kept, even if it
 * alone exceeds the budget, so "the final answer" is never empty when one
 * exists. A defensive hard-truncate backstops estimate drift.
 */
export function renderTranscriptBudgeted(
  entries: TranscriptEntry[],
  options: { tail?: number; charBudget?: number } = {},
): BudgetedTranscript {
  const charBudget = options.charBudget ?? TRANSCRIPT_CHAR_BUDGET;
  const totalEntries = entries.length;

  const tail = options.tail;
  const tailed = typeof tail === 'number' && tail > 0 ? entries.slice(-tail) : entries;
  const omittedByTail = totalEntries - tailed.length;

  // Budget walk, newest entry first. Always keep at least the newest entry.
  const resultsByUseId = buildResultsByUseId(tailed);
  let runningCost = 0;
  let keepFrom = tailed.length;
  for (let index = tailed.length - 1; index >= 0; index--) {
    const cost = estimateEntryCost(tailed[index], resultsByUseId);
    const isNewest = index === tailed.length - 1;
    if (!isNewest && runningCost + cost > charBudget) break;
    runningCost += cost;
    keepFrom = index;
  }
  let kept = tailed.slice(keepFrom);

  // A tool_result whose owning assistant turn was truncated away would otherwise
  // resurface as an "Orphaned tool results" section. Drop those (but keep
  // genuine orphans, whose owner was never present in this window).
  kept = dropTruncationOrphans(kept, tailed);

  // Count omissions after orphan-dropping so the reported counts balance:
  // renderedEntries + omittedByTail + omittedByBudget === totalEntries. (A
  // dropped truncation orphan is an entry the budget removed indirectly.)
  const omittedByBudget = tailed.length - kept.length;

  let markdown = transcriptToMarkdown(kept);
  let truncated = omittedByTail > 0 || omittedByBudget > 0;
  if (markdown.length > charBudget) {
    markdown = hardTruncateToBudget(markdown, charBudget);
    truncated = true;
  }

  return {
    markdown,
    totalEntries,
    renderedEntries: kept.length,
    omittedByTail,
    omittedByBudget,
    truncated,
  };
}

/** Render a `kind: 'system'` transcript entry as a markdown section. */
function renderSystemEntry(
  subtype: 'compaction' | 'command' | 'command_output' | 'session_boundary',
  text: string,
): string {
  const clean = sanitizeTranscriptText(text).trim();
  if (subtype === 'compaction') {
    return `## Conversation compacted\n\n${clean}`;
  }
  if (subtype === 'command') {
    return `\`[command: ${clean}]\``;
  }
  if (subtype === 'session_boundary') {
    // Already a ready-to-display label (e.g. "New session - Claude Code
    // (isolated: Executing)"), unlike the other subtypes whose text is raw
    // payload behind a canned label.
    return `## ${clean}`;
  }
  // command_output
  return `**Command output:**\n\n\`\`\`\n${clean}\n\`\`\``;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Render one tool call (its name, input, and paired result if any) as a
 * markdown block: a fenced JSON input under a `**Tool:**` label, and a
 * fenced result/error section beneath it. Used by `renderAssistantBlocksMarkdown`
 * per tool_use block, so a copied message stays human-readable rather than a
 * raw JSON dump.
 */
export function renderToolCallMarkdown(
  name: string,
  input: unknown,
  result: { content: string; isError: boolean } | null,
): string {
  const parts: string[] = [];
  parts.push(`**Tool:** \`${name}\``);
  parts.push('');
  parts.push('```json');
  parts.push(safeJson(input));
  parts.push('```');
  if (result) {
    parts.push('');
    parts.push(result.isError ? '**Error:**' : '**Result:**');
    parts.push('');
    parts.push('```');
    parts.push(sanitizeTranscriptText(result.content));
    parts.push('```');
  }
  return parts.join('\n');
}

/**
 * Render an assistant turn's blocks (text, thinking, tool calls) as one
 * markdown string, matching what `transcriptToMarkdown` renders per turn (minus
 * the `## Assistant` document heading). The single source of truth for a
 * message's "copy" button, so a tool-calling turn copies its tool calls and
 * results too, not just its prose text - a turn made entirely of tool calls
 * would otherwise have nothing to copy at all.
 */
export function renderAssistantBlocksMarkdown(
  blocks: TranscriptBlock[],
  resultsByUseId: Map<string, { content: string; isError: boolean }>,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(sanitizeTranscriptText(block.text).trim());
      parts.push('');
    } else if (block.type === 'thinking') {
      parts.push('> _thinking_');
      parts.push('');
      parts.push(`> ${sanitizeTranscriptText(block.text).trim().split('\n').join('\n> ')}`);
      parts.push('');
    } else if (block.type === 'tool_use') {
      parts.push(renderToolCallMarkdown(block.name, block.input, resultsByUseId.get(block.id) ?? null));
      parts.push('');
    }
  }
  return parts.join('\n').trimEnd();
}

/** Map a tool_use id to its tool_result content, the way the renderer inlines it. */
export function buildResultsByUseId(entries: TranscriptEntry[]): Map<string, { content: string; isError: boolean }> {
  const resultsByUseId = new Map<string, { content: string; isError: boolean }>();
  for (const entry of entries) {
    if (entry.kind === 'tool_result' && entry.toolUseId) {
      resultsByUseId.set(entry.toolUseId, { content: entry.content, isError: !!entry.isError });
    }
  }
  return resultsByUseId;
}

/** True when `needle` (already lower-cased) appears anywhere in the entry's content. */
function entryMatchesSearch(
  entry: TranscriptEntry,
  needle: string,
  resultsByUseId: Map<string, { content: string; isError: boolean }>,
): boolean {
  if (entry.kind === 'user' || entry.kind === 'system') {
    return entry.text.toLowerCase().includes(needle);
  }
  if (entry.kind === 'tool_result') {
    return entry.content.toLowerCase().includes(needle);
  }
  // assistant
  for (const block of entry.blocks) {
    if (block.type === 'text' || block.type === 'thinking') {
      if (block.text.toLowerCase().includes(needle)) return true;
    } else if (block.type === 'tool_use') {
      if (block.name.toLowerCase().includes(needle)) return true;
      if (safeJson(block.input).toLowerCase().includes(needle)) return true;
      const result = resultsByUseId.get(block.id);
      if (result && result.content.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

// Rough per-entry / per-block markdown scaffolding (headers, fences, blank
// lines) so the char-budget estimate does not systematically under-count.
const SCAFFOLD_PER_ENTRY = 20;
const SCAFFOLD_PER_BLOCK = 40;

/**
 * Estimate the rendered char cost of one entry, mirroring `transcriptToMarkdown`.
 * tool_result entries cost 0: they are inlined under (and charged to) their
 * owning assistant turn. Genuine-orphan under-counting is covered by the
 * hard-truncate backstop.
 */
function estimateEntryCost(
  entry: TranscriptEntry,
  resultsByUseId: Map<string, { content: string; isError: boolean }>,
): number {
  if (entry.kind === 'user' || entry.kind === 'system') {
    return entry.text.length + SCAFFOLD_PER_ENTRY;
  }
  if (entry.kind === 'tool_result') {
    return 0;
  }
  let cost = SCAFFOLD_PER_ENTRY;
  for (const block of entry.blocks) {
    cost += SCAFFOLD_PER_BLOCK;
    if (block.type === 'text' || block.type === 'thinking') {
      cost += block.text.length;
    } else if (block.type === 'tool_use') {
      cost += block.name.length + safeJson(block.input).length;
      const result = resultsByUseId.get(block.id);
      if (result) cost += result.content.length;
    }
  }
  return cost;
}

/** Collect every tool_use id produced by an assistant turn in `entries`. */
function collectToolUseIds(entries: TranscriptEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'assistant') continue;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use') ids.add(block.id);
    }
  }
  return ids;
}

/**
 * Drop tool_result entries whose owning tool_use was present in the pre-trim
 * window but truncated away (a truncation orphan). Genuine orphans (owner never
 * present in the window) are kept so `transcriptToMarkdown` still surfaces them.
 */
function dropTruncationOrphans(kept: TranscriptEntry[], window: TranscriptEntry[]): TranscriptEntry[] {
  const keptUseIds = collectToolUseIds(kept);
  const windowUseIds = collectToolUseIds(window);
  return kept.filter((entry) => {
    if (entry.kind !== 'tool_result' || !entry.toolUseId) return true;
    const ownerWasInWindow = windowUseIds.has(entry.toolUseId);
    const ownerStillKept = keptUseIds.has(entry.toolUseId);
    return !(ownerWasInWindow && !ownerStillKept);
  });
}

/**
 * Defensive backstop when the rendered markdown still exceeds the budget (one
 * oversized entry, or estimate drift). Keeps the most recent `budget` chars,
 * starting at a section boundary so the output never begins mid-fence.
 */
function hardTruncateToBudget(markdown: string, budget: number): string {
  if (markdown.length <= budget) return markdown;
  const tailSlice = markdown.slice(markdown.length - budget);
  const firstBreak = tailSlice.indexOf('\n\n');
  const body = firstBreak >= 0 && firstBreak < budget / 2 ? tailSlice.slice(firstBreak + 2) : tailSlice;
  return `[...earlier output hard-truncated at the size cap...]\n\n${body.trimStart()}`;
}
