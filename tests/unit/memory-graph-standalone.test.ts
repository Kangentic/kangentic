/**
 * "Standalone" has to mean what it says.
 *
 * It used to mean "no link survived the drawn mesh", which on the real corpus
 * matched 37 of 150 conversations - every one of which had up to six exact
 * neighbours the detail panel would list underneath it. The word claimed
 * something about the WORK and reported something about the renderer.
 *
 * These tests pin the two properties that make the corrected version worth a
 * permanent control: it finds a genuine one-off, and it finds NOTHING on an
 * index where everything is related.
 */

import { describe, it, expect } from 'vitest';
import { findStandalone } from '../../src/renderer/components/memory/standalone-conversations';

type Neighbors = Array<Array<{ index: number; similarity: number }>>;

/** `count` conversations whose best match is `similarity`. */
function flat(count: number, similarity: number): Neighbors {
  return Array.from({ length: count }, (_unused, index) => [
    { index: (index + 1) % count, similarity },
    { index: (index + 2) % count, similarity: similarity - 0.02 },
  ]);
}

describe('standalone conversations', () => {
  it('finds the conversation nothing else came close to', () => {
    const neighbors = flat(20, 0.98);
    // Two genuine one-offs, matching the shape measured on the real corpus:
    // a tight pack around 0.98 and a couple far below it.
    neighbors[3] = [{ index: 7, similarity: 0.71 }];
    neighbors[11] = [{ index: 2, similarity: 0.77 }];

    const standalone = findStandalone(neighbors, 20);
    expect([...standalone].sort((first, second) => first - second)).toEqual([3, 11]);
  });

  it('finds nothing when everything is related', () => {
    // The property that earns it a permanent control: a filter that can only
    // ever do nothing hides itself, so appearing at all has to mean something.
    expect(findStandalone(flat(30, 0.96), 30).size).toBe(0);
  });

  it('is not fooled by how TIGHT the corpus is', () => {
    // The rule this replaced used spread. On the real corpus the best-match
    // similarities run 0.964 to 0.994 above the 5th percentile, so MAD is 0.003
    // and "three MADs below the median" lands a hundredth under it - flagging 14
    // of 150 from the middle of the pack. A relative gap does not care how tight
    // the distribution is.
    const neighbors = flat(40, 0.9875);
    for (let index = 0; index < 40; index += 1) {
      // A realistic ripple, well inside any sensible reading of "related".
      neighbors[index][0].similarity = 0.9875 - (index % 8) * 0.0015;
    }
    expect(findStandalone(neighbors, 40).size).toBe(0);
  });

  it('treats a conversation with no neighbours at all as standalone', () => {
    const neighbors = flat(10, 0.97);
    neighbors[4] = [];
    expect([...findStandalone(neighbors, 10)]).toEqual([4]);
  });

  it('says nothing about a corpus too small to have a middle', () => {
    expect(findStandalone(flat(3, 0.9), 3).size).toBe(0);
    expect(findStandalone(undefined, 10).size).toBe(0);
  });
});
