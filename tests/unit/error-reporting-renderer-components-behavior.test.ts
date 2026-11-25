/**
 * What a user loses if these reports go quiet: a Command Terminal whose Stop fails
 * behind a closed window, annotations that never reach disk, a Diff mode that says
 * it could not compare any image, and an archive or send to backlog that did nothing
 * all reach us only as "it did not work", with no error name to look for.
 *
 * Each case runs the real function and drives its catch with a throwing dependency,
 * then asserts the call to `reportRendererFailure` (mocked here, so its area,
 * operation and error are what is checked). The area and operation are fixed words:
 * the cases that carry a task title or a note assert it stays out of them.
 *
 * Only the sites that live in a plain module, or are reachable as a plain function,
 * are here. The unit tier has no DOM, so the catches inside a hook's effect or a
 * component's handler (BrowserPane, the annotations load, the drawing overlay, the
 * Board Manager's save, CommandTerminalWindow, NewTaskDialog, the conversation's
 * live poll, the description paste, MarkdownRenderer, LanguageSuggestion, the icon
 * picker, the settings write and the Knowledge Graph's scene effect) cannot be
 * driven from this tier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const electronApi = {
    sessions: { killTransient: vi.fn(async (): Promise<void> => undefined) },
    browser: {
      saveAnnotations: vi.fn(async (): Promise<void> => undefined),
      discardAnnotations: vi.fn(async (): Promise<void> => undefined),
    },
  };
  // The stores and the modules under test read `window.electronAPI` at call time,
  // and a few read `window` as they load, so it exists before any import runs.
  (globalThis as Record<string, unknown>).window = { electronAPI: electronApi };
  // One mock for every instance of the reporter module: the pixel diff cases load
  // their module afresh, and a mock made in the factory would be a new one each time.
  return { electronApi, reportRendererFailure: vi.fn<(...report: unknown[]) => boolean>(() => true) };
});

vi.mock('../../src/renderer/utils/renderer-failure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/utils/renderer-failure')>()),
  reportRendererFailure: hoisted.reportRendererFailure,
}));

import { killCommandTerminalInSlot } from '../../src/renderer/components/command-bar/stop-command-terminal';
import type { DecodedImageSide } from '../../src/renderer/components/dialogs/task-detail/changes/diff-content';
import {
  snapshotDiffViewer,
  type DiffViewerSnapshotState,
  type SnapshotDiffEditor,
} from '../../src/renderer/components/dialogs/task-detail/changes/diff-viewer-snapshot';
import { persistSession } from '../../src/renderer/components/browser/annotations/useBrowserAnnotations';
import { EMPTY_SESSION, addStroke } from '../../src/renderer/components/browser/annotations/annotation-model';
import { reportTaskActionFailure } from '../../src/renderer/components/dialogs/task-detail/useTaskActions';
import {
  WebglRendererUnavailableError,
  createKnowledgeGraphScene,
} from '../../src/renderer/components/knowledge-graph/knowledge-graph-scene';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { transientKey } from '../../src/renderer/stores/session-store/transient-session-slice';
import { useToastStore } from '../../src/renderer/stores/toast-store';
import type { Project } from '../../src/shared/types';

const reportMock = hoisted.reportRendererFailure;
const electronApi = hoisted.electronApi;

/** A title only a user would write, so a leak into a tag is recognisable. */
const USER_TITLE = 'Fix Acme billing';

function clearToasts(): void {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismissToast(toast.id);
}

/** The fixed words of every report made so far: what becomes tags and the fingerprint. */
function reportedWords(): string {
  return JSON.stringify(reportMock.mock.calls.map((call) => call.slice(0, 2)));
}

