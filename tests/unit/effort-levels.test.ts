import { describe, it, expect } from 'vitest';
import { effortLevelsForModel } from '../../src/shared/effort-levels';

const capabilities = {
  effortLevels: ['low', 'medium'],
  effortLevelsByModel: { 'model-a': ['high', 'max'], 'model-empty': [] as string[] },
};

describe('effortLevelsForModel', () => {
  it('returns the model\'s own levels when the map lists it', () => {
    expect(effortLevelsForModel(capabilities, 'model-a')).toEqual(['high', 'max']);
  });

  it('falls back to the agent-wide levels for a model the map does not list', () => {
    expect(effortLevelsForModel(capabilities, 'model-b')).toEqual(['low', 'medium']);
  });

  it('returns the agent-wide levels for a null or undefined model', () => {
    expect(effortLevelsForModel(capabilities, null)).toEqual(['low', 'medium']);
    expect(effortLevelsForModel(capabilities, undefined)).toEqual(['low', 'medium']);
  });

  it('returns no levels for null or undefined capabilities', () => {
    expect(effortLevelsForModel(null, 'model-a')).toEqual([]);
    expect(effortLevelsForModel(undefined, 'model-a')).toEqual([]);
  });

  it('returns no levels when capabilities lack effortLevels and the model is unlisted', () => {
    expect(effortLevelsForModel({}, 'model-a')).toEqual([]);
  });

  it('returns an empty list for a model mapped to none, without falling back', () => {
    expect(effortLevelsForModel(capabilities, 'model-empty')).toEqual([]);
  });

  it('ignores inherited Object.prototype members used as a model name', () => {
    for (const model of ['constructor', 'toString', '__proto__']) {
      expect(effortLevelsForModel(capabilities, model)).toEqual(['low', 'medium']);
    }
  });
});
