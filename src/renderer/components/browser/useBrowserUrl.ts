import { useCallback, useEffect, useRef, useState } from 'react';
import { useToastStore } from '../../stores/toast-store';

// Resolves the effective URL for a task's Browser pane and exposes
// save/recordNavigation helpers.
//
// Resolution: taskOverride > projectDefault > null (caller renders empty state).
//
// Auto-save model (simplified per UX feedback):
// - Every successful navigation silently updates the task URL. Task URL is
//   effectively "what this task was last looking at"; on resume the pane
//   loads exactly that.
// - The very first navigation in a project that has no project default also
//   sets the project default (one-time, with a toast). New tasks then
//   inherit that default until they navigate to something else.
// - Project default never changes again automatically. The only explicit
//   action in the UI is "Save as project default", which copies the current
//   URL into the project slot.

export type UrlSource = 'task' | 'project' | 'none';

export interface UseBrowserUrlResult {
  loading: boolean;
  effectiveUrl: string | null;
  source: UrlSource;
  projectDefault: string | null;
  taskOverride: string | null;
  saveForTask: (url: string) => Promise<void>;
  saveForProject: (url: string) => Promise<void>;
  clearTaskOverride: () => Promise<void>;
  recordNavigation: (url: string) => void;
}

/**
 * @param refreshToken Bump to force a refetch without remounting. Used by the
 *   `kangentic_browser_open_pane` bridge: main seeds the task's URL sidecar and
 *   then asks the renderer to show the pane, which is invisible to a fetch keyed
 *   only on `[taskId, projectId]` when the pane is already mounted on its empty
 *   state. A refetch is safe where a remount is not - both guards below hold, so
 *   a live pane's guest is never torn down.
 */
export function useBrowserUrl(taskId: string, projectId: string | null, refreshToken = 0): UseBrowserUrlResult {
  const [projectDefault, setProjectDefault] = useState<string | null>(null);
  const [taskOverride, setTaskOverride] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const projectDefaultRef = useRef<string | null>(null);
  projectDefaultRef.current = projectDefault;

  // True once a URL has resolved at least once. A REFETCH must not drop back to
  // the loading state: `BrowserPane` renders its active subtree only while an
  // effective URL exists, so a transient `loading` unmounts the <webview> and
  // destroys the guest, taking the agent's CDP session with it. That is not
  // hypothetical - a project switch re-runs this effect (child effects run
  // before the parent effect that marks the window retained), and the resulting
  // one-commit flicker recreated the guest with a new webContentsId.
  const hasResolvedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!hasResolvedRef.current) setLoading(true);
    window.electronAPI.browser
      .getUrls(taskId, projectId)
      .then((result) => {
        if (cancelled) return;
        // A refetch that finds nothing must not blank a pane that is already
        // showing a page: same reasoning as the loading guard above, since a
        // null effective URL unmounts the guest just as surely.
        if (hasResolvedRef.current && result.projectDefault === null && result.taskOverride === null) return;
        hasResolvedRef.current = true;
        setProjectDefault(result.projectDefault);
        setTaskOverride(result.taskOverride);
      })
      .catch(() => { /* leave defaults; UI shows empty state */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, projectId, refreshToken]);

  const saveForProject = useCallback(async (url: string) => {
    const existing = await window.electronAPI.config.getProjectOverrides();
    const overrides = existing ?? {};
    const nextOverrides = {
      ...overrides,
      browser: {
        ...overrides.browser,
        defaultUrl: url,
      },
    };
    await window.electronAPI.config.setProjectOverrides(nextOverrides);
    setProjectDefault(url);
  }, []);

  const saveForTask = useCallback(async (url: string) => {
    await window.electronAPI.browser.setTaskUrl(taskId, url, projectId);
    setTaskOverride(url);
  }, [taskId, projectId]);

  const clearTaskOverride = useCallback(async () => {
    await window.electronAPI.browser.clearTaskUrl(taskId, projectId);
    setTaskOverride(null);
  }, [taskId, projectId]);

  const lastRecordedUrlRef = useRef<string | null>(null);
  const recordNavigation = useCallback((url: string) => {
    if (!url) return;
    if (lastRecordedUrlRef.current === url) return;
    lastRecordedUrlRef.current = url;

    // Always update the task URL on navigation - it tracks "what this task
    // was last looking at" so resume opens the same page.
    saveForTask(url).catch(() => {
      // Sidecar write failure is non-fatal; navigation already succeeded.
    });

    // First nav ever in a fresh project also seeds the project default so
    // sibling tasks inherit it on their first open.
    if (!projectDefaultRef.current) {
      saveForProject(url)
        .then(() => {
          useToastStore.getState().addToast({
            message: 'Saved as project default',
            variant: 'success',
          });
        })
        .catch(() => { /* non-fatal */ });
    }
  }, [saveForTask, saveForProject]);

  const effectiveUrl = taskOverride ?? projectDefault ?? null;
  const source: UrlSource = taskOverride
    ? 'task'
    : projectDefault
      ? 'project'
      : 'none';

  return {
    loading,
    effectiveUrl,
    source,
    projectDefault,
    taskOverride,
    saveForTask,
    saveForProject,
    clearTaskOverride,
    recordNavigation,
  };
}
