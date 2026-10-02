/**
 * Mean pooling's handling of a chunk vector that is not finite
 * (`addVectorInto` in `retrieval/graph/projection-math.ts`).
 *
 * A NaN folded into a document's sum makes its whole matrix row NaN, and a NaN
 * row compares as "better than nothing" in `computeCosineNeighbors`, so it lands
 * in every other document's neighbour list. The rest of mean pooling is covered
 * in `knowledge-graph-layout.test.ts`.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import {
  addVectorInto,
  createMeanPoolAccumulator,
  finalizeMeanPool,
  setDocumentSum,
} from '../../src/main/retrieval/graph/projection-math';

describe('addVectorInto and a vector that is not finite', () => {
  // Red-green: the finite-check loop at the top of `addVectorInto`. Without it
  // every case below returns true and folds the vector in: the NaN or the
  // infinity lands in the last component of `sum`, and the sum is no longer the
  // [1, 2, 3, 4] it was.
  it.each([
    ['a NaN', Number.NaN],
    ['a positive infinity', Number.POSITIVE_INFINITY],
    ['a negative infinity', Number.NEGATIVE_INFINITY],
  ])('skips a vector holding %s, and leaves the sum untouched', (_label, badValue) => {
    const sum = new Float64Array([1, 2, 3, 4]);
    // The bad component is the last one, after finite ones that a check made
    // while adding would already have folded in.
    const vector = new Float32Array([10, 20, 30, badValue]);

    expect(addVectorInto(sum, vector)).toBe(false);

    expect(Array.from(sum)).toEqual([1, 2, 3, 4]);
  });

  it('skips a vector whose bad component comes first as well', () => {
    const sum = new Float64Array(3);

    expect(addVectorInto(sum, new Float32Array([Number.NaN, 1, 1]))).toBe(false);

    expect(Array.from(sum)).toEqual([0, 0, 0]);
  });

  it('still folds a finite vector in, and a skipped one does not stop the next', () => {
    const sum = new Float64Array(3);

    expect(addVectorInto(sum, new Float32Array([1, 2, 3]))).toBe(true);
    expect(addVectorInto(sum, new Float32Array([1, Number.NaN, 1]))).toBe(false);
    expect(addVectorInto(sum, new Float32Array([1, 2, 3]))).toBe(true);

    expect(Array.from(sum)).toEqual([2, 4, 6]);
  });
});

describe('finalizeMeanPool and a stored sum that is not finite', () => {
  // A sum can arrive non-finite without `addVectorInto`: the projection engine
  // restores stored prefix sums, which may predate its finite check. Red-green:
  // the row zeroing in `finalizeMeanPool`'s bad-norm branch. Without it the raw
  // means stay in the row (a NaN, or an infinity next to a finite value), and
  // that row then takes a slot in every other row's neighbour list.
  it.each([
    ['a NaN', Number.NaN],
    ['an infinity', Number.POSITIVE_INFINITY],
  ])('leaves a document whose sum holds %s as a zero row, and normalizes the others', (_label, badValue) => {
    const accumulator = createMeanPoolAccumulator(2);
    setDocumentSum(accumulator, 'a-healthy', new Float64Array([3, 4]), 1);
    setDocumentSum(accumulator, 'b-broken', new Float64Array([badValue, 4]), 1);

    const pooled = finalizeMeanPool(accumulator);

    expect(pooled.docKeys).toEqual(['a-healthy', 'b-broken']);
    expect(Array.from(pooled.matrix.subarray(0, 2))).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(Array.from(pooled.matrix.subarray(2, 4))).toEqual([0, 0]);
  });
});
