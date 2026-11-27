/**
 * `resumeSessionsAfterProgramUpdate` (src/main/ipc/handlers/projects.ts): brings back the agents a host
 * program update suspended, project by project. A user loses their agents staying suspended if one
 * project's failure stops the rest, so each project is tried and the first failure is thrown last.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async () => undefined),
  autoSpawnTasks: vi.fn(async () => undefined),
}));

vi.mock('../../src/main/shutdown-state', () => ({
  isShuttingDown: vi.fn(() => false),
}));

vi.mock('../../src/main/diagnostics/project-log-context', () => ({
  runWithProjectLogContext: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

import { resumeSessionsAfterProgramUpdate } from '../../src/main/ipc/handlers/projects';
import { resumeSuspendedSessions } from '../../src/main/transition-engine/session-startup';
import { isShuttingDown } from '../../src/main/shutdown-state';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { ResumeSuspendedOptions } from '../../src/main/transition-engine/session-startup';
import type { Project } from '../../src/shared/types';

function makeProject(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    path: `/mock/${id}`,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function buildContext(projects: Project[]): IpcContext {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return {
    projectRepo: { getById: vi.fn((projectId: string) => byId.get(projectId)) },
    sessionManager: {},
    configManager: {},
    boardConfigManager: {
      getBoardProfiles: vi.fn(() => []),
      getDefaultBaseBranchForPath: vi.fn(() => undefined),
    },
    mcpServerHandle: null,
  } as unknown as IpcContext;
}

function resumedProjectIds(): string[] {
  return vi.mocked(resumeSuspendedSessions).mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resumeSuspendedSessions).mockImplementation(async () => undefined);
  vi.mocked(isShuttingDown).mockReturnValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('resumeSessionsAfterProgramUpdate', () => {
  it('resumes each project with resumeRegardless and only that project\'s own session ids', async () => {
    const context = buildContext([makeProject('project-a'), makeProject('project-b')]);
    const idsA = new Set(['session-a1', 'session-a2']);
    const idsB = new Set(['session-b1']);

    await resumeSessionsAfterProgramUpdate(context, new Map([['project-a', idsA], ['project-b', idsB]]));

    const calls = vi.mocked(resumeSuspendedSessions).mock.calls;
    expect(calls.map((call) => call[0])).toEqual(['project-a', 'project-b']);
    const optionsOf = (index: number): ResumeSuspendedOptions => calls[index][9] as ResumeSuspendedOptions;
    expect(optionsOf(0).resumeRegardless).toBe(true);
    expect(optionsOf(0).onlySessionIds).toEqual(idsA);
    expect(optionsOf(1).resumeRegardless).toBe(true);
    expect(optionsOf(1).onlySessionIds).toEqual(idsB);
  });

  it('still resumes the second project when the first throws, then rejects with the first error', async () => {
    const context = buildContext([makeProject('project-a'), makeProject('project-b')]);
    const firstError = new Error('first project failed');
    vi.mocked(resumeSuspendedSessions).mockImplementation(async (projectId: string) => {
      if (projectId === 'project-a') throw firstError;
      throw new Error('second project failed');
    });

    await expect(
      resumeSessionsAfterProgramUpdate(context, new Map([['project-a', new Set(['s1'])], ['project-b', new Set(['s2'])]])),
    ).rejects.toBe(firstError);

    expect(resumedProjectIds()).toEqual(['project-a', 'project-b']);
  });

  it('resolves when every project resumes, and rejects with nothing lost when only a later one fails', async () => {
    const context = buildContext([makeProject('project-a'), makeProject('project-b')]);
    const laterError = new Error('later project failed');
    vi.mocked(resumeSuspendedSessions).mockImplementation(async (projectId: string) => {
      if (projectId === 'project-b') throw laterError;
    });

    await expect(
      resumeSessionsAfterProgramUpdate(context, new Map([['project-a', new Set(['s1'])], ['project-b', new Set(['s2'])]])),
    ).rejects.toBe(laterError);
    expect(resumedProjectIds()).toEqual(['project-a', 'project-b']);
  });

  it('skips a project id the repository no longer holds', async () => {
    const context = buildContext([makeProject('project-b')]);

    await resumeSessionsAfterProgramUpdate(context, new Map([['project-gone', new Set(['s1'])], ['project-b', new Set(['s2'])]]));

    expect(resumedProjectIds()).toEqual(['project-b']);
  });

  it('resumes nothing once the app is shutting down', async () => {
    vi.mocked(isShuttingDown).mockReturnValue(true);
    const context = buildContext([makeProject('project-a')]);

    await resumeSessionsAfterProgramUpdate(context, new Map([['project-a', new Set(['s1'])]]));

    expect(resumeSuspendedSessions).not.toHaveBeenCalled();
  });
});
