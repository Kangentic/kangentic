import { describe, it, expect } from 'vitest';
import { selectDiffAlgorithmOptions } from '../../src/renderer/components/dialogs/task-detail/changes/diff-render-options';

describe('selectDiffAlgorithmOptions', () => {
  it('uses the advanced algorithm with no computation-time bound for a small diff', () => {
    expect(selectDiffAlgorithmOptions(100, 200)).toEqual({ diffAlgorithm: 'advanced' });
  });

  it('drops to the legacy algorithm with a bounded computation time for a large diff', () => {
    expect(selectDiffAlgorithmOptions(150_000, 150_000)).toEqual({
      diffAlgorithm: 'legacy',
      maxComputationTime: 2_000,
    });
  });

  it('is exactly at the boundary when combined length equals the threshold (still advanced)', () => {
    expect(selectDiffAlgorithmOptions(100_000, 100_000)).toEqual({ diffAlgorithm: 'advanced' });
  });
});
