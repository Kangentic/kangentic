/**
 * The Completed Tasks dialog draws "-" in every cell of an archived task with no summary, and a
 * footer of "$0.00 total cost, 0 tokens", which is what the web demo showed before the sample
 * install carried these. The seed writes one summary per entry in DEMO_ARCHIVED_SUMMARIES, so an
 * archived task added without one, or a summary left behind by a retired task, would bring the
 * dashes back quietly. This pins the two lists to each other.
 */
import { describe, it, expect } from 'vitest';
import { DEMO_ARCHIVED_SUMMARIES, DEMO_TASKS } from '../../tests/captures/helpers/demo-dataset';

describe('demo archived task summaries', () => {
  const archivedTaskIds = DEMO_TASKS.filter((task) => task.archivedDaysAgo).map((task) => task.id).sort();

  it('gives every archived task exactly one summary, and no other task any', () => {
    // Vacuity guard: the sample install archives tasks in all three projects.
    expect(archivedTaskIds.length).toBeGreaterThanOrEqual(3);
    expect(DEMO_ARCHIVED_SUMMARIES.map((summary) => summary.taskId).sort()).toEqual(archivedTaskIds);
  });

  it('fills every cell the dialog draws', () => {
    for (const summary of DEMO_ARCHIVED_SUMMARIES) {
      const toolCalls = Object.values(summary.tools).reduce((sum, calls) => sum + calls, 0);
      for (const [field, value] of Object.entries({
        costUsd: summary.costUsd, durationMinutes: summary.durationMinutes, inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens, toolCalls, filesChanged: summary.filesChanged, linesAdded: summary.linesAdded,
      })) {
        expect(value, `${summary.taskId}.${field} would draw "-"`).toBeGreaterThan(0);
      }
    }
  });
});
