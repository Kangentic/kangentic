/**
 * Unit tests for `resolveSettingsProject`, the one answer to "which project is
 * the Settings panel editing".
 *
 * Settings > Agent > Project defaults used to bind to the board's
 * `currentProject` while the panel's project switcher moved
 * `projectSettingsPath`, so the tab showed and wrote the board project's row
 * whatever the switcher said. The resolver's load-bearing property is that it
 * never answers with a DIFFERENT project than the one the panel targets.
 */
import { describe, it, expect } from 'vitest';
import { resolveSettingsProject } from '../../src/renderer/components/settings/settings-target-project';
import type { Project } from '../../src/shared/types';

function makeProject(id: string, projectPath: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    path: projectPath,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-10-03T00:00:00.000Z',
    created_at: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

const alpha = makeProject('alpha', '/mock/alpha', { default_model: 'opus' });
const beta = makeProject('beta', '/mock/beta', { default_model: 'sonnet' });

describe('resolveSettingsProject', () => {
  it('is null with no target path and no open project', () => {
    expect(resolveSettingsProject({ projectSettingsPath: null, currentProject: null, projects: [alpha, beta] })).toBeNull();
  });

  it('targets the open project when the panel was opened with no path', () => {
    expect(resolveSettingsProject({ projectSettingsPath: null, currentProject: alpha, projects: [alpha, beta] })).toBe(alpha);
  });

  it('targets the switcher pick, not the board project', () => {
    expect(
      resolveSettingsProject({ projectSettingsPath: beta.path, currentProject: alpha, projects: [alpha, beta] }),
      'the board is on alpha but the panel targets beta; answering alpha is the original bug',
    ).toBe(beta);
  });

  it('is null, never the open project, when the target path matches no row', () => {
    expect(
      resolveSettingsProject({ projectSettingsPath: '/mock/gone', currentProject: alpha, projects: [alpha, beta] }),
      'a fallback to the board project would send this panel\'s writes to the wrong project',
    ).toBeNull();
  });

  it('prefers the open project over its own list row when both match the target', () => {
    const staleRow = makeProject('alpha', '/mock/alpha', { default_model: 'opus' });
    const freshCurrent = makeProject('alpha', '/mock/alpha', { default_model: 'haiku' });
    expect(
      resolveSettingsProject({ projectSettingsPath: alpha.path, currentProject: freshCurrent, projects: [staleRow, beta] }),
      'currentProject is the copy every other renderer reader of the board project uses',
    ).toBe(freshCurrent);
  });

  it('still targets the open project when the list is empty', () => {
    expect(resolveSettingsProject({ projectSettingsPath: alpha.path, currentProject: alpha, projects: [] })).toBe(alpha);
  });

  it('is null for a target missing from an empty list with no open project', () => {
    expect(resolveSettingsProject({ projectSettingsPath: beta.path, currentProject: null, projects: [] })).toBeNull();
  });
});
