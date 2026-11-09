/**
 * The label and priority vocabulary the MCP task, backlog and workflow commands
 * share (src/main/agent/commands/label-and-priority.ts).
 *
 * What a user loses without it: the mobile bridge reaches these handlers with
 * no zod schema in front, so `splitLabelEntries` is the only thing between a
 * malformed entry and the label colors config; and the priority helpers are
 * what let a project's own scale (renamed, extended) be set and read over MCP
 * instead of the five seeded levels.
 */
import { describe, it, expect } from 'vitest';
import {
  describePriorityScale,
  labelColorsOf,
  priorityName,
  priorityScaleError,
  priorityScaleOf,
  splitLabelEntries,
} from '../../src/main/agent/commands/label-and-priority';
import { DEFAULT_PRIORITY_CONFIG } from '../../src/shared/types';
import type { CommandContext } from '../../src/main/agent/commands/types';

const RENAMED_SCALE = [
  { label: 'Someday', color: '#6b7280' },
  { label: 'Soon', color: '#3b82f6' },
  { label: 'Now', color: '#ef4444' },
];

describe('splitLabelEntries', () => {
  it('splits plain names and colored entries', () => {
    expect(splitLabelEntries(['ui', { name: 'regression', color: '#f97316' }])).toEqual({
      names: ['ui', 'regression'],
      colors: { regression: '#f97316' },
    });
  });

  it('keeps the name but drops a color that is not a 6-digit hex', () => {
    expect(splitLabelEntries([{ name: 'bad', color: 'orange' }, { name: 'short', color: '#fff' }])).toEqual({
      names: ['bad', 'short'],
      colors: {},
    });
  });

  it('drops entries that are neither a name nor a named object', () => {
    expect(splitLabelEntries([42, null, { color: '#f97316' }, { name: '' }, 'ok'])).toEqual({ names: ['ok'], colors: {} });
  });

  it('reads null and undefined as no labels', () => {
    expect(splitLabelEntries(null)).toEqual({ names: [], colors: {} });
    expect(splitLabelEntries(undefined)).toEqual({ names: [], colors: {} });
  });
});

describe('priority scale', () => {
  it('reads the project scale, and the seeded one when the context has none', () => {
    const withScale = { getBacklogDisplayConfig: () => ({ priorities: RENAMED_SCALE, labelColors: { a: '#ef4444' } }) } as unknown as CommandContext;
    expect(priorityScaleOf(withScale)).toBe(RENAMED_SCALE);
    expect(labelColorsOf(withScale)).toEqual({ a: '#ef4444' });

    const without = {} as CommandContext;
    expect(priorityScaleOf(without)).toBe(DEFAULT_PRIORITY_CONFIG);
    expect(labelColorsOf(without)).toEqual({});
  });

  it('names a level from the scale, and a removed level by its number', () => {
    expect(priorityName(2, RENAMED_SCALE)).toBe('Now');
    expect(priorityName(7, RENAMED_SCALE)).toBe('P7');
  });

  it('accepts every index on the scale and refuses the rest with the scale listed', () => {
    for (const index of [0, 1, 2]) expect(priorityScaleError(index, RENAMED_SCALE)).toBeNull();
    for (const bad of [3, -1, 1.5, '1', null]) {
      expect(priorityScaleError(bad, RENAMED_SCALE)).toBe('Priority must be 0-2 on this project\'s scale: 0 Someday, 1 Soon, 2 Now.');
    }
  });

  it('describes the scale as one line', () => {
    expect(describePriorityScale(DEFAULT_PRIORITY_CONFIG)).toBe('0 None, 1 Low, 2 Medium, 3 High, 4 Urgent');
  });
});
