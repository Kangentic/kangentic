import { useCallback, useEffect, useRef, useState } from 'react';

// Resolves the effective URL for a task's Browser pane and exposes
// save/recordNavigation helpers.
//
// Resolution: taskOverride > projectDefault > null (caller renders empty state).
//
// Auto-save model (simplified per UX feedback):
// - Every successful navigation silently updates the task URL. Task URL is
//   effectively "what this task was last looking at"; on resume the pane
//   loads exactly that.
// - The project default is NEVER set automatically. It changes only through an
//   explicit action: "Save as project default" in the pane, or Settings ->
//   Browser -> Default URL. A task navigation used to seed it on the first
//   navigation in a fresh project, which made every sibling task inherit that
//   task's URL - and once tasks lease their own dev-server ports, inheriting
//   another task's port is a cross-task collision rather than a convenience.

export type UrlSource = 'task' | 'task-port' | 'project' | 'none';

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
  const [taskPortUrl, setTaskPortUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        if (
          hasResolvedRef.current
          && result.projectDefault === null
          && result.taskOverride === null
          && result.taskPortUrl === null
        ) return;
        hasResolvedRef.current = true;
        setProjectDefault(result.projectDefault);
        setTaskOverride(result.taskOverride);
        setTaskPortUrl(result.taskPortUrl);
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

    // A task navigation deliberately does NOT seed the project default any more.
    //
    // It used to: the first navigation in a fresh project wrote
    // `browser.defaultUrl` for the WHOLE project, so every sibling task
    // inherited that task's URL on its first open. Once each task leases its own
    // dev-server port ({{port}}), that inheritance is actively wrong - a sibling
    // opened onto the first task's port and showed the first task's dev server,
    // which is exactly the cross-task collision the port lease exists to remove.
    // It self-corrected only after the sibling navigated once itself, so it hit
    // precisely when several tasks start at the same time.
    //
    // The project default is now settings-only (Settings -> Browser -> Default
    // URL), which is the one place it can be set deliberately rather than as a
    // side effect of whichever task happened to navigate first.
  }, [saveForTask]);

  // taskOverride > taskPortUrl > projectDefault.
  //
  // The task's own leased dev-server port outranks the project default because
  // that default is ONE value shared by every task: with several tasks running
  // at once it is right for at most one of them, and pointing a pane at another
  // task's dev server is the cross-task collision the port lease exists to
  // remove. An explicit per-task URL still wins over both - the user or agent
  // said exactly where to look.
  const effectiveUrl = taskOverride ?? taskPortUrl ?? projectDefault ?? null;
  const source: UrlSource = taskOverride
    ? 'task'
    : taskPortUrl
      ? 'task-port'
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
