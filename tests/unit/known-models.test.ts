/**
 * The picker union of live CLI models and telemetry-learned ids.
 */
import { describe, it, expect } from 'vitest';
import { unionKnownModels } from '../../src/renderer/hooks/useKnownModels';

describe('unionKnownModels', () => {
  it('drops a display name that contains a space, so it cannot become a picker row', () => {
    expect(unionKnownModels(
      ['cursor-grok-4.6-high'],
      ['grok 4.6 high', 'composer-2.5'],
    )).toEqual(['composer-2.5', 'cursor-grok-4.6-high']);
  });
});
