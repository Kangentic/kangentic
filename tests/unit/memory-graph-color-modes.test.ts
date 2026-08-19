/**
 * Which colour modes an index can express.
 *
 * The load-bearing case is the LAST one: outcome can have two values present and
 * still be a dead mode, because colour reads as a pattern and a pattern needs a
 * visible minority. Measured on the real 648-conversation corpus, the split is
 * 642 done / 6 active - a uniformly green map with six specks in it, which the
 * outcome FILTER finds in one click and the eye never finds at all.
 */

import { describe, it, expect } from 'vitest';
import {
  availableColorModes,
  MIN_MINORITY_OUTCOME_SHARE,
} from '../../src/renderer/components/memory/color-mode-availability';
import type { MemoryGraphNode } from '../../src/shared/types';

function node(overrides: Partial<MemoryGraphNode> = {}): MemoryGraphNode {
  return {
    docKey: 'conversation::doc',
    x: 0.5,
    y: 0.5,
    z: 0.5,
    chunkCount: 10,
    title: 'A conversation',
    sessionId: 'session',
    taskId: 'task',
    agent: 'Claude Code',
    model: 'Opus 5',
    effort: 'high',
    durationMs: 60_000,
    costUsd: 1,
    tokens: 1000,
    lastActivityMs: 1_700_000_000_000,
    outcome: 'done',
    clusters: { coarse: 0, balanced: 0, fine: 0 },
    ...overrides,
  } as MemoryGraphNode;
}

/** `count` nodes, the first `minority` of which are still open. */
function corpus(count: number, minority: number, overrides: Partial<MemoryGraphNode> = {}) {
  return Array.from({ length: count }, (_unused, index) =>
    node({ ...overrides, outcome: index < minority ? 'active' : 'done' }));
}

describe('colour mode availability', () => {
  it('always offers the two modes every conversation can answer', () => {
    const modes = availableColorModes(corpus(10, 5));
    expect(modes).toContain('cluster');
    expect(modes).toContain('recency');
    // Length comes from the chunks themselves, so it exists wherever a map does.
    expect(modes).toContain('size');
  });

  it('drops a metric mode nothing in the index records', () => {
    const noMetrics = corpus(10, 5, { durationMs: null, costUsd: null });
    const modes = availableColorModes(noMetrics);
    expect(modes).not.toContain('duration');
    expect(modes).not.toContain('cost');
    // And they come back as soon as ONE conversation has the metric: the mode is
    // then a real, if sparse, distinction rather than a flat field.
    const oneHasCost = [...noMetrics.slice(1), node({ costUsd: 4, durationMs: null })];
    expect(availableColorModes(oneHasCost)).toContain('cost');
    expect(availableColorModes(oneHasCost)).not.toContain('duration');
  });

  it('drops outcome when one value holds almost everything', () => {
    // The real corpus, to the node: 642 finished, 6 still open. Two values are
    // PRESENT, which is why a presence check would have kept this mode - and the
    // map is green with six specks in it.
    expect(availableColorModes(corpus(648, 6))).not.toContain('outcome');
  });

  it('keeps outcome when the minority is large enough to see', () => {
    const justEnough = Math.ceil(648 * MIN_MINORITY_OUTCOME_SHARE);
    expect(availableColorModes(corpus(648, justEnough))).toContain('outcome');
    expect(availableColorModes(corpus(648, justEnough - 1))).not.toContain('outcome');
  });

  it('drops outcome when every conversation shares one', () => {
    expect(availableColorModes(corpus(50, 0))).not.toContain('outcome');
  });

  it('has nothing to say about an empty index beyond the always-on modes', () => {
    expect(availableColorModes([])).toEqual(['cluster', 'recency', 'size']);
  });
});
