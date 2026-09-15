/**
 * scripts/lib/demo-replay-timelines.js has no coverage anywhere else. It is not part of the
 * shipped renderer or main process (only the offline capture and backfill scripts require it),
 * and demo-fixtures-sanitized.test.ts only checks that a fixture HAS a peekTimeline and a
 * frameTimeline, never that the values are what the chrome filter, the reading-time sampler,
 * and the frame deduper actually produce. This file exercises the three pieces of real logic
 * directly: the CLI-chrome filter and truncation in peekFromTerminal, the min/max clamp in
 * readingTimeOf, and the full pipeline's reading-time sampling plus content-based dedup in
 * computeReplayTimelines. Every expected value below is taken from the module's own doc comments
 * (the chrome list, the 96-character truncation, the 2500/6000 clamp, "kept only once the one
 * before it has been readable for its own reading time", "an unchanged screen is dropped"), not
 * from a run of the code, so a broken filter or a broken sampler shows up as a failure here rather
 * than shipping into a committed fixture unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import {
  peekFromTerminal,
  computeReplayTimelines,
  readingTimeOf,
} from '../../scripts/lib/demo-replay-timelines.js';

function writeAndWait(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()));
}

describe('readingTimeOf', () => {
  it('clamps a short line up to the 2500ms floor', () => {
    // 1200 + 18*2 = 1236, below the floor.
    expect(readingTimeOf(['hi'])).toBe(2500);
  });

  it('clamps a long line down to the 6000ms ceiling', () => {
    // 1200 + 18*500 = 10200, above the ceiling.
    expect(readingTimeOf(['x'.repeat(500)])).toBe(6000);
  });

  it('uses the base-plus-per-character estimate when it falls inside the floor and ceiling', () => {
    // 1200 + 18*96 = 2928, inside [2500, 6000].
    expect(readingTimeOf(['a'.repeat(96)])).toBe(2928);
  });
});

describe('peekFromTerminal', () => {
  it('drops a trailing CLI-chrome row and keeps the real output above it', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    // "esc to interrupt" is Claude's own footer, not agent output; the real line above it
    // is what the Monitor card should show.
    await writeAndWait(terminal, 'Task completed and pushed to origin\r\nesc to interrupt\r\n');
    expect(peekFromTerminal(terminal)).toEqual(['Task completed and pushed to origin']);
    terminal.dispose();
  });

  it('truncates a line past 96 characters to 93 characters plus an ellipsis', async () => {
    // A wide terminal so the row itself does not wrap before translateToString sees it.
    const terminal = new Terminal({ cols: 120, rows: 24, allowProposedApi: true });
    const longLine = 'A'.repeat(120);
    await writeAndWait(terminal, `${longLine}\r\n`);
    expect(peekFromTerminal(terminal)).toEqual([`${'A'.repeat(93)}...`]);
    terminal.dispose();
  });
});

describe('computeReplayTimelines', () => {
  it('returns empty timelines for an empty or missing stream, with no finalPeek key', async () => {
    const empty = await computeReplayTimelines({ stream: [], cols: 80, rows: 24 });
    expect(empty).toEqual({ peekTimeline: [], frameTimeline: [] });
    expect('finalPeek' in empty).toBe(false);

    // An absent stream is treated the same as an empty one, matching computeReplayTimelines' own
    // `Array.isArray(options.stream) ? options.stream : []` guard, which covers both.
    const absent = await computeReplayTimelines({ cols: 80, rows: 24 });
    expect(absent).toEqual({ peekTimeline: [], frameTimeline: [] });
  });

  it('samples peek changes by reading time, dedupes unchanged frames, and always reports finalPeek', async () => {
    // Each window appends one new line, so the two-line peek window slides and produces a
    // genuinely new change every time real output arrives.
    const result = await computeReplayTimelines({
      cols: 80,
      rows: 24,
      stream: [
        { t: 0, data: 'Line one output\r\n' },
        // Arrives 1000ms after the first change. readingTimeOf(['Line one output']) clamps to
        // 2500ms, so this change lands inside that window and must be dropped.
        { t: 1000, data: 'Line two output\r\n' },
        // Arrives 3000ms after the first KEPT change (still t=0, since the 1000ms change was
        // dropped), past its 2500ms reading time, so this one is kept.
        { t: 3000, data: 'Line three output\r\n' },
        // No new output. The visible screen is identical to the previous window, so this must
        // add neither a peek change nor a frame, but finalPeek still reflects it.
        { t: 4000, data: '' },
      ],
    });

    expect(result.peekTimeline).toEqual([
      { t: 0, lines: ['Line one output'] },
      { t: 3000, lines: ['Line two output', 'Line three output'] },
    ]);
    expect(result.finalPeek).toEqual(['Line two output', 'Line three output']);

    // One frame per genuine content change (t=0, 1000, 3000); the t=4000 no-op window is
    // deduped because its serialized frame matches the one already captured for t=3000.
    expect(result.frameTimeline.map((entry: { t: number }) => entry.t)).toEqual([0, 1000, 3000]);
    for (const entry of result.frameTimeline as { t: number; frame: string }[]) {
      expect(typeof entry.frame).toBe('string');
      expect(entry.frame.length).toBeGreaterThan(0);
    }
  });
});
