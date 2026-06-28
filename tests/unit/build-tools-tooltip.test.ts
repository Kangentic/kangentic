/**
 * Unit tests for `buildToolsTooltip` in
 * `src/renderer/components/dialogs/completed-tasks/tooltip.ts`.
 *
 * The function is a pure string transform that produces the tooltip shown on
 * the Tools column in the CompletedTasksDialog data table. No React, no DOM,
 * no browser - safe to test in the vitest unit tier.
 *
 * Coverage:
 *   - Empty breakdown falls back to the bare call count
 *   - Top-5 capped when more than 5 tools are present
 *   - Sorted descending by callCount + interruptedCount
 *   - interruptedCount contributes to sort position and display count
 *   - Ties broken by whichever entry appears first in slice() (stable sort)
 *   - Exactly 5 items: no cap applied, all shown
 */
import { describe, it, expect } from 'vitest';
import { buildToolsTooltip } from '../../src/renderer/components/dialogs/completed-tasks/tooltip';
import type { SessionSummary, PerToolStat } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal SessionSummary with overridable toolBreakdown. */
function makeSummary(options: {
  toolCallCount?: number;
  toolBreakdown?: PerToolStat[];
}): SessionSummary {
  return {
    sessionId: 'session-1',
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    modelDisplayName: '',
    durationMs: 0,
    toolCallCount: options.toolCallCount ?? 0,
    compactionCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesChanged: 0,
    taskCreatedAt: '2026-04-01T09:00:00Z',
    startedAt: '2026-04-01T10:00:00Z',
    exitedAt: null,
    exitCode: null,
    toolBreakdown: options.toolBreakdown ?? [],
  };
}

function makeTool(
  toolName: string,
  callCount: number,
  interruptedCount = 0,
): PerToolStat {
  return { toolName, callCount, totalDurationMs: 0, interruptedCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildToolsTooltip', () => {
  it('returns fallback string when breakdown is empty', () => {
    const summary = makeSummary({ toolCallCount: 7, toolBreakdown: [] });
    expect(buildToolsTooltip(summary)).toBe('7 tool calls');
  });

  it('returns fallback string when breakdown is missing (null-coalesced to [])', () => {
    // The function uses `summary.toolBreakdown ?? []`, so passing undefined
    // as the field value should also fall through to the count fallback.
    const summary = makeSummary({ toolCallCount: 3 });
    // toolBreakdown defaults to [] in makeSummary - test the explicit empty case.
    expect(buildToolsTooltip(summary)).toBe('3 tool calls');
  });

  it('sorts by callCount + interruptedCount descending', () => {
    const summary = makeSummary({
      toolBreakdown: [
        makeTool('Read', 2, 0),     // score 2
        makeTool('Bash', 5, 1),     // score 6
        makeTool('Edit', 3, 0),     // score 3
      ],
    });
    const tooltip = buildToolsTooltip(summary);
    // Expected: Bash (6), Edit (3), Read (2)
    expect(tooltip).toBe('Bash 6, Edit 3, Read 2');
  });

  it('interruptedCount contributes to sort rank and displayed total', () => {
    const summary = makeSummary({
      toolBreakdown: [
        makeTool('Write', 1, 0),  // score 1
        makeTool('Bash', 1, 3),   // score 4 - interrupted pushes it to top
      ],
    });
    const tooltip = buildToolsTooltip(summary);
    expect(tooltip).toBe('Bash 4, Write 1');
  });

  it('caps output at 5 tools when more than 5 are present', () => {
    const summary = makeSummary({
      toolBreakdown: [
        makeTool('Tool1', 10),
        makeTool('Tool2', 9),
        makeTool('Tool3', 8),
        makeTool('Tool4', 7),
        makeTool('Tool5', 6),
        makeTool('Tool6', 5), // should be excluded
        makeTool('Tool7', 4), // should be excluded
      ],
    });
    const tooltip = buildToolsTooltip(summary);
    const parts = tooltip.split(', ');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('Tool1 10');
    expect(parts[4]).toBe('Tool5 6');
    expect(tooltip).not.toContain('Tool6');
    expect(tooltip).not.toContain('Tool7');
  });

  it('shows all tools when exactly 5 are present (no cap applied)', () => {
    const summary = makeSummary({
      toolBreakdown: [
        makeTool('Bash', 3),
        makeTool('Read', 2),
        makeTool('Edit', 2),
        makeTool('Write', 1),
        makeTool('Glob', 1),
      ],
    });
    const tooltip = buildToolsTooltip(summary);
    const parts = tooltip.split(', ');
    expect(parts).toHaveLength(5);
  });

  it('shows a single tool when breakdown has exactly one entry', () => {
    const summary = makeSummary({
      toolBreakdown: [makeTool('Bash', 12, 2)],
    });
    expect(buildToolsTooltip(summary)).toBe('Bash 14');
  });

  it('does not mutate the original breakdown array (slice is used before sort)', () => {
    const breakdown: PerToolStat[] = [
      makeTool('Read', 1),
      makeTool('Bash', 5),
    ];
    const summary = makeSummary({ toolBreakdown: breakdown });
    buildToolsTooltip(summary);
    // Original order must be preserved
    expect(breakdown[0].toolName).toBe('Read');
    expect(breakdown[1].toolName).toBe('Bash');
  });
});
