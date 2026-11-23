/**
 * `isCheckpointHoldLine`: how main tells a retrieval worker held in an in-loop WAL checkpoint
 * (not killed, see `heldInCheckpoint` in `retrieval-client.ts`) from one that is stuck.
 *
 * The input is the event-loop watchdog's stderr line. The line shape is pinned by
 * `event-loop-watchdog.test.ts` (`[prefix] event loop held <n> s in <label>`, written by the
 * watchdog thread from `EVENT_LOOP_HELD_PHRASE`), so the samples here are built from that phrase
 * and the worker's real `[retrieval-worker]` prefix, the same shape `retrieval-client.test.ts`
 * feeds the client. The tail case goes through `watchdogLine`, the path main reads it by.
 *
 * Tier: Unit.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_AFTER_WRITE_LABEL,
  CHECKPOINT_TICK_LABEL,
  isCheckpointHoldLine,
} from '../../src/main/retrieval/worker/checkpoint-labels';
import { EVENT_LOOP_HELD_PHRASE, watchdogLine } from '../../src/main/utility-process/stderr-tail';

function heldLine(label: string): string {
  return `[retrieval-worker] ${EVENT_LOOP_HELD_PHRASE} 5 s in ${label}`;
}

describe('isCheckpointHoldLine', () => {
  describe.each([
    ['the main tick label', CHECKPOINT_TICK_LABEL],
    ['the after-write label', CHECKPOINT_AFTER_WRITE_LABEL],
  ])('%s', (_name, label) => {
    it('reads as a hold', () => {
      expect(isCheckpointHoldLine(heldLine(label))).toBe(true);
    });

    it.each([
      ['a trailing CR', '\r'],
      ['a trailing CRLF', '\r\n'],
      ['a trailing LF', '\n'],
      ['trailing spaces', '   '],
    ])('reads as a hold with %s', (_suffixName, suffixText) => {
      expect(isCheckpointHoldLine(`${heldLine(label)}${suffixText}`)).toBe(true);
    });
  });

  it('reads the line watchdogLine returns from a multi-line stderr tail', () => {
    const tail = [
      'warming up',
      heldLine('transcript:parse-codex'),
      'noise between the lines',
      heldLine(CHECKPOINT_AFTER_WRITE_LABEL),
      'exit',
      '',
    ].join('\r\n');
    const line = watchdogLine(tail);
    expect(line).not.toBeNull();
    expect(isCheckpointHoldLine(line ?? '')).toBe(true);
  });

  it.each([
    ['the old shared label', heldLine('db:checkpoint')],
    ['a method span', heldLine('method:db.checkpoint')],
    ['a label with a suffix after it', heldLine(`${CHECKPOINT_TICK_LABEL}-extra`)],
    ['another step', heldLine('transcript:parse-codex')],
    ['an empty string', ''],
  ])('does not read %s as a checkpoint hold', (_name, line) => {
    expect(isCheckpointHoldLine(line)).toBe(false);
  });
});
