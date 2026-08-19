/**
 * The region count is chosen from the corpus's STRUCTURE, not its size.
 *
 * The old rule was `round(sqrt(rowCount / 2))` clamped to 10 - a function of how
 * many conversations there were and nothing else. It carved nine regions out of
 * 150 because there were 150 of them, and on a real 638-conversation corpus it
 * wanted 18 and was clamped to 10, which is what forced unrelated work into one
 * region and produced labels that read as odd groupings.
 *
 * These tests plant a known number of well-separated groups and require the
 * chooser to find roughly that many. A planted ground truth is the only way to
 * tell "picked a good k" from "picked a plausible-looking number".
 */

import { describe, it, expect } from 'vitest';
import {
  chooseClusterCount,
  assignClusters,
  candidateTerms,
  selectLabelTerms,
} from '../../src/main/retrieval/graph/cluster-labels';

const COMPONENTS = 3;
/**
 * Mirrors `MAX_REGIONS` in the source, which is deliberately not exported: the
 * assertions below are that a hard clamp EXISTS and binds, so restating the
 * number here means a change to it has to be made twice and thought about once.
 * It moved 10 -> 24 -> 40 as the surface gained ways to manage many regions.
 */
const HARD_CEILING = 40;

/** Deterministic jitter, so a run cannot pass or fail by luck. */
function seededNoise(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000 - 0.5;
  };
}

/**
 * `groupCount` tight blobs spread over the unit cube, `perGroup` points each.
 * The spread is deliberately much larger than the jitter, so the planted count
 * is unambiguous and a chooser that disagrees is genuinely wrong.
 */
function plantedGroups(groupCount: number, perGroup: number): Float32Array {
  const noise = seededNoise(0x2f6b1d);
  const points = new Float32Array(groupCount * perGroup * COMPONENTS);
  let row = 0;
  for (let group = 0; group < groupCount; group += 1) {
    // Spread the centres around a circle in x/y with a stepped z, which keeps
    // them far apart without relying on a random draw landing well.
    const angle = (group / groupCount) * Math.PI * 2;
    const centreX = Math.cos(angle) * 40;
    const centreY = Math.sin(angle) * 40;
    const centreZ = (group % 3) * 30;
    for (let member = 0; member < perGroup; member += 1) {
      points[row * COMPONENTS] = centreX + noise() * 3;
      points[row * COMPONENTS + 1] = centreY + noise() * 3;
      points[row * COMPONENTS + 2] = centreZ + noise() * 3;
      row += 1;
    }
  }
  return points;
}

