import { describe, it, expect } from 'vitest';
import {
  hasTaskFilter,
  matchesTaskFilter,
  normalizeTaskFilter,
  priorityLevelIndex,
  remapTaskFilterPriorities,
  taskFilterFromBoard,
  taskFilterFromJson,
  taskFilterToBoard,
  taskFilterToJson,
} from '../../src/shared/automation-filter';
import { DEFAULT_PRIORITY_CONFIG } from '../../src/shared/types';

const LEVELS = DEFAULT_PRIORITY_CONFIG;

describe('matchesTaskFilter', () => {
  it('matches every task when a row has no Task lines', () => {
    expect(matchesTaskFilter(null, { priority: 0, labels: null })).toBe(true);
    expect(matchesTaskFilter(undefined, { priority: 4, labels: ['bug'] })).toBe(true);
    expect(matchesTaskFilter({ priorities: [], labels: [] }, { priority: 2, labels: [] })).toBe(true);
  });

  it('checks the priority only when priorities are listed', () => {
    const filter = { priorities: [3, 4], labels: [] };
    expect(matchesTaskFilter(filter, { priority: 4, labels: null })).toBe(true);
    expect(matchesTaskFilter(filter, { priority: 2, labels: ['bug'] })).toBe(false);
  });

  it('matches a task carrying any one of the listed labels', () => {
    const filter = { priorities: [], labels: ['bug', 'ui'] };
    expect(matchesTaskFilter(filter, { priority: 0, labels: ['ui', 'other'] })).toBe(true);
    expect(matchesTaskFilter(filter, { priority: 0, labels: ['other'] })).toBe(false);
  });

  it('needs both lists to hold when both are set', () => {
    const filter = { priorities: [3], labels: ['bug'] };
    expect(matchesTaskFilter(filter, { priority: 3, labels: ['bug'] })).toBe(true);
    expect(matchesTaskFilter(filter, { priority: 3, labels: ['ui'] })).toBe(false);
    expect(matchesTaskFilter(filter, { priority: 1, labels: ['bug'] })).toBe(false);
  });

  it('fails a label filter for a task with null or missing labels', () => {
    const filter = { priorities: [], labels: ['bug'] };
    expect(matchesTaskFilter(filter, { priority: 0, labels: null })).toBe(false);
    expect(matchesTaskFilter(filter, { priority: 0, labels: undefined })).toBe(false);
  });
});

describe('normalizeTaskFilter', () => {
  it('dedupes, sorts priorities, trims labels, and keeps label order', () => {
    expect(normalizeTaskFilter({ priorities: [3, 1, 3], labels: [' ui ', 'bug', 'ui'] }))
      .toEqual({ priorities: [1, 3], labels: ['ui', 'bug'] });
  });

  it('reads no usable entry as null', () => {
    expect(normalizeTaskFilter(null)).toBeNull();
    expect(normalizeTaskFilter({ priorities: [], labels: ['  ', ''] })).toBeNull();
    expect(hasTaskFilter({ filter: { priorities: [], labels: [] } })).toBe(false);
    expect(hasTaskFilter({ filter: { priorities: [0], labels: [] } })).toBe(true);
  });

  it('drops a level that is negative, fractional or not a number', () => {
    expect(normalizeTaskFilter({ priorities: [-1, 1.5, Number.NaN, 2], labels: [] })).toEqual({ priorities: [2], labels: [] });
    expect(normalizeTaskFilter({ priorities: [-1], labels: [] })).toBeNull();
  });
});

describe('stored JSON', () => {
  it('round-trips and reads an unusable blob as none', () => {
    const json = taskFilterToJson({ priorities: [2], labels: ['bug'] });
    expect(taskFilterFromJson(json)).toEqual({ priorities: [2], labels: ['bug'] });
    expect(taskFilterToJson(null)).toBeNull();
    expect(taskFilterFromJson(null)).toBeNull();
    expect(taskFilterFromJson('not json')).toBeNull();
    expect(taskFilterFromJson('[1]')).toBeNull();
  });
});

describe('taskFilterFromBoard', () => {
  it('reads level names without regard to case or padding', () => {
    const result = taskFilterFromBoard({ priorities: ['urgent', ' High '], labels: ['bug'] }, LEVELS);
    expect(result).toEqual({ filter: { priorities: [3, 4], labels: ['bug'] }, unknownPriorities: [], malformed: false });
    expect(priorityLevelIndex('MEDIUM', LEVELS)).toBe(2);
    expect(priorityLevelIndex('  ', LEVELS)).toBeNull();
  });

  it('reports a name no level has, and keeps the names it knows', () => {
    const result = taskFilterFromBoard({ priorities: ['Low', 'Critical'] }, LEVELS);
    expect(result.unknownPriorities).toEqual(['Critical']);
    expect(result.malformed).toBe(false);
    expect(result.filter).toEqual({ priorities: [1], labels: [] });
  });

  it('reads absent as no filter', () => {
    expect(taskFilterFromBoard(undefined, LEVELS)).toEqual({ filter: null, unknownPriorities: [], malformed: false });
    expect(taskFilterFromBoard(null, LEVELS)).toEqual({ filter: null, unknownPriorities: [], malformed: false });
  });

  it('flags a shape that is not { priorities?, labels? } of strings', () => {
    for (const value of ['High', 5, ['High'], { priorities: ['High'], extra: 1 }, { priorities: 'High' }, { labels: [1] }, { priorities: [2] }]) {
      expect(taskFilterFromBoard(value, LEVELS).malformed, JSON.stringify(value)).toBe(true);
    }
  });
});

describe('taskFilterToBoard', () => {
  it('writes level names and labels', () => {
    expect(taskFilterToBoard({ priorities: [4, 3], labels: ['bug'] }, LEVELS)).toEqual({ priorities: ['High', 'Urgent'], labels: ['bug'] });
    expect(taskFilterToBoard({ priorities: [], labels: ['bug'] }, LEVELS)).toEqual({ labels: ['bug'] });
  });

  it('leaves out a level the list lacks, and is null when nothing is left', () => {
    expect(taskFilterToBoard({ priorities: [1, 9], labels: [] }, LEVELS)).toEqual({ priorities: ['Low'] });
    expect(taskFilterToBoard({ priorities: [9], labels: [] }, LEVELS)).toBeNull();
    expect(taskFilterToBoard(null, LEVELS)).toBeNull();
  });
});

describe('remapTaskFilterPriorities', () => {
  it('maps a deleted level to 0 as the Priorities editor does, and merges duplicates', () => {
    // Level 2 deleted: 0,1 stay, 2 -> 0, 3 -> 2, 4 -> 3.
    const mapping = { 0: 0, 1: 1, 2: 0, 3: 2, 4: 3 };
    expect(remapTaskFilterPriorities({ priorities: [0, 2, 4], labels: ['bug'] }, mapping))
      .toEqual({ priorities: [0, 3], labels: ['bug'] });
  });

  it('follows a reorder, keeps a level the mapping does not name, and passes null through', () => {
    expect(remapTaskFilterPriorities({ priorities: [1, 2], labels: [] }, { 1: 2, 2: 1 })).toEqual({ priorities: [1, 2], labels: [] });
    expect(remapTaskFilterPriorities({ priorities: [1], labels: [] }, { 1: 3 })).toEqual({ priorities: [3], labels: [] });
    expect(remapTaskFilterPriorities({ priorities: [4], labels: [] }, { 1: 3 })).toEqual({ priorities: [4], labels: [] });
    expect(remapTaskFilterPriorities(null, { 1: 3 })).toBeNull();
  });
});
