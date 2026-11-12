/**
 * Which project opens once the open one has gone (#913). A project's theme is its own, so landing on a
 * project, not on the empty state, is what keeps the app-wide default from painting. What a user loses if
 * it breaks: the app opens a project they never touched in months, or the one that was just removed.
 */
import { describe, expect, it } from 'vitest';
import { nextProjectToOpen } from '../../src/renderer/utils/next-project';
import type { Project } from '../../src/shared/types';

function project(id: string, lastOpened: string): Project {
  return { id, last_opened: lastOpened } as Project;
}

describe('nextProjectToOpen', () => {
  it('is the most recently opened project that is left', () => {
    const projects = [
      project('old', '2026-09-01T00:00:00.000Z'),
      project('recent', '2026-11-05T00:00:00.000Z'),
      project('gone', '2026-11-07T00:00:00.000Z'),
      project('middle', '2026-10-01T00:00:00.000Z'),
    ];
    expect(nextProjectToOpen(projects, 'gone')?.id).toBe('recent');
  });

  it('is never the project that went, even when it is the only one listed', () => {
    expect(nextProjectToOpen([project('gone', '2026-11-07T00:00:00.000Z')], 'gone')).toBeNull();
  });

  it('is null for an empty list, which is the empty state', () => {
    expect(nextProjectToOpen([], null)).toBeNull();
  });

  it('takes the first of two projects opened at the same moment, and any project over one never opened', () => {
    const projects = [project('never', ''), project('first', '2026-11-05T00:00:00.000Z'), project('second', '2026-11-05T00:00:00.000Z')];
    expect(nextProjectToOpen(projects, null)?.id).toBe('first');
  });
});
