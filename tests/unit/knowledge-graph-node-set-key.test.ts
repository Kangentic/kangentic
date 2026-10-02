/**
 * The identity `nodeSetKey` gives a set of node indices, which is what decides
 * whether the canvas camera flies to a newly lit set.
 *
 * The canvas flies when the key of the lit set changes. The key used to be the
 * set's size plus its FIRST EIGHT members, so a follow-up turn that lit a
 * different set of the same size, sharing those eight, kept the same key and
 * the camera never moved. The key now covers every member, and is order-free so
 * a set handed back in another order is still the same set.
 */

import { describe, it, expect } from 'vitest';
import { nodeSetKey } from '../../src/renderer/components/knowledge-graph/KnowledgeGraphCanvas';

/** The first eight members, shared by the sets below that must key apart. */
const SHARED_PREFIX = [0, 1, 2, 3, 4, 5, 6, 7];

describe('nodeSetKey', () => {
  it('keys apart two sets of equal size that share their first eight members', () => {
    const first = [...SHARED_PREFIX, 8, 9, 10, 11];
    const second = [...SHARED_PREFIX, 8, 9, 10, 12];

    expect(first).toHaveLength(second.length);
    expect(nodeSetKey(first)).not.toBe(nodeSetKey(second));
  });

  it('keys apart sets that differ only in members past the eighth, however many differ', () => {
    const first = [...SHARED_PREFIX, 20, 21, 22];
    const second = [...SHARED_PREFIX, 30, 31, 32];

    expect(nodeSetKey(first)).not.toBe(nodeSetKey(second));
  });

  it('keys the same members in another order the same', () => {
    const members = [...SHARED_PREFIX, 40, 41, 42];
    const reversed = [...members].reverse();
    const rotated = [...members.slice(3), ...members.slice(0, 3)];

    expect(nodeSetKey(reversed)).toBe(nodeSetKey(members));
    expect(nodeSetKey(rotated)).toBe(nodeSetKey(members));
  });

  it('keys the same members the same on every call', () => {
    const members = [5, 9, 13, 200, 4096];

    expect(nodeSetKey(members)).toBe(nodeSetKey([...members]));
  });

  it('keys apart a set and a superset of it', () => {
    expect(nodeSetKey([1, 2, 3])).not.toBe(nodeSetKey([1, 2, 3, 4]));
  });

  it('keys an empty set apart from a set holding index zero', () => {
    expect(nodeSetKey([])).not.toBe(nodeSetKey([0]));
  });
});
