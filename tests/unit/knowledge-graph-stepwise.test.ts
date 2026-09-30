/**
 * The projection pass runs its long steps (the layout, the region-count sweep)
 * in slices so no single step holds main for more than about a frame. Before,
 * those steps ran back to back and held it for 602 ms on 1,005 conversations.
 *
 * Slicing is only safe if it changes nothing about the result: the map is
 * cached, and a layout that came out differently when sliced would rearrange
 * the user's map on the next rebuild. So each stepwise form is pinned to give
 * exactly what its one-go form gives, however it is sliced.
 */

import { describe, it, expect } from 'vitest';
import { runInSlices, runToCompletion, type Stepwise } from '../../src/main/retrieval/graph/stepwise';
import { embedNeighborGraph, embedNeighborGraphSteps } from '../../src/main/retrieval/graph/projection-math';
import { chooseClusterCount, chooseClusterCountSteps, REGION_SIZE_BANDS } from '../../src/main/retrieval/graph/cluster-labels';
import { computeCosineNeighbors } from '../../src/main/retrieval/graph/neighbor-edges';

/** Deterministic points in groups, so the layout and the sweep have real work. */
function groupedPoints(rowCount: number, dimensions: number): Float32Array {
  const matrix = new Float32Array(rowCount * dimensions);
  for (let row = 0; row < rowCount; row += 1) {
    const group = row % 6;
    let squaredNorm = 0;
    for (let index = 0; index < dimensions; index += 1) {
      const value = (index % 6 === group ? 1 : 0) + Math.sin(row * 7.1 + index * 1.3) * 0.2;
      matrix[row * dimensions + index] = value;
      squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm) || 1;
    for (let index = 0; index < dimensions; index += 1) matrix[row * dimensions + index] /= norm;
  }
  return matrix;
}

/** A stepwise count to three, recording each step. */
function* countSteps(steps: number[]): Stepwise<string> {
  for (let step = 1; step <= 3; step += 1) {
    steps.push(step);
    yield;
  }
  return 'done';
}

const never = (): boolean => false;

describe('stepwise runs', () => {
  it('runs every step to the result in one go', () => {
    const steps: number[] = [];
    expect(runToCompletion(countSteps(steps))).toBe('done');
    expect(steps).toEqual([1, 2, 3]);
  });

  it('pauses between slices when a slice runs out of time, and still reaches the result', async () => {
    const steps: number[] = [];
    let pauses = 0;
    // A zero budget ends the slice after every step.
    const result = await runInSlices(countSteps(steps), 0, async () => { pauses += 1; }, never);
    expect(result).toBe('done');
    expect(steps).toEqual([1, 2, 3]);
    expect(pauses).toBe(3);
  });

  it('stops between slices once aborted', async () => {
    const steps: number[] = [];
    let aborted = false;
    const result = await runInSlices(countSteps(steps), 0, async () => { aborted = true; }, () => aborted);
    expect(result).toBeNull();
    expect(steps).toEqual([1]);
  });
});

describe('the pass\'s stepwise steps give what their one-go forms give', () => {
  const rowCount = 90;
  const dimensions = 16;
  const neighbors = computeCosineNeighbors(groupedPoints(rowCount, dimensions), rowCount, dimensions, 8);

  it('the layout, sliced after every epoch', async () => {
    const whole = embedNeighborGraph(neighbors, rowCount, { components: 3 });
    const sliced = await runInSlices(embedNeighborGraphSteps(neighbors, rowCount, { components: 3 }), 0, async () => undefined, never);
    expect(Array.from(sliced!)).toEqual(Array.from(whole));
  });

  it('the region-count sweep, sliced after every candidate', async () => {
    const points = embedNeighborGraph(neighbors, rowCount, { components: 3 });
    for (const band of Object.values(REGION_SIZE_BANDS)) {
      const whole = chooseClusterCount(rowCount, points, 3, band);
      const sliced = await runInSlices(chooseClusterCountSteps(rowCount, points, 3, band), 0, async () => undefined, never);
      expect(sliced).toBe(whole);
    }
  });
});
