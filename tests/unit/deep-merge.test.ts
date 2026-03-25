import { describe, it, expect } from 'vitest';
import { deepMerge } from '../../src/shared/object-utils';

describe('deepMerge', () => {
  it('merges nested objects recursively when they contain non-primitive values', () => {
    const target = { a: { b: { x: 1 }, c: { y: 2 } }, d: 3 };
    const source = { a: { b: { x: 10 } } };
    expect(deepMerge(target, source)).toEqual({ a: { b: { x: 10 }, c: { y: 2 } }, d: 3 });
  });

  it('replaces arrays instead of merging them', () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };
    expect(deepMerge(target, source)).toEqual({ items: [4, 5] });
  });

  it('allows null to override a value', () => {
    const target = { a: 'hello' };
    const source = { a: null };
    expect(deepMerge(target, source as Partial<typeof target>)).toEqual({ a: null });
  });

  it('skips undefined values in source', () => {
    const target = { a: 1, b: 2 };
    const source = { a: undefined, b: 3 };
    expect(deepMerge(target, source)).toEqual({ a: 1, b: 3 });
  });

  describe('flat map replacement', () => {
    it('replaces a flat string map entirely instead of merging keys', () => {
      const target = { labelColors: { foo: '#ff0000', bar: '#00ff00', baz: '#0000ff' } };
      const source = { labelColors: { foo: '#ff0000', bar: '#00ff00' } };
      const result = deepMerge(target, source);
      expect(result.labelColors).toEqual({ foo: '#ff0000', bar: '#00ff00' });
      expect('baz' in result.labelColors).toBe(false);
    });

    it('handles deleting all keys from a flat map', () => {
      const target = { labelColors: { foo: '#ff0000' } };
      const source = { labelColors: {} };
      const result = deepMerge(target, source);
      expect(result.labelColors).toEqual({});
    });

    it('handles adding a new key to a flat map', () => {
      const target = { labelColors: { foo: '#ff0000' } };
      const source = { labelColors: { foo: '#ff0000', bar: '#00ff00' } };
      const result = deepMerge(target, source);
      expect(result.labelColors).toEqual({ foo: '#ff0000', bar: '#00ff00' });
    });

    it('still deep-merges objects with nested object values', () => {
      const target = { backlog: { labelColors: { foo: '#ff0000', bar: '#00ff00' }, priorities: [{ label: 'High' }] } };
      const source = { backlog: { labelColors: { foo: '#ff0000' } } };
      const result = deepMerge(target, source);
      // backlog is NOT flat (contains array and object), so it recurses
      // labelColors IS flat, so it replaces entirely
      expect(result.backlog.labelColors).toEqual({ foo: '#ff0000' });
      // priorities should be preserved (not in source)
      expect(result.backlog.priorities).toEqual([{ label: 'High' }]);
    });

    it('replaces flat map with mixed primitive types', () => {
      const target = { settings: { enabled: true, count: 5, name: 'test', removed: 'old' } };
      const source = { settings: { enabled: false, count: 10, name: 'updated' } };
      const result = deepMerge(target, source);
      expect(result.settings).toEqual({ enabled: false, count: 10, name: 'updated' });
      expect('removed' in result.settings).toBe(false);
    });

    it('treats flat map with null values as a flat map', () => {
      const target = { colors: { a: '#fff', b: '#000' } };
      const source = { colors: { a: null } };
      const result = deepMerge(target, source as Partial<typeof target>);
      expect(result.colors).toEqual({ a: null });
      expect('b' in result.colors).toBe(false);
    });
  });
});
