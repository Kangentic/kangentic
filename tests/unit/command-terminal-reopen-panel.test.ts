/**
 * Coverage for `reopenCommandTerminalPanelAfterRestart` (reopen-panel.ts): the
 * renderer's half of "a running Command Terminal comes back after a restart".
 *
 * `AppConfig.commandTerminalOpenProjectId` records where the panel was showing
 * at quit. After the project's board has loaded, the panel reopens only when:
 *
 *  - the record names THIS project;
 *  - main's restore has settled (the wait), and that project is still current;
 *  - the panel is not already showing;
 *  - at least one Command Terminal of the project came back.
 *
 * With nothing back the record is forgotten, since a reopened panel would start
 * a fresh terminal and run a cold start's checkout with nobody at the desk.
 * Armed means two things: `setPendingOpenCommandTerminal(true)` (useCommandBar
 * then runs its own open) and the flat-paint flag (`restore-no-animation-replay.md`).
 *
 * The unit tier has no jsdom, so `window.electronAPI` is stubbed before the
 * stores are imported. The wait is a promise the test settles, which lets a
 * project switch land in the middle of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const configSetMock = vi.fn();
const waitForRestoreMock = vi.fn<(projectId: string) => Promise<boolean | undefined>>();

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: { set: configSetMock },
    sessions: { waitForCommandTerminalRestore: waitForRestoreMock },
  },
};

import {
  reopenCommandTerminalPanelAfterRestart,
  isPanelEnterSkipped,
  clearPanelEnterSkip,
  RESTORE_WAIT_EXTRA_ASKS,
} from '../../src/renderer/components/command-bar/reopen-panel';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { DEFAULT_CONFIG, type Project, type Session } from '../../src/shared/types';

const PROJECT_ID = 'proj-restored';
const OTHER_PROJECT_ID = 'proj-other';

function makeProject(id: string): Project {
  return {
    id,
    name: id,
    path: `/mock/${id}`,
    github_url: null,
    default_agent: 'claude',
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  } as Project;
}

function makeTerminal(overrides: Partial<Session> & { id: string }): Session {
  return {
    taskId: `tag-${overrides.id}`,
    projectId: PROJECT_ID,
    pid: 1234,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    exitCode: null,
    resuming: false,
    agentSessionId: null,
    transient: true,
    commandTerminalSlot: 'slot-1',
    ...overrides,
  };
}

function recordOpenProject(projectId: string | null): void {
  const config = { ...DEFAULT_CONFIG, commandTerminalOpenProjectId: projectId };
  useConfigStore.setState({ config, globalConfig: config });
}

/** A wait the test settles by hand. */
function holdRestoreWait(): { resolve: () => void; reject: () => void } {
  let resolve!: () => void;
  let reject!: () => void;
  waitForRestoreMock.mockReturnValueOnce(new Promise<boolean | undefined>((resolveWait, rejectWait) => {
    resolve = () => resolveWait(true);
    reject = () => rejectWait(new Error('main cannot say'));
  }));
  return { resolve, reject };
}

