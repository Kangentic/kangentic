/**
 * Switching back to a project asks main to resume the tasks whose windows came
 * back. Only a task-detail window the user can see, for a task on this board,
 * counts. A window the user closed is parked (kept only for its Browser pane) and
 * a retained one belongs to a backgrounded project, so resuming either would
 * start an agent for a task nobody has open.
 *
 * Red-green: drop the `isWindowDormant` check in `resumeRestoredTasks` and the
 * parked and retained tasks are resumed too; drop the board check and the task
 * that left the board is; drop the kind check and the conversation window is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resumeRestoredTasks } from '../../src/renderer/window-manager/persistence/restore-workspace';
import { useWindowStore } from '../../src/renderer/window-manager/store/window-store';
import { useBoardStore } from '../../src/renderer/stores/board-store';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import type { Task } from '../../src/shared/types';

const PROJECT_ID = 'project-resume-restored';

describe('resumeRestoredTasks', () => {
  beforeEach(() => {
    useWindowStore.setState({ windows: {}, order: [], focusedWindowId: null });
  });

  it('resumes only a live task-detail window whose task is on the board', () => {
    const resumeOnOpen = vi.fn();
    useSessionStore.setState({ resumeOnOpen });
    // The conversation window's anchor is a board task id on purpose, so only
    // its kind keeps it out.
    useBoardStore.setState({
      tasks: ['task-live', 'task-parked', 'task-retained', 'task-conversation'].map(
        (id) => ({ id }) as Task,
      ),
    });
    const windowStore = useWindowStore.getState();
    windowStore.openWindow({ anchor: 'task-live', sessionId: null, title: 'Live' });
    windowStore.openWindow({ anchor: 'task-parked', sessionId: null, title: 'Parked', parked: true });
    windowStore.openWindow({ anchor: 'task-retained', sessionId: null, title: 'Retained' });
    useWindowStore.getState().retainWindows('another-project', ['task-retained']);
    windowStore.openWindow({ anchor: 'task-gone', sessionId: null, title: 'Gone' });
    windowStore.openWindow({
      kind: 'conversation',
      anchor: 'task-conversation',
      sessionId: 'task-conversation',
      title: 'Conversation',
    });

    resumeRestoredTasks(PROJECT_ID);

    expect(resumeOnOpen).toHaveBeenCalledTimes(1);
    expect(resumeOnOpen).toHaveBeenCalledWith('task-live', PROJECT_ID);
  });
});
