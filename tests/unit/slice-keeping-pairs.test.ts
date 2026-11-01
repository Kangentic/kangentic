/**
 * sliceKeepingPairs (src/main/agent/shared/slice-keeping-pairs.ts) and the two
 * places that cap text for an agent with it: a task's description in the task
 * reads (`taskDescriptionLines`) and a query_db cell (`handleQueryDb`).
 *
 * JavaScript counts UTF-16 units, so a plain `slice` at a cap can land between
 * the two halves of an emoji. A lone surrogate prints as U+FFFD and has no
 * UTF-8 encoding, so the agent reading the capped text would see a broken
 * character. Every assertion about a cut therefore also checks the output is
 * well formed.
 */
import { describe, it, expect, vi } from 'vitest';
import { sliceKeepingPairs } from '../../src/main/agent/shared/slice-keeping-pairs';
import { taskDescriptionLines } from '../../src/main/agent/commands/search-commands';
import {
  handleQueryDb,
  MAX_CELL_CHARS_MANY_ROWS,
  MAX_CELL_CHARS_ONE_ROW,
} from '../../src/main/agent/commands/inspect-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

// inspect-commands reaches the agent registry, the retrieval worker's client
// and the workflow service for its transcript reads. The query_db handler
// touches none of them, so each is an empty stand-in (as in
// inspect-commands.test.ts, minus the transcript wiring).
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn(), list: vi.fn(() => []), get: vi.fn() },
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: {},
}));
vi.mock('../../src/main/workflows/workflow-service', () => ({
  resolveWorkflow: vi.fn(),
  WorkflowRequestError: class WorkflowRequestError extends Error {},
}));

const GRINNING_FACE = '\u{1F600}';
const HIGH_SURROGATE = GRINNING_FACE[0];

