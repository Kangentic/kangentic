import type { PerToolStat } from './types';

/**
 * A tool-call count and its per-tool rows, summed over one or more session
 * records. Each record stores only its own run, so a total across runs is
 * always built at read time and never written back.
 */
export interface ToolCallTotals {
  toolCallCount: number;
  toolBreakdown: PerToolStat[];
}

/** The optional `PerToolStat` fields, each summed only when some row has it. */
const OPTIONAL_SUMMED_FIELDS = ['waitedCount', 'costUsd', 'inputTokens', 'outputTokens', 'resultTokens'] as const;

/**
 * Sum per-tool rows by tool name, across runs. The required counters always
 * add. An optional field is present on the merged row when any input row for
 * that tool carries it, and absent when none does, so a merge never invents a
 * zero the table would render as a measured value.
 *
 * Sorted by call count, most first, ties by tool name: the order
 * `UsageAccumulator.getToolBreakdown` returns and the table's default.
 */
export function mergeToolBreakdowns(groups: PerToolStat[][]): PerToolStat[] {
  const byTool = new Map<string, PerToolStat>();
  for (const rows of groups) {
    for (const row of rows) {
      const merged = byTool.get(row.toolName);
      if (!merged) {
        byTool.set(row.toolName, { ...row });
        continue;
      }
      merged.callCount += row.callCount;
      merged.interruptedCount += row.interruptedCount;
      merged.totalDurationMs += row.totalDurationMs;
      for (const field of OPTIONAL_SUMMED_FIELDS) {
        const value = row[field];
        if (value === undefined) continue;
        merged[field] = (merged[field] ?? 0) + value;
      }
    }
  }
  const mergedRows = Array.from(byTool.values());
  mergedRows.sort((left, right) => (right.callCount - left.callCount) || left.toolName.localeCompare(right.toolName));
  return mergedRows;
}

/**
 * Sum per-tool result-token estimates by tool name, across runs. Null only
 * when every input is null (no run could be read): an empty object is an
 * answer, a read that found no tool results yet, and keeps the sum non-null.
 * Built through a Map, so a tool named like an `Object.prototype` member is
 * an ordinary key.
 */
export function sumToolResultTokens(groups: Array<Record<string, number> | null>): Record<string, number> | null {
  if (groups.every((group) => group === null)) return null;
  const byTool = new Map<string, number>();
  for (const group of groups) {
    for (const [toolName, resultTokens] of Object.entries(group ?? {})) {
      byTool.set(toolName, (byTool.get(toolName) ?? 0) + resultTokens);
    }
  }
  return Object.fromEntries(byTool);
}