describe('reopenCommandTerminalPanelAfterRestart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPanelEnterSkip();
    waitForRestoreMock.mockReset();
    waitForRestoreMock.mockResolvedValue(undefined);
    recordOpenProject(PROJECT_ID);
    useProjectStore.setState({ currentProject: makeProject(PROJECT_ID) });
    useSessionStore.setState({
      sessions: [makeTerminal({ id: 'restored-1' })],
      commandBarVisible: false,
      commandBarOpening: false,
      _pendingOpenCommandTerminal: false,
    });
  });

  describe('reopens', () => {
    it('arms the open and the flat paint when a terminal came back, and keeps the record', async () => {
      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(true);
      expect(isPanelEnterSkipped()).toBe(true);
      expect(useSessionStore.getState().commandBarOpening).toBe(false);
      expect(configSetMock).not.toHaveBeenCalled();
      expect(useConfigStore.getState().globalConfig.commandTerminalOpenProjectId).toBe(PROJECT_ID);
    });

    it('asks main for this project, and shows the opening state only for the wait', async () => {
      const wait = holdRestoreWait();
      const reopening = reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(waitForRestoreMock).toHaveBeenCalledWith(PROJECT_ID);
      expect(useSessionStore.getState().commandBarOpening).toBe(true);
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);

      wait.resolve();
      await reopening;

      expect(useSessionStore.getState().commandBarOpening).toBe(false);
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(true);
    });

    it('a queued terminal counts: it holds its slot and its window', async () => {
      useSessionStore.setState({ sessions: [makeTerminal({ id: 'queued-1', status: 'queued' })] });

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(true);
    });

    it('a wait main could not answer does not decide: the live terminals do', async () => {
      const wait = holdRestoreWait();
      const reopening = reopenCommandTerminalPanelAfterRestart(PROJECT_ID);
      wait.reject();
      await reopening;

      expect(useSessionStore.getState().commandBarOpening).toBe(false);
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(true);
      expect(isPanelEnterSkipped()).toBe(true);
    });
  });

  describe('forgets the record when nothing came back', () => {
    async function expectForgotten(): Promise<void> {
      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(isPanelEnterSkipped()).toBe(false);
      expect(configSetMock).toHaveBeenCalledTimes(1);
      expect(configSetMock).toHaveBeenCalledWith({ commandTerminalOpenProjectId: null });
      expect(useConfigStore.getState().globalConfig.commandTerminalOpenProjectId).toBeNull();
    }

    it('with no terminal at all', async () => {
      useSessionStore.setState({ sessions: [] });
      await expectForgotten();
    });

    it('with only an exited terminal', async () => {
      useSessionStore.setState({ sessions: [makeTerminal({ id: 'ended-1', status: 'exited' })] });
      await expectForgotten();
    });

    it('with terminals only in another project', async () => {
      useSessionStore.setState({ sessions: [makeTerminal({ id: 'elsewhere-1', projectId: OTHER_PROJECT_ID })] });
      await expectForgotten();
    });

    it('with only a workflow agent, which is transient but no Command Terminal', async () => {
      useSessionStore.setState({ sessions: [makeTerminal({ id: 'workflow-agent-1', workflowId: 'wf-1' })] });
      await expectForgotten();
    });

    it('with only a task session', async () => {
      useSessionStore.setState({
        sessions: [makeTerminal({ id: 'task-agent-1', transient: undefined, commandTerminalSlot: undefined })],
      });
      await expectForgotten();
    });

    it('after a wait that failed, since the live check still decides', async () => {
      useSessionStore.setState({ sessions: [] });
      const wait = holdRestoreWait();
      const reopening = reopenCommandTerminalPanelAfterRestart(PROJECT_ID);
      wait.reject();
      await reopening;

      expect(configSetMock).toHaveBeenCalledWith({ commandTerminalOpenProjectId: null });
      expect(useSessionStore.getState().commandBarOpening).toBe(false);
    });
  });

  // Main's wait gives up at a ceiling and answers false. A restore slower than
  // that used to end here with the panel shut and the record erased, and the
  // terminals came back a moment later with nothing to show them.
  describe('a restore still running at main\'s ceiling', () => {
    it('asks again, and reopens over the terminal once it is back', async () => {
      useSessionStore.setState({ sessions: [] });
      waitForRestoreMock.mockReset();
      waitForRestoreMock.mockResolvedValueOnce(false);
      waitForRestoreMock.mockImplementationOnce(async () => {
        // The restore finishes during the second wait: its terminal is in the replica.
        useSessionStore.setState({ sessions: [makeTerminal({ id: 'restored-late' })] });
        return true;
      });

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(waitForRestoreMock).toHaveBeenCalledTimes(2);
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(true);
      expect(isPanelEnterSkipped()).toBe(true);
      expect(configSetMock).not.toHaveBeenCalled();
      expect(useConfigStore.getState().globalConfig.commandTerminalOpenProjectId).toBe(PROJECT_ID);
    });

    it('shows the opening state only for the first wait', async () => {
      useSessionStore.setState({ sessions: [] });
      waitForRestoreMock.mockReset();
      waitForRestoreMock.mockResolvedValueOnce(false);
      let openingDuringSecondWait: boolean | null = null;
      waitForRestoreMock.mockImplementationOnce(async () => {
        openingDuringSecondWait = useSessionStore.getState().commandBarOpening;
        return true;
      });

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(openingDuringSecondWait).toBe(false);
    });

    it('keeps the record when it gives up with the restore still running and nothing back', async () => {
      useSessionStore.setState({ sessions: [] });
      waitForRestoreMock.mockReset();
      waitForRestoreMock.mockResolvedValue(false);

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      // The first wait, then the bounded extra asks: it does not wait for ever.
      expect(waitForRestoreMock).toHaveBeenCalledTimes(1 + RESTORE_WAIT_EXTRA_ASKS);
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(configSetMock).not.toHaveBeenCalled();
      expect(useConfigStore.getState().globalConfig.commandTerminalOpenProjectId).toBe(PROJECT_ID);
    });

    it('forgets the record once the restore is over with nothing back', async () => {
      useSessionStore.setState({ sessions: [] });
      waitForRestoreMock.mockReset();
      waitForRestoreMock.mockResolvedValueOnce(false);
      waitForRestoreMock.mockResolvedValueOnce(true);

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(waitForRestoreMock).toHaveBeenCalledTimes(2);
      expect(configSetMock).toHaveBeenCalledWith({ commandTerminalOpenProjectId: null });
    });

    it('stops asking once the project is left', async () => {
      useSessionStore.setState({ sessions: [] });
      waitForRestoreMock.mockReset();
      waitForRestoreMock.mockImplementationOnce(async () => {
        useProjectStore.setState({ currentProject: makeProject(OTHER_PROJECT_ID) });
        return false;
      });

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(waitForRestoreMock).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(configSetMock).not.toHaveBeenCalled();
    });
  });

  describe('does nothing', () => {
    it('when the record names another project: no wait, no spinner, the record left alone', async () => {
      recordOpenProject(OTHER_PROJECT_ID);

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(waitForRestoreMock).not.toHaveBeenCalled();
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(isPanelEnterSkipped()).toBe(false);
      expect(configSetMock).not.toHaveBeenCalled();
      expect(useConfigStore.getState().globalConfig.commandTerminalOpenProjectId).toBe(OTHER_PROJECT_ID);
    });

    it('when the panel was not showing at quit', async () => {
      recordOpenProject(null);

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(waitForRestoreMock).not.toHaveBeenCalled();
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(configSetMock).not.toHaveBeenCalled();
    });

    it('when the project was left during the wait: not armed, the spinner down, the record kept', async () => {
      const wait = holdRestoreWait();
      const reopening = reopenCommandTerminalPanelAfterRestart(PROJECT_ID);
      expect(useSessionStore.getState().commandBarOpening).toBe(true);

      useProjectStore.setState({ currentProject: makeProject(OTHER_PROJECT_ID) });
      wait.resolve();
      await reopening;

      expect(useSessionStore.getState().commandBarOpening).toBe(false);
      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(isPanelEnterSkipped()).toBe(false);
      expect(configSetMock).not.toHaveBeenCalled();
    });

    it('when no project is open by the time the wait ends', async () => {
      const wait = holdRestoreWait();
      const reopening = reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      useProjectStore.setState({ currentProject: null });
      wait.resolve();
      await reopening;

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(isPanelEnterSkipped()).toBe(false);
    });

    it('when the panel is already showing: it is not asked to open again, nor painted flat', async () => {
      useSessionStore.setState({ commandBarVisible: true });

      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(isPanelEnterSkipped()).toBe(false);
      expect(configSetMock).not.toHaveBeenCalled();
    });

    it('when the user opened the panel during the wait', async () => {
      const wait = holdRestoreWait();
      const reopening = reopenCommandTerminalPanelAfterRestart(PROJECT_ID);

      useSessionStore.setState({ commandBarVisible: true });
      wait.resolve();
      await reopening;

      expect(useSessionStore.getState()._pendingOpenCommandTerminal).toBe(false);
      expect(isPanelEnterSkipped()).toBe(false);
    });
  });

  describe('the flat-paint flag', () => {
    it('stays set until the restored panel clears it, so the next open fades in', async () => {
      await reopenCommandTerminalPanelAfterRestart(PROJECT_ID);
      expect(isPanelEnterSkipped()).toBe(true);

      clearPanelEnterSkip();

      expect(isPanelEnterSkipped()).toBe(false);
    });
  });
});