describe('region count', () => {
  it('lets structure move the answer, at the same corpus size', () => {
    // The load-bearing case. Two corpora with the SAME number of conversations
    // and different structure must not get the same number of regions - which is
    // exactly what a size-based rule guarantees they would.
    //
    // A DIRECTION is deliberately not asserted, and the reason is worth knowing:
    // four groups of sixty need MORE regions than twelve groups of twenty, not
    // fewer, because each sixty is far past a readable size and has to be cut up
    // while each twenty already fits. Structure decides where the cuts fall; the
    // band decides how many there have to be.
    const fourGroups = chooseClusterCount(240, plantedGroups(4, 60), COMPONENTS);
    const twelveGroups = chooseClusterCount(240, plantedGroups(12, 20), COMPONENTS);

    expect(fourGroups).not.toBe(twelveGroups);
  });

  it('judges the whole corpus, not a leading slice of it', () => {
    // The rule used to cluster a 500-row PREFIX to pick the count and then
    // cluster everything with it. The prefix is in insertion order, which is
    // chunk-id order, which is roughly chronological - so past 500 conversations
    // the answer came from the oldest 500 and the rest never voted. Measured on
    // the real 646-conversation corpus that cost real quality: the prefix chose
    // 20 regions for coarse where the whole corpus chooses 22, and the prefix's
    // answer carried a 61-conversation region against the other's 44.
    //
    // The property that catches it: two corpora sharing an identical first 500
    // rows must still be ALLOWED to disagree. A prefix rule cannot - same
    // prefix and same row count means the same sweep over the same points, so
    // it returns the same number every time however the tail is shaped.
    const prefix = plantedGroups(25, 20);
    const withGroupedTail = new Float32Array(700 * COMPONENTS);
    const withPiledTail = new Float32Array(700 * COMPONENTS);
    withGroupedTail.set(prefix);
    withPiledTail.set(prefix);

    // Same 200 extra conversations either way, but one tail is ten separate
    // subjects and the other is a single dense one.
    const tail = plantedGroups(10, 20);
    withGroupedTail.set(tail, 500 * COMPONENTS);
    const noise = seededNoise(0x9a41c7);
    for (let row = 500; row < 700; row += 1) {
      withPiledTail[row * COMPONENTS] = 200 + noise() * 2;
      withPiledTail[row * COMPONENTS + 1] = 200 + noise() * 2;
      withPiledTail[row * COMPONENTS + 2] = 200 + noise() * 2;
    }

    expect(chooseClusterCount(700, withGroupedTail, COMPONENTS)).not.toBe(
      chooseClusterCount(700, withPiledTail, COMPONENTS),
    );
  });

  it('keeps the average region inside a readable size band', () => {
    // The band is the readability judgement no separation score can make on a
    // continuous cloud: every one of them - Calinski-Harabasz, silhouette,
    // neighbour purity - is maximised by the FEWEST regions, so left to a score
    // the map came back as five regions with 45 conversations in one of them.
    for (const rowCount of [60, 150, 240, 638]) {
      const chosen = chooseClusterCount(rowCount, plantedGroups(6, Math.round(rowCount / 6)), COMPONENTS);
      const averageSize = rowCount / chosen;
      expect(averageSize).toBeLessThanOrEqual(27);
      expect(averageSize).toBeGreaterThanOrEqual(9);
    }
  });

  it('goes past the old ceiling of ten when the corpus earns it', () => {
    // The clamp is what merged unrelated work on the real corpus.
    const many = chooseClusterCount(360, plantedGroups(18, 20), COMPONENTS);
    expect(many).toBeGreaterThan(10);
  });

  it('still refuses to shatter a corpus into slivers', () => {
    // A region of two or three conversations is a coincidence, not a domain, so
    // the band tracks the corpus size as well as the score.
    const small = chooseClusterCount(24, plantedGroups(12, 2), COMPONENTS);
    expect(small).toBeLessThanOrEqual(4);
  });

  it('clamps a very large corpus to the hard ceiling', () => {
    // The band's floor scales with size, so a big enough index pushes it past
    // the ceiling. That went unclamped and returned one more than the limit.
    expect(chooseClusterCount(5000)).toBeLessThanOrEqual(HARD_CEILING);
    expect(chooseClusterCount(50000)).toBeLessThanOrEqual(HARD_CEILING);
  });

  it('never returns fewer than three, or more than the hard ceiling', () => {
    for (const rowCount of [6, 30, 150, 638, 5000]) {
      const chosen = chooseClusterCount(rowCount);
      expect(chosen).toBeGreaterThanOrEqual(3);
      expect(chosen).toBeLessThanOrEqual(HARD_CEILING);
    }
  });

  it('is deterministic, so a rebuild does not reshuffle the map', () => {
    const points = plantedGroups(7, 30);
    const first = chooseClusterCount(210, points, COMPONENTS);
    const second = chooseClusterCount(210, points, COMPONENTS);
    expect(first).toBe(second);
  });

  it('sizes every ACTUAL region, not just the average', () => {
    // The regression this rule exists for. The average size was already inside
    // the band when one region held 45 of 150 conversations: k-means makes
    // whatever sizes it likes, so an average says nothing about the largest.
    // Measured per region, on the clustering the chooser actually produces.
    // Fifteen groups of twenty: a clean answer EXISTS here, which the assertion
    // needs. Ten groups of thirty would have none - every planted group is
    // already past the band's ceiling, so the chooser would be in its
    // fewest-violations fallback and could not satisfy this.
    const rowCount = 300;
    const points = plantedGroups(15, 20);
    const chosen = chooseClusterCount(rowCount, points, COMPONENTS);
    const assignment = assignClusters(points, rowCount, chosen, COMPONENTS);

    const sizes = new Int32Array(assignment.clusterCount);
    for (let row = 0; row < rowCount; row += 1) sizes[assignment.clusterOf[row]] += 1;
    for (const size of sizes) {
      expect(size).toBeGreaterThanOrEqual(10);
      expect(size).toBeLessThanOrEqual(26);
    }
  });

  it('prefers MORE regions when two counts are equally clean', () => {
    // The tie-break, and it points at detail on purpose: filing two distinct
    // subjects under one name is the failure people notice, and an extra region
    // they can switch off in the Regions panel is the cheaper mistake.
    //
    // Twelve planted groups of 12 admit several clean counts; the chooser must
    // not settle for the smallest of them.
    const points = plantedGroups(12, 12);
    const chosen = chooseClusterCount(144, points, COMPONENTS);
    expect(chosen).toBeGreaterThanOrEqual(8);
  });

  it('never reaches past a long term to append a short meaningless one', () => {
    // The bug this pins, measured on the real corpus. The character budget used
    // to SKIP a term that did not fit and carry on down the ranking, so a short
    // word that fit exactly landed in the label ahead of the phrase it
    // displaced: "browser pane / light dismiss" had "title bar" next at 16.5,
    // three characters too long, and the budget reached past it to append "one"
    // - which scored 3.9, came from two titles, and named a region of 24
    // conversations. "task detail / main thread / until" and "adopt kangentic /
    // panel min / app" were the same mechanism.
    //
    // Driven through `selectLabelTerms` directly rather than through a corpus.
    // Reproducing it end to end needs the tokenizer, the rarity floor and the
    // corpus-frequency ceiling to line up simultaneously, and a fixture tuned
    // that finely tests those three as much as the thing it is aimed at.
    const ranked = [
      { term: 'browser pane', score: 23.4 },
      { term: 'light dismiss', score: 17.5 },
      { term: 'title bar', score: 16.5 },
      { term: 'one', score: 3.9 },
    ];

    // 'browser pane' + ' / ' + 'light dismiss' is 28; 'title bar' needs 12 more
    // and the budget is 34, so it does not fit and nothing after it may be used.
    expect(selectLabelTerms(ranked)).toEqual(['browser pane', 'light dismiss']);
  });

  it('still skips a term that only restates one already chosen', () => {
    // The budget TRUNCATES, but an overlapping term is a different case: it says
    // nothing new, so the next distinct term is still a fair candidate. Getting
    // these two the same way round is what stops "terminal / task terminal".
    const ranked = [
      { term: 'task detail', score: 20 },
      { term: 'detail', score: 18 },
      { term: 'xterm', score: 16 },
    ];
    expect(selectLabelTerms(ranked)).toEqual(['task detail', 'xterm']);
  });

  it('never builds a phrase across punctuation', () => {
    // "Cross-project agent monitor: watch every running agent in one view"
    // produced the pair "monitor watch" - two words adjacent only because the
    // colon between them had been stripped - and it went on to name a region of
    // 24 conversations.
    //
    // Driven through the tokenizer rather than a corpus, for the same reason as
    // the budget case above: a fixture that reaches the label has to satisfy the
    // rarity floor and the frequency ceiling at the same time, and then tests
    // those as much as this.
    expect(candidateTerms('agent monitor: watch every running task'))
      .not.toContain('monitor watch');

    // The words either side of the colon are still perfectly good on their own.
    expect(candidateTerms('agent monitor: watch every running task'))
      .toContain('monitor');

    // A hyphen INSIDE a word is not a boundary: "cross-project" is one idea and
    // has to survive as the pair it reads as.
    expect(candidateTerms('cross-project agent monitor'))
      .toContain('cross project');

    // Nor may a phrase span a word the length filter discarded.
    expect(candidateTerms('replay of drains')).not.toContain('replay drains');
  });

  it('still answers when no count can satisfy the band', () => {
    // One dense blob plus a handful of strays: every candidate leaves something
    // out of range, so the rule falls back to the fewest violations rather than
    // returning nothing or throwing.
    const points = new Float32Array(40 * COMPONENTS);
    const noise = seededNoise(0x9a12c);
    for (let row = 0; row < 36; row += 1) {
      for (let axis = 0; axis < COMPONENTS; axis += 1) points[row * COMPONENTS + axis] = noise() * 0.4;
    }
    for (let row = 36; row < 40; row += 1) {
      points[row * COMPONENTS] = 200 + row;
      points[row * COMPONENTS + 1] = 200;
      points[row * COMPONENTS + 2] = 200;
    }
    const chosen = chooseClusterCount(40, points, COMPONENTS);
    expect(chosen).toBeGreaterThanOrEqual(3);
    expect(chosen).toBeLessThanOrEqual(24);
  });
});
