/**
 * A new project inherits the last configured project's model / effort defaults.
 *
 * `default_model` / `default_effort` live on the `projects` ROW, not in
 * `.kangentic/config.json`, so the existing config-cloning path
 * (`getLastProjectOverrides`) never covered them. A new project therefore always
 * started at "Agent default" while every existing project showed a concrete
 * value - most visibly in an ephemeral `/preview` project, where the New Task
 * dialog's placeholders read differently than in the instance being previewed
 * and looked like a regression in whatever feature was under test.
 *
 * The selection rule is tested directly (it is pure) and the WIRING is pinned by
 * a source scan, because `openProjectByPath` is a heavy integration path whose
 * many collaborators would make an end-to-end test mostly mock-maintenance.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Import-time only: projects.ts reaches electron and the analytics SDK on load,
// neither of which the pure selection helper touches.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: {}, app: { getPath: vi.fn(() => '/mock') } }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

import { getLastProjectAgentDefaults } from '../../src/main/ipc/handlers/projects';
import type { Project } from '../../src/shared/types';

const HANDLER_FILE = path.join(__dirname, '../../src/main/ipc/handlers/projects.ts');

function project(overrides: Partial<Project>): Project {
  return {
    id: 'p-1',
    name: 'Existing',
    path: '/projects/existing',
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-07-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  } as Project;
}

function repo(projects: Project[]) {
  return { list: () => projects };
}

describe('getLastProjectAgentDefaults', () => {
  it('takes both values from a configured project', () => {
    const result = getLastProjectAgentDefaults(repo([
      { ...project({}), path: '/projects/old', default_model: 'opus', default_effort: 'xhigh' },
    ]));

    expect(result).toEqual({ default_model: 'opus', default_effort: 'xhigh' });
  });

  it('prefers the MOST RECENTLY opened project that has either set', () => {
    const result = getLastProjectAgentDefaults(repo([
      { ...project({}), id: 'stale', path: '/a', default_model: 'haiku', last_opened: '2026-01-01T00:00:00.000Z' },
      { ...project({}), id: 'recent', path: '/b', default_model: 'opus', last_opened: '2026-07-20T00:00:00.000Z' },
    ]));

    expect(result.default_model).toBe('opus');
  });

  it('skips projects that have configured neither', () => {
    const result = getLastProjectAgentDefaults(repo([
      { ...project({}), id: 'blank', path: '/a', last_opened: '2026-07-20T00:00:00.000Z' },
      { ...project({}), id: 'set', path: '/b', default_effort: 'high', last_opened: '2026-01-01T00:00:00.000Z' },
    ]));

    expect(result.default_effort).toBe('high');
  });

  it('carries a partially-configured project as-is rather than mixing two sources', () => {
    // Model from one project and effort from another would produce a pairing no
    // user ever chose. The most recent configured project wins wholesale.
    const result = getLastProjectAgentDefaults(repo([
      { ...project({}), id: 'recent', path: '/a', default_model: 'opus', last_opened: '2026-07-20T00:00:00.000Z' },
      { ...project({}), id: 'older', path: '/b', default_effort: 'max', last_opened: '2026-01-01T00:00:00.000Z' },
    ]));

    expect(result).toEqual({ default_model: 'opus', default_effort: null });
  });

  it('returns nulls when no project has configured either', () => {
    const result = getLastProjectAgentDefaults(repo([{ ...project({}), path: '/a' }]));

    expect(result).toEqual({ default_model: null, default_effort: null });
  });

  it('never inherits from the project being created itself', () => {
    const result = getLastProjectAgentDefaults(
      repo([{ ...project({}), path: '/projects/fresh', default_model: 'sonnet' }]),
      '/projects/fresh',
    );

    expect(result.default_model).toBeNull();
  });

  it('tolerates a null last_opened without throwing', () => {
    const result = getLastProjectAgentDefaults(repo([
      { ...project({}), path: '/a', default_model: 'opus', last_opened: null } as Project,
    ]));

    expect(result.default_model).toBe('opus');
  });
});

describe('both project-create paths seed the inherited defaults', () => {
  it('every projectRepo.create call spreads getLastProjectAgentDefaults', () => {
    // A new project can be created by opening an unregistered folder or via the
    // PROJECT_CREATE handler. Seeding one and not the other is invisible until a
    // user notices two projects that should match do not.
    const source = fs.readFileSync(HANDLER_FILE, 'utf-8');
    const createCalls = source.split('projectRepo.create(').slice(1);

    expect(createCalls.length, 'expected both create sites to still exist').toBe(2);
    for (const call of createCalls) {
      const callArgs = call.slice(0, call.indexOf('});') + 1);
      expect(
        callArgs,
        'a projectRepo.create() that does not spread getLastProjectAgentDefaults(...) '
        + 'starts the project on "Agent default" while its siblings carry a concrete model/effort',
      ).toContain('getLastProjectAgentDefaults(');
    }
  });
});