/** A high surrogate with no low one after it, or a low one with no high one before it. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('sliceKeepingPairs', () => {
  it('returns text no longer than the limit whole', () => {
    expect(sliceKeepingPairs('abc', 10)).toBe('abc');
    expect(sliceKeepingPairs('abc', 3)).toBe('abc');
    expect(sliceKeepingPairs('', 3)).toBe('');
  });

  it('returns whole a text that ends in an emoji when its length equals the limit', () => {
    const text = `ab${GRINNING_FACE}`;

    const result = sliceKeepingPairs(text, text.length);

    expect(result).toBe(text);
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it('keeps exactly the limit when the cut falls between plain characters', () => {
    expect(sliceKeepingPairs('abcdef', 3)).toBe('abc');
    expect(sliceKeepingPairs(`ab${GRINNING_FACE}cd`, 2)).toBe('ab');
  });

  it('drops the high surrogate when the cut would land between the two halves of an emoji', () => {
    const text = `ab${GRINNING_FACE}cd`;
    // Index 2 is the emoji's high surrogate, so a limit of 3 keeps only that half.
    expect(text.slice(0, 3).endsWith(HIGH_SURROGATE)).toBe(true);

    const result = sliceKeepingPairs(text, 3);

    expect(result).toBe('ab');
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it('keeps an emoji whole when the cut falls right after it', () => {
    const result = sliceKeepingPairs(`ab${GRINNING_FACE}cd`, 4);

    expect(result).toBe(`ab${GRINNING_FACE}`);
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it('returns nothing when the limit would keep only the first half of a leading emoji', () => {
    expect(sliceKeepingPairs(`${GRINNING_FACE}x`, 1)).toBe('');
  });

  it('returns nothing for a limit of zero', () => {
    expect(sliceKeepingPairs('abc', 0)).toBe('');
    expect(sliceKeepingPairs(`${GRINNING_FACE}x`, 0)).toBe('');
  });

  it('leaves no lone surrogate at any cut of a run of emoji', () => {
    const text = GRINNING_FACE.repeat(6);

    for (let limit = 0; limit < text.length; limit += 1) {
      const result = sliceKeepingPairs(text, limit);

      expect(hasLoneSurrogate(result), `limit ${limit}`).toBe(false);
      // At most one unit short: an even limit keeps whole pairs, an odd one drops the split pair's first half.
      expect(result.length, `limit ${limit}`).toBe(limit - (limit % 2));
    }
  });
});

describe('taskDescriptionLines', () => {
  it('prints nothing for a task with no description', () => {
    expect(taskDescriptionLines({ description: '' }, 400)).toEqual([]);
    expect(taskDescriptionLines({ description: '  \n ' }, 400)).toEqual([]);
  });

  it('prints a description within the cap whole, indented, with no cut note', () => {
    expect(taskDescriptionLines({ description: 'first\nsecond' }, 400)).toEqual([
      '  Description:',
      '    first',
      '    second',
    ]);
  });

  it('leaves no lone surrogate when an emoji straddles the cap, and counts what it left out', () => {
    const description = `ab${GRINNING_FACE}cd`;

    const lines = taskDescriptionLines({ description }, 3);

    expect(lines).toEqual([
      '  Description:',
      '    ab',
      // 'ab' shown of 6 UTF-16 units: the emoji's two units and 'cd' are left out.
      '    ... (4 more characters not shown)',
    ]);
    expect(hasLoneSurrogate(lines.join('\n'))).toBe(false);
  });

  it('keeps an emoji that ends exactly at the cap', () => {
    const lines = taskDescriptionLines({ description: `ab${GRINNING_FACE}cd` }, 4);

    expect(lines).toEqual([
      '  Description:',
      `    ab${GRINNING_FACE}`,
      '    ... (2 more characters not shown)',
    ]);
    expect(hasLoneSurrogate(lines.join('\n'))).toBe(false);
  });

  it('measures the trimmed description, so surrounding blank space does not move the cut', () => {
    const lines = taskDescriptionLines({ description: `\n  ab${GRINNING_FACE}cd  \n` }, 3);

    expect(lines).toEqual([
      '  Description:',
      '    ab',
      '    ... (4 more characters not shown)',
    ]);
  });
});

describe('handleQueryDb cell cap', () => {
  /** A project db that answers every query with `rows`, and accepts the read-only pragma. */
  function contextAnswering(rows: Record<string, unknown>[]): CommandContext {
    const database = {
      pragma: vi.fn(),
      prepare: vi.fn(() => ({ all: () => rows })),
    };
    return { getProjectDb: () => database } as unknown as CommandContext;
  }

  /** A value whose emoji's high surrogate is the last unit the cell keeps before its `...`. */
  function valueStraddlingTheCut(cellChars: number): string {
    // The cell keeps `cellChars - 3` units and appends `...`, so the unit at
    // index `cellChars - 4` is the last one kept.
    return `${'x'.repeat(cellChars - 4)}${GRINNING_FACE}${'y'.repeat(50)}`;
  }

  it('leaves no lone surrogate when an emoji straddles the cap of a one-row result', () => {
    const cellChars = MAX_CELL_CHARS_ONE_ROW;
    const value = valueStraddlingTheCut(cellChars);
    expect(value.length).toBeGreaterThan(cellChars);
    expect(value[cellChars - 4]).toBe(HIGH_SURROGATE);

    const result = handleQueryDb({ sql: 'SELECT content FROM data' }, contextAnswering([{ content: value }]));

    expect(result.success).toBe(true);
    const message = result.message ?? '';
    // A boolean, so a failure does not print a 20,000-character needle.
    expect(message.includes(`| ${'x'.repeat(cellChars - 4)}... |`), 'the cell ends at the character before the emoji').toBe(true);
    expect(message).not.toContain(HIGH_SURROGATE);
    expect(hasLoneSurrogate(message)).toBe(false);
    expect(message).toContain(`Values longer than ${cellChars} characters were cut (content).`);
  });

  it('leaves no lone surrogate when an emoji straddles the cap of a many-row result', () => {
    const cellChars = MAX_CELL_CHARS_MANY_ROWS;
    const value = valueStraddlingTheCut(cellChars);
    expect(value[cellChars - 4]).toBe(HIGH_SURROGATE);

    const result = handleQueryDb(
      { sql: 'SELECT content FROM data' },
      contextAnswering([{ content: value }, { content: 'short' }]),
    );

    expect(result.success).toBe(true);
    const message = result.message ?? '';
    expect(message.includes(`| ${'x'.repeat(cellChars - 4)}... |`), 'the cell ends at the character before the emoji').toBe(true);
    expect(message).toContain('| short |');
    expect(message).not.toContain(HIGH_SURROGATE);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it('keeps an emoji that ends exactly where the cell is cut', () => {
    const cellChars = MAX_CELL_CHARS_MANY_ROWS;
    // The emoji's two units are the last two the cell keeps.
    const value = `${'x'.repeat(cellChars - 5)}${GRINNING_FACE}${'y'.repeat(50)}`;

    const result = handleQueryDb(
      { sql: 'SELECT content FROM data' },
      contextAnswering([{ content: value }, { content: 'short' }]),
    );

    const message = result.message ?? '';
    expect(message.includes(`| ${'x'.repeat(cellChars - 5)}${GRINNING_FACE}... |`), 'the cell keeps the whole emoji').toBe(true);
    expect(hasLoneSurrogate(message)).toBe(false);
  });
});