beforeEach(() => {
  reportMock.mockClear();
  clearToasts();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('stopping a Command Terminal', () => {
  const realKill = useSessionStore.getState().killTransientSessionBySlot;
  const project = { id: 'project-a', name: 'project-a', path: '/mock/project-a' } as Project;

  beforeEach(() => {
    useProjectStore.setState({ currentProject: project });
    useSessionStore.setState({ killTransientSessionBySlot: realKill, transientSessions: {} });
    electronApi.sessions.killTransient.mockReset();
    electronApi.sessions.killTransient.mockResolvedValue(undefined);
  });

  afterEach(() => {
    useSessionStore.setState({ killTransientSessionBySlot: realKill, transientSessions: {} });
  });

  it('reports a throw from the store as command_terminal/stop and says the terminal may still run', async () => {
    const failure = new TypeError('renderer-side defect');
    useSessionStore.setState({ killTransientSessionBySlot: async () => { throw failure; } });

    await killCommandTerminalInSlot('slot-1');

    expect(reportMock).toHaveBeenCalledWith('command_terminal', 'stop', failure);
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe("Couldn't stop the terminal");
  });

  it('reports nothing for a kill main rejected, which the store answers as failed', async () => {
    useSessionStore.setState({
      transientSessions: {
        [transientKey('project-a', 'slot-1')]: { projectId: 'project-a', slot: 'slot-1', sessionId: 'terminal-1', branch: 'main' },
      },
    });
    electronApi.sessions.killTransient.mockRejectedValue(new Error('main refused'));

    await killCommandTerminalInSlot('slot-1');

    expect(electronApi.sessions.killTransient).toHaveBeenCalledWith('terminal-1');
    expect(reportMock).not.toHaveBeenCalled();
    // The user is still told: the toast is the store's 'failed' answer.
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(["Couldn't stop the terminal"]);
  });

  it('reports nothing and says nothing when the stop lands', async () => {
    useSessionStore.setState({
      transientSessions: {
        [transientKey('project-a', 'slot-1')]: { projectId: 'project-a', slot: 'slot-1', sessionId: 'terminal-1', branch: 'main' },
      },
    });

    await killCommandTerminalInSlot('slot-1');

    expect(reportMock).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe('the pixel diff client', () => {
  /** The worker's side of the wire, as the client sees it. */
  interface FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    posted: Array<{ id: number }>;
  }

  function side(): DecodedImageSide {
    return { kind: 'image', size: 64, dataUrl: 'data:image/png;base64,AAAA', width: 2, height: 2 };
  }

  /** The client holds one worker per module instance, so each case loads its own. */
  async function loadClient() {
    vi.resetModules();
    return import('../../src/renderer/components/dialogs/task-detail/changes/pixel-diff-client');
  }

  /** A worker that starts and records what it was sent. The Vite worker import builds its worker through this global. */
  function stubRunningWorker(): FakeWorker[] {
    const workers: FakeWorker[] = [];
    vi.stubGlobal('Worker', class implements FakeWorker {
      onmessage: FakeWorker['onmessage'] = null;
      onerror: FakeWorker['onerror'] = null;
      posted: FakeWorker['posted'] = [];
      constructor() {
        workers.push(this);
      }
      postMessage(request: { id: number }): void {
        this.posted.push(request);
      }
      terminate(): void {
        // Nothing to end: this worker never ran.
      }
    });
    return workers;
  }

  it('reports a worker that cannot be built as changes/pixel_diff_worker and answers failed', async () => {
    const failure = new Error('worker could not be built');
    vi.stubGlobal('Worker', class {
      constructor() {
        throw failure;
      }
    });
    const { computePixelDiff } = await loadClient();

    const outcome = await computePixelDiff(side(), side(), false);

    expect(outcome).toEqual({ status: 'failed' });
    expect(reportMock).toHaveBeenCalledWith('changes', 'pixel_diff_worker', failure);
  });

  it('reports a worker that raises an error event as changes/pixel_diff_worker, with a fixed error', async () => {
    const workers = stubRunningWorker();
    const { computePixelDiff } = await loadClient();
    const pending = computePixelDiff(side(), side(), false);
    await vi.waitFor(() => expect(workers[0]?.posted).toHaveLength(1));

    workers[0].onerror?.();

    expect(await pending).toEqual({ status: 'failed' });
    expect(reportMock).toHaveBeenCalledTimes(1);
    const [area, operation, error] = reportMock.mock.calls[0];
    expect([area, operation]).toEqual(['changes', 'pixel_diff_worker']);
    expect((error as Error).name).toBe('PixelDiffWorkerError');
    expect((error as Error).message).toBe('The pixel diff worker raised an error event.');
  });

  it('reports a comparison the worker failed as changes/pixel_diff_compare, under the class name it relayed', async () => {
    const workers = stubRunningWorker();
    const { computePixelDiff } = await loadClient();
    const pending = computePixelDiff(side(), side(), false);
    await vi.waitFor(() => expect(workers[0]?.posted).toHaveLength(1));

    workers[0].onmessage?.({ data: { id: workers[0].posted[0].id, ok: false, errorName: 'RangeError' } });

    expect(await pending).toEqual({ status: 'failed' });
    expect(reportMock).toHaveBeenCalledTimes(1);
    const [area, operation, error] = reportMock.mock.calls[0];
    expect([area, operation]).toEqual(['changes', 'pixel_diff_compare']);
    expect((error as Error).name).toBe('RangeError');
    expect((error as Error).message).toBe('The pixel diff worker could not compare a pair.');
  });

  it('reports nothing for a comparison the worker finished', async () => {
    const workers = stubRunningWorker();
    const { computePixelDiff } = await loadClient();
    const pending = computePixelDiff(side(), side(), false);
    await vi.waitFor(() => expect(workers[0]?.posted).toHaveLength(1));

    workers[0].onmessage?.({
      data: { id: workers[0].posted[0].id, ok: true, maskUrl: 'data:image/png;base64,BBBB', changedPixels: 1, totalPixels: 4 },
    });

    expect(await pending).toEqual({ status: 'done', maskUrl: 'data:image/png;base64,BBBB', changedPixels: 1, totalPixels: 4 });
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('reports nothing for a pair too large to compare, which is not a failure of the worker', async () => {
    const { computePixelDiff } = await loadClient();
    const huge: DecodedImageSide = { kind: 'image', size: 64, dataUrl: 'data:image/png;base64,AAAA', width: 9000, height: 9000 };

    const outcome = await computePixelDiff(huge, side(), false);

    expect(outcome).toEqual({ status: 'failed' });
    expect(reportMock).not.toHaveBeenCalled();
  });
});

describe('the pixel diff worker', () => {
  it('relays the class name of a comparison that throws, and never its message', async () => {
    const postMessage = vi.fn();
    const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: typeof postMessage } = {
      onmessage: null,
      postMessage,
    };
    // The worker module reads its scope from `self` as it loads.
    vi.stubGlobal('self', scope);
    // A canvas the machine cannot allocate, whose message quotes what a user wrote.
    vi.stubGlobal('OffscreenCanvas', class {
      constructor() {
        throw new RangeError(`Array buffer allocation failed for '${USER_TITLE}'`);
      }
    });
    vi.resetModules();
    await import('../../src/renderer/components/dialogs/task-detail/changes/pixel-diff.worker');
    // Bitmaps the main thread decoded, as an SVG pair arrives: nothing to fetch.
    const bitmap = { close: () => undefined };

    scope.onmessage?.({ data: { id: 7, before: bitmap, after: bitmap, width: 2, height: 2, color: [255, 60, 199] } });

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenCalledWith({ id: 7, ok: false, errorName: 'RangeError' });
    expect(JSON.stringify(postMessage.mock.calls)).not.toMatch(/acme/i);
  });
});

describe('the diff viewer snapshot sent with a monaco report', () => {
  const STATE: DiffViewerSnapshotState = {
    viewMode: 'split',
    language: 'typescript',
    hideUnchangedRegions: true,
    foldReenablePending: false,
    foldReenableInProgress: true,
    contentMatches: true,
  };

  function fakeSubEditor(visibleRanges: () => Array<{ startLineNumber: number; endLineNumber: number }>) {
    return {
      getModel: () => ({ getLineCount: () => 10 }),
      getScrollTop: () => 0,
      getScrollHeight: () => 100,
      getLayoutInfo: () => ({ height: 50 }),
      getVisibleRanges: visibleRanges,
      getDomNode: () => ({ closest: () => null }),
    };
  }

  it('records the name of an error a read threw, and never its message', () => {
    // V8 quotes the property it could not read, which here is a task title.
    const original = fakeSubEditor(() => {
      throw new TypeError(`Cannot read properties of undefined (reading '${USER_TITLE}')`);
    });
    const modified = fakeSubEditor(() => [{ startLineNumber: 1, endLineNumber: 5 }]);
    const diffEditor = {
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      getLineChanges: () => [],
    } as unknown as SnapshotDiffEditor;

    const snapshot = snapshotDiffViewer(diffEditor, STATE);

    expect(snapshot.original_visible_ranges).toBe('threw: TypeError');
    expect(snapshot.modified_visible_ranges).toBe('1-5');
    expect(JSON.stringify(snapshot)).not.toMatch(/acme/i);
  });

  it('records a thrown non-Error value as NonError, without its text', () => {
    const original = fakeSubEditor(() => {
      // A non-Error throw is the case under test.
      throw USER_TITLE;
    });
    const diffEditor = {
      getOriginalEditor: () => original,
      getModifiedEditor: () => fakeSubEditor(() => []),
      getLineChanges: () => [],
    } as unknown as SnapshotDiffEditor;

    const snapshot = snapshotDiffViewer(diffEditor, STATE);

    expect(snapshot.original_visible_ranges).toBe('threw: NonError');
    expect(JSON.stringify(snapshot)).not.toMatch(/acme/i);
  });
});

describe('saving the Browser pane annotations', () => {
  function drawnSession() {
    let nextId = 0;
    return addStroke(EMPTY_SESSION, [{ x: 1, y: 1 }, { x: 4, y: 4 }], 'http://localhost:5173/', () => `id-${nextId++}`, USER_TITLE);
  }

  beforeEach(() => {
    electronApi.browser.saveAnnotations.mockReset();
    electronApi.browser.saveAnnotations.mockResolvedValue(undefined);
    electronApi.browser.discardAnnotations.mockReset();
    electronApi.browser.discardAnnotations.mockResolvedValue(undefined);
  });

  it('reports a failed save of drawn annotations as browser/annotations_save', async () => {
    const failure = new Error('An object could not be cloned.');
    electronApi.browser.saveAnnotations.mockRejectedValue(failure);
    const session = drawnSession();
    expect(session.annotations).toHaveLength(1);

    persistSession('task-a', 'project-a', session);

    await vi.waitFor(() => expect(reportMock).toHaveBeenCalledWith('browser', 'annotations_save', failure));
    expect(electronApi.browser.discardAnnotations).not.toHaveBeenCalled();
    // The note the user typed rides the IPC payload, never the report's words.
    expect(reportedWords()).not.toMatch(/acme/i);
  });

  it('reports a failed discard of an emptied session as browser/annotations_save', async () => {
    const failure = new Error("No handler registered for 'browser:discardAnnotations'");
    electronApi.browser.discardAnnotations.mockRejectedValue(failure);

    persistSession('task-a', 'project-a', EMPTY_SESSION);

    await vi.waitFor(() => expect(reportMock).toHaveBeenCalledWith('browser', 'annotations_save', failure));
    expect(electronApi.browser.saveAnnotations).not.toHaveBeenCalled();
  });

  it('reports nothing when the save lands', async () => {
    persistSession('task-a', 'project-a', drawnSession());

    await vi.waitFor(() => expect(electronApi.browser.saveAnnotations).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(reportMock).not.toHaveBeenCalled();
  });
});

describe('a task action that fails after its window closed', () => {
  it.each([
    ['archive', "Couldn't archive task"],
    ['send_to_backlog', "Couldn't send to backlog"],
  ] as const)('reports %s as task_detail and keeps the task title in the toast alone', (operation, toastTitle) => {
    const failure = new Error(`could not move "${USER_TITLE}"`);

    reportTaskActionFailure(operation, { id: 'task-a', title: USER_TITLE, projectId: 'project-a' }, failure);

    expect(reportMock).toHaveBeenCalledWith('task_detail', operation, failure);
    expect(reportMock.mock.calls[0]).toHaveLength(3);
    expect(reportedWords()).not.toMatch(/acme/i);
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe(toastTitle);
    expect(toasts[0].message).toContain(USER_TITLE);
  });
});

describe('a Knowledge Graph map on a machine with no WebGL', () => {
  it('throws WebglRendererUnavailableError, the class the scene hook does not report', () => {
    // three logs the failure before it throws.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const canvas = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;

    expect(() => createKnowledgeGraphScene({
      canvas,
      nodes: [],
      edges: [],
      edgeColor: '#888888',
      regionOf: () => 0,
    })).toThrow(WebglRendererUnavailableError);
  });
});
