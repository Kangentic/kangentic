/**
 * Unit tests for the pure store-state helpers in
 * src/devtools/renderer/store-state.ts, which back the dev-only
 * `kangentic_devtools_store_state` tool.
 *
 * These run in plain node (the module imports only a type), so the
 * path-walk, JSON sanitization, and registry-read logic are covered
 * without pulling in the renderer Zustand store graph. The live registry
 * binding lives in state-mirror.ts and is covered by
 * devtools-preview-stores.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  getByPath,
  parseStatePath,
  readStoreStateFrom,
  sanitizeForSerialization,
  type ReadableStore,
} from '../../src/devtools/renderer/store-state';

describe('parseStatePath', () => {
  it('splits dotted paths', () => {
    expect(parseStatePath('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('normalizes numeric array indices', () => {
    expect(parseStatePath('items[0].id')).toEqual(['items', '0', 'id']);
  });

  it('normalizes single- and double-quoted bracket keys', () => {
    expect(parseStatePath("map['a key'].x")).toEqual(['map', 'a key', 'x']);
    expect(parseStatePath('map["a key"].x')).toEqual(['map', 'a key', 'x']);
  });

  it('returns an empty list for an empty path', () => {
    expect(parseStatePath('')).toEqual([]);
  });
});

describe('getByPath', () => {
  it('resolves nested object keys', () => {
    const value = { a: { b: { c: 42 } } };
    expect(getByPath(value, 'a.b.c')).toEqual({ found: true, value: 42 });
  });

  it('resolves array indices', () => {
    const value = { items: [{ id: 'x' }, { id: 'y' }] };
    expect(getByPath(value, 'items[1].id')).toEqual({ found: true, value: 'y' });
  });

  it('resolves Map keys', () => {
    const value = { sessions: new Map([['s1', { active: true }]]) };
    expect(getByPath(value, 'sessions.s1.active')).toEqual({ found: true, value: true });
  });

  it('reports not-found for a missing key', () => {
    expect(getByPath({ a: 1 }, 'a.b.c')).toEqual({ found: false, value: undefined });
  });

  it('reports not-found when traversing through a primitive', () => {
    expect(getByPath({ a: 5 }, 'a.b')).toEqual({ found: false, value: undefined });
  });

  it('does not resolve inherited prototype-chain keys as found', () => {
    expect(getByPath({ a: 1 }, 'constructor')).toEqual({ found: false, value: undefined });
    expect(getByPath({ a: 1 }, 'toString')).toEqual({ found: false, value: undefined });
  });

  it('returns the root when path is empty', () => {
    const root = { a: 1 };
    expect(getByPath(root, '')).toEqual({ found: true, value: root });
  });
});

describe('sanitizeForSerialization', () => {
  it('passes primitives through', () => {
    expect(sanitizeForSerialization('text')).toBe('text');
    expect(sanitizeForSerialization(7)).toBe(7);
    expect(sanitizeForSerialization(true)).toBe(true);
    expect(sanitizeForSerialization(null)).toBe(null);
  });

  it('converts a Map to a plain object', () => {
    const result = sanitizeForSerialization(new Map([['a', 1], ['b', 2]]));
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('converts a Set to an array', () => {
    expect(sanitizeForSerialization(new Set([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('truncates arrays past maxArray', () => {
    const result = sanitizeForSerialization([1, 2, 3, 4, 5], { maxArray: 2 }) as unknown[];
    expect(result.slice(0, 2)).toEqual([1, 2]);
    expect(result[2]).toContain('3 more');
  });

  it('caps recursion depth', () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const result = sanitizeForSerialization(deep, { maxDepth: 2 });
    expect(result).toEqual({ a: { b: '[Truncated: max depth]' } });
  });

  it('stringifies functions', () => {
    function namedFn(): void {}
    expect(sanitizeForSerialization({ fn: namedFn })).toEqual({ fn: '[Function: namedFn]' });
  });

  it('stringifies non-finite numbers and bigints', () => {
    expect(sanitizeForSerialization(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(sanitizeForSerialization(BigInt(9))).toBe('9');
  });

  it('marks true cycles as [Circular] but preserves shared acyclic refs', () => {
    const shared = { value: 1 };
    const acyclic = { left: shared, right: shared };
    expect(sanitizeForSerialization(acyclic)).toEqual({
      left: { value: 1 },
      right: { value: 1 },
    });

    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(sanitizeForSerialization(cyclic)).toEqual({ name: 'root', self: '[Circular]' });
  });
});

describe('readStoreStateFrom', () => {
  const registry: Record<string, ReadableStore> = {
    board: { getState: () => ({ taskCount: 3, config: { columns: ['a', 'b'] } }) },
    session: { getState: () => ({ dialogSessionIds: ['sess-1'] }) },
  };

  it('returns the whole sanitized state when no path is given', () => {
    const result = readStoreStateFrom(registry, 'board');
    expect(result.store).toBe('board');
    expect(result.path).toBeNull();
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ taskCount: 3, config: { columns: ['a', 'b'] } });
  });

  it('drills into a path', () => {
    const result = readStoreStateFrom(registry, 'board', 'config.columns[1]');
    expect(result.value).toBe('b');
  });

  it('returns an error plus the sorted available list for an unknown store', () => {
    const result = readStoreStateFrom(registry, 'nope');
    expect(result.value).toBeUndefined();
    expect(result.error).toContain('Unknown store');
    expect(result.available).toEqual(['board', 'session']);
  });

  it('returns an error when the path is missing', () => {
    const result = readStoreStateFrom(registry, 'session', 'does.not.exist');
    expect(result.error).toContain('not found');
  });

  it('returns an error when getState throws', () => {
    const throwingRegistry: Record<string, ReadableStore> = {
      bad: {
        getState: () => {
          throw new Error('boom');
        },
      },
    };
    const result = readStoreStateFrom(throwingRegistry, 'bad');
    expect(result.error).toContain('boom');
  });
});
