import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Crosshair, Eraser, Loader2, Pencil, Pin, RotateCcw, Send, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { useDrawingOverlay } from './useDrawingOverlay';
import { compositeCapture } from './captureComposite';
import { BrowserEmptyState } from './BrowserEmptyState';
import { useBrowserUrl } from './useBrowserUrl';
import { INSPECT_SCRIPT, CLEAR_PICK_SCRIPT } from './inspectScript';
import { AttachmentChips } from './AttachmentChips';
import { useToastStore } from '../../stores/toast-store';
import { useProjectStore } from '../../stores/project-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { PopOutButton } from '../../pop-out/PopOutButton';
import { browserPartitionForWorktree } from '../../../shared/browser-partition';
import type { BrowserPickedElement } from '../../../shared/types';
import type { WebviewElement } from './webview-types';
import { MIN_ZOOM, MAX_ZOOM, stepZoom } from '../../../shared/zoom-steps';

// Side-pane in the task-detail window that hosts an Electron <webview>, a
// free-draw annotation overlay, and a "Send to agent" button which composites
// the capture, grabs DOM HTML + selected text, and injects a text prompt
// (with @-mention to the saved PNG) into the task's running PTY.

interface BrowserPaneProps {
  sessionId: string;
  taskId: string;
  /**
   * Working directory of the agent's session - either task.worktree_path
   * or the project root. The capture handler writes PNGs under the
   * project's `.kangentic/sessions/<sessionId>/captures/` so they're
   * cleaned up by the existing session lifecycle. The agent sees a
   * relative path in the @-mention computed from this cwd.
   */
  cwd: string;
}

export function BrowserPane({ sessionId, taskId, cwd }: BrowserPaneProps) {
  const {
    loading: urlLoading,
    effectiveUrl,
    projectDefault,
    saveForProject,
    recordNavigation,
  } = useBrowserUrl(taskId);

  if (urlLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-surface" data-testid="browser-pane-loading">
        <Loader2 size={20} className="animate-spin text-fg-muted" />
      </div>
    );
  }

  if (!effectiveUrl) {
    // Empty state submit goes through the same auto-save path as any other
    // navigation: webview loads -> did-navigate fires -> recordNavigation
    // auto-saves task URL and (since projectDefault is null here) also seeds
    // the project default with a toast.
    return (
      <BrowserEmptyState
        onSubmit={(url) => recordNavigation(url)}
      />
    );
  }

  return (
    <BrowserPaneActive
      sessionId={sessionId}
      taskId={taskId}
      cwd={cwd}
      effectiveUrl={effectiveUrl}
      projectDefault={projectDefault}
      saveForProject={saveForProject}
      recordNavigation={recordNavigation}
    />
  );
}

interface BrowserPaneActiveProps {
  sessionId: string;
  taskId: string;
  cwd: string;
  effectiveUrl: string;
  projectDefault: string | null;
  saveForProject: (url: string) => Promise<void>;
  recordNavigation: (url: string) => void;
}

function BrowserPaneActive({
  sessionId,
  taskId,
  cwd,
  effectiveUrl,
  projectDefault,
  saveForProject,
  recordNavigation,
}: BrowserPaneActiveProps) {
  const [urlInput, setUrlInput] = useState(effectiveUrl);
  const [currentUrl, setCurrentUrl] = useState(effectiveUrl);
  // Lock the initial `src` on first mount. Subsequent navigations go through
  // webview.loadURL() so the webview's internal history is preserved -
  // re-binding the `src` attribute on every render can collapse history to
  // a single step in some webview revisions.
  const [initialSrc] = useState(effectiveUrl);
  // Per-worktree persistent cookie jar, locked on mount (an Electron webview
  // partition cannot change after attach). Keyed off the session cwd so
  // concurrent worktrees' localhost logins stay isolated. See
  // shared/browser-partition.ts.
  const [partition] = useState(() => browserPartitionForWorktree(cwd));
  const [drawMode, setDrawMode] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [inspectActive, setInspectActive] = useState(false);
  const [pickedElement, setPickedElement] = useState<BrowserPickedElement | null>(null);
  // Gate a dark loading cover over the webview until its first paint. The
  // <webview> shows a white default surface before the page loads, which
  // flashed in as the pane slid open. We cover it with the app's surface color
  // (plus a spinner) and lift the cover on the first dom-ready / stop-loading.
  const [pageReady, setPageReady] = useState(false);
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);

  const webviewRef = useRef<WebviewElement | null>(null);
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);
  const noteInputRef = useRef<HTMLInputElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  // Zoom hotkeys (Ctrl+/-/0) are gated to "browser pane active": mouse over
  // the pane OR focus inside it. Same principle as task #139's Ctrl+Enter
  // fix - global document-level shortcuts shouldn't fire when the user is
  // working elsewhere in the dialog.
  const hoveredRef = useRef(false);
  const [zoomFactor, setZoomFactorState] = useState(1.0);

  const { canvasRef, strokes, handlers, clear, undo } = useDrawingOverlay({ enabled: drawMode });

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const onUrlChanged = () => {
      try {
        const current = webview.getURL();
        setUrlInput(current);
        setCurrentUrl(current);
        setCanGoBack(webview.canGoBack());
        setCanGoForward(webview.canGoForward());
        if (current && /^https?:/i.test(current)) {
          recordNavigation(current);
        }
      } catch {
        /* webview not yet attached */
      }
    };
    // A picked element is page-specific - its selector is meaningless after
    // a full navigation. Drop it on did-navigate (full document) but keep
    // it on did-navigate-in-page (hash/SPA route changes leave the DOM
    // intact, so the persistent overlay is still pointing at a valid node).
    const onFullNav = () => {
      onUrlChanged();
      setPickedElement(null);
    };
    webview.addEventListener('did-navigate', onFullNav);
    webview.addEventListener('did-navigate-in-page', onUrlChanged);
    return () => {
      webview.removeEventListener('did-navigate', onFullNav);
      webview.removeEventListener('did-navigate-in-page', onUrlChanged);
    };
  }, [recordNavigation]);

  // Register this pane's guest webContents with the main process so the
  // kangentic_browser_* MCP tools can drive it. The renderer is the only place
  // that knows taskId + sessionId + the guest's webContentsId. Registers on
  // dom-ready (the id is valid once the guest attaches) and unregisters on
  // unmount; main also tracks the guest's own destroyed / did-navigate events.
  const registeredWebContentsIdRef = useRef<number | null>(null);
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    let registered = false;
    const register = () => {
      if (registered || typeof webview.getWebContentsId !== 'function') return;
      let webContentsId: number;
      try {
        webContentsId = webview.getWebContentsId();
      } catch {
        return; // guest not attached yet; dom-ready will retry
      }
      if (!Number.isInteger(webContentsId) || webContentsId <= 0) return;
      registered = true;
      registeredWebContentsIdRef.current = webContentsId;
      const projectId = useProjectStore.getState().currentProject?.id ?? null;
      let url: string | null = null;
      try {
        url = webview.getURL() || null;
      } catch {
        /* not attached */
      }
      void window.electronAPI.browser.registerPane({ sessionId, taskId, projectId, webContentsId, url });
    };
    webview.addEventListener('dom-ready', register);
    register();
    return () => {
      webview.removeEventListener('dom-ready', register);
      // Pass the webContentsId THIS instance registered with, so an out-of-order
      // unmount (e.g. this in-app pane unmounting after a pop-out window's pane
      // already re-registered the same sessionId with a new guest) cannot
      // clobber the newer registration - see unregisterIfMatches.
      void window.electronAPI.browser.unregisterPane(sessionId, registeredWebContentsIdRef.current ?? undefined);
    };
  }, [sessionId, taskId]);

  // Lift the dark loading cover once the webview paints. One-shot: it stays
  // lifted across later navigations (the old page remains visible until the new
  // one paints, the normal browser behavior). A short fallback guarantees the
  // cover never sticks if a webview revision fires its ready event before this
  // listener attaches, or in tests where the stub never fires one.
  useEffect(() => {
    const webview = webviewRef.current;
    const reveal = () => setPageReady(true);
    const fallback = setTimeout(reveal, 2500);
    webview?.addEventListener('dom-ready', reveal);
    webview?.addEventListener('did-stop-loading', reveal);
    return () => {
      clearTimeout(fallback);
      webview?.removeEventListener('dom-ready', reveal);
      webview?.removeEventListener('did-stop-loading', reveal);
    };
  }, []);

  // F5 / Ctrl+R reload when focus is *outside* the embedded webview (e.g. in
  // the URL bar or any pane chrome). The matching main-process
  // before-input-event hook handles the webview-focused case. Combo from the
  // central keybinding registry; bubble phase, no stopPropagation (matches the
  // original document-level listener).
  useKeybinding('browser.reload', () => webviewRef.current?.reload(), {
    target: 'document',
    stopPropagation: false,
  });

  const applyZoom = useCallback((factor: number) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, factor));
    const webview = webviewRef.current;
    // Optional-chain BOTH the ref and the method: in UI-tier tests the
    // webview is a plain HTMLElement that doesn't expose setZoomFactor, and
    // a bare `webview?.setZoomFactor(x)` would throw "not a function".
    if (webview && typeof webview.setZoomFactor === 'function') {
      webview.setZoomFactor(clamped);
    }
    setZoomFactorState(clamped);
  }, []);

  const zoomIn = useCallback(() => applyZoom(stepZoom(zoomFactor, +1)), [applyZoom, zoomFactor]);
  const zoomOut = useCallback(() => applyZoom(stepZoom(zoomFactor, -1)), [applyZoom, zoomFactor]);
  const resetZoom = useCallback(() => applyZoom(1.0), [applyZoom]);

  // Ctrl+wheel inside the webview: the main process catches the
  // `zoom-changed` request on the guest webContents, applies the zoom, and
  // broadcasts the resulting factor here. The webview <tag> itself does NOT
  // emit zoom-changed (it's a WebContents event, not a DOM event), so this
  // IPC path is the only way to keep the toolbar % synced with wheel zoom.
  useEffect(() => {
    const unsubscribe = window.electronAPI.browser.onZoomChanged((factor) => {
      setZoomFactorState(factor);
    });
    return unsubscribe;
  }, []);

  const navigate = useCallback((target: string) => {
    const candidate = target.match(/^https?:\/\//i) ? target : `http://${target}`;
    let parsed: URL | null = null;
    try {
      parsed = new URL(candidate);
    } catch {
      setError(`Invalid URL: ${target}`);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setError('Only http:// and https:// URLs are allowed.');
      return;
    }
    setError(null);
    const final = parsed.toString();
    // Drive navigation through the webview's own loadURL to keep its history
    // intact across multi-step Back/Forward.
    webviewRef.current?.loadURL(final).catch(() => {
      setError(`Failed to load: ${final}`);
    });
  }, []);

  const handleUrlSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    navigate(urlInput);
  }, [navigate, urlInput]);

  const handleSaveAsProjectDefault = useCallback(async () => {
    const target = (() => {
      try { return webviewRef.current?.getURL() || currentUrl; } catch { return currentUrl; }
    })();
    if (!target) return;
    setPinning(true);
    try {
      await saveForProject(target);
      useToastStore.getState().addToast({
        message: 'Saved as project default',
        variant: 'success',
      });
    } catch (caught) {
      useToastStore.getState().addToast({
        message: caught instanceof Error ? caught.message : 'Failed to save URL',
        variant: 'error',
      });
    } finally {
      setPinning(false);
    }
  }, [currentUrl, saveForProject]);

  const matchesProjectDefault = !!projectDefault && currentUrl === projectDefault;

  const handleSend = useCallback(async () => {
    const webview = webviewRef.current;
    const overlay = canvasRef.current;
    if (!webview || !overlay) return;
    setSending(true);
    setError(null);
    try {
      const overlayRect = overlay.getBoundingClientRect();
      const pngBase64 = await compositeCapture({
        webview,
        strokes,
        overlayWidth: overlayRect.width,
        overlayHeight: overlayRect.height,
      });
      const selectedText = await webview.executeJavaScript<string>(
        '(function () { const sel = window.getSelection(); return sel ? sel.toString() : ""; })()',
      );
      const url = (() => {
        try { return webview.getURL(); } catch { return currentUrl; }
      })();

      await window.electronAPI.browser.captureAndSend({
        sessionId,
        taskId,
        cwd,
        url,
        pngBase64,
        pickedElement,
        selectedText: selectedText || '',
        note,
      });
      setNote('');
      clear();
      setPickedElement(null);
      webview.executeJavaScript(CLEAR_PICK_SCRIPT).catch(() => undefined);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      // Surface paste/submit failures via toast as well, since the inline
      // error is easy to miss next to the URL bar.
      useToastStore.getState().addToast({
        message,
        variant: 'error',
        duration: 6000,
      });
    } finally {
      setSending(false);
    }
  }, [canvasRef, clear, currentUrl, cwd, note, pickedElement, sessionId, strokes, taskId]);

  // One-shot inspect: enters inspect mode, captures the next click, exits.
  // Esc inside the webview cancels and resolves null. Subsequent clicks
  // need another button press to re-enter. Mutually exclusive with Draw.
  const startInspect = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;
    setInspectActive(true);
    if (drawMode) setDrawMode(false);
    try {
      const result = await webview.executeJavaScript<BrowserPickedElement | null>(INSPECT_SCRIPT);
      if (result) {
        setPickedElement(result);
        // Focus the note input so the user can start typing about the
        // selection without an extra click.
        noteInputRef.current?.focus();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Inspect failed');
    } finally {
      setInspectActive(false);
    }
  }, [drawMode]);

  const cancelInspect = useCallback(() => {
    // Unconditionally reset state - no closure check on inspectActive,
    // which avoided the case where a stale closure would early-return
    // and leave the React button stuck in the active style.
    setInspectActive(false);
    // Forcibly clean up the webview side: drop the active flag, remove
    // any leftover hover overlay, and dispatch Escape so any in-flight
    // inspect script promise resolves with null.
    webviewRef.current
      ?.executeJavaScript(`
        (function () {
          window.__kangenticInspectActive = false;
          var overlay = document.querySelector('[data-kangentic-inspector]');
          if (overlay) overlay.remove();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        })();
      `)
      .catch(() => undefined);
  }, []);

  const clearPicked = useCallback(() => {
    setPickedElement(null);
    webviewRef.current?.executeJavaScript(CLEAR_PICK_SCRIPT).catch(() => undefined);
  }, []);

  // Esc cancels Inspect mode. Kept as a hand-written CAPTURE-phase listener (not
  // a registry binding) because it must run BEFORE the parent TaskDetailWindow's
  // bubble-phase Esc-closes-window handler and call stopImmediatePropagation so
  // the window does not also close on the same Esc. Escape is not rebindable.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && inspectActive) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        cancelInspect();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [cancelInspect, inspectActive]);

  // Browser-pane shortcuts from the central keybinding registry. Document +
  // capture phase, preventDefault only (no stopPropagation), and skipped when a
  // form field is focused so typing `i`/`d` in the note input doesn't trigger
  // them. Zoom additionally requires the pane to be active (mouse over it OR
  // focus inside) so e.g. Ctrl+0 from elsewhere doesn't reset browser zoom.
  const notFormField = (event: KeyboardEvent | PointerEvent): boolean => {
    const target = event.target as HTMLElement | null;
    return !(!!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'));
  };
  const paneActive = (event: KeyboardEvent | PointerEvent): boolean => {
    if (!notFormField(event)) return false;
    const pane = paneRef.current;
    const focusInside = !!pane && pane.contains(document.activeElement);
    return hoveredRef.current || focusInside;
  };
  const browserKeyOptions = { target: 'document', capture: true, stopPropagation: false } as const;
  useKeybinding('browser.inspect', () => void startInspect(), { ...browserKeyOptions, when: notFormField });
  useKeybinding('browser.draw', () => setDrawMode((previous) => {
    if (!previous) cancelInspect();
    return !previous;
  }), { ...browserKeyOptions, when: notFormField });
  useKeybinding('browser.zoomIn', () => zoomIn(), { ...browserKeyOptions, when: paneActive });
  useKeybinding('browser.zoomOut', () => zoomOut(), { ...browserKeyOptions, when: paneActive });
  useKeybinding('browser.zoomReset', () => resetZoom(), { ...browserKeyOptions, when: paneActive });

  return (
    <div
      ref={paneRef}
      onMouseEnter={() => { hoveredRef.current = true; }}
      onMouseLeave={() => { hoveredRef.current = false; }}
      className="flex flex-col h-full min-h-0 bg-surface"
      data-testid="browser-pane"
    >
      {/* URL bar. This IS the browser pane's top bar (its identity is the URL it
          already shows), so unlike Changes/Stats it needs no separate surface
          header - the pop-out control just takes its predictable top-right slot at
          the end of this toolbar. Hidden inside a pop-out window (its descriptor is
          set), whose OS title bar already provides identity. */}
      <form onSubmit={handleUrlSubmit} className="flex items-center gap-1 px-2 py-1.5 border-b border-edge flex-shrink-0">
        <button
          type="button"
          onClick={() => webviewRef.current?.goBack()}
          disabled={!canGoBack}
          className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted disabled:cursor-default"
          title={canGoBack ? 'Back' : 'No earlier page'}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canGoForward}
          className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted disabled:cursor-default"
          title={canGoForward ? 'Forward' : 'No forward page'}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => webviewRef.current?.reload()}
          className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors"
          title="Reload (F5 / Ctrl+R)"
        >
          <RotateCcw size={14} />
        </button>
        <input
          type="text"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder="https://example.com"
          className="flex-1 bg-surface-input text-fg text-xs px-2 py-1 rounded border border-edge-input focus:outline-none focus:border-accent min-w-0"
          spellCheck={false}
          data-testid="browser-url-input"
        />
        {/* Pressing Enter inside the URL input submits the form -- no Go button needed. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        <button
          type="button"
          onClick={handleSaveAsProjectDefault}
          disabled={matchesProjectDefault || pinning}
          className={`flex items-center justify-center self-stretch aspect-square rounded border transition-colors flex-shrink-0 ${
            matchesProjectDefault
              ? 'bg-accent/15 border-accent/40 text-accent-fg cursor-default'
              : 'bg-surface-input border-edge-input text-fg-muted hover:text-fg hover:bg-surface-hover hover:border-accent/50'
          }`}
          title={matchesProjectDefault
            ? 'This URL is the project default'
            : 'Save as project default for all tasks'}
          aria-label={matchesProjectDefault
            ? 'This URL is the project default'
            : 'Save as project default'}
          data-testid="browser-pin-project"
        >
          {pinning
            ? <Loader2 size={14} className="animate-spin" />
            : <Pin size={14} strokeWidth={matchesProjectDefault ? 2 : 1.75} fill={matchesProjectDefault ? 'currentColor' : 'none'} />}
        </button>
        <div className="w-px h-5 bg-edge mx-1 flex-shrink-0" aria-hidden="true" />
        {/* Grouped zoom pill: ZoomOut | % | ZoomIn share one rounded surface,
            individual buttons drop their own rounding so the group reads as a
            single unit (Chrome-style zoom toolbar). */}
        <div
          className="flex items-stretch bg-surface-input border border-edge-input rounded overflow-hidden"
          data-testid="browser-zoom-pill"
        >
          <button
            type="button"
            onClick={zoomOut}
            disabled={zoomFactor <= MIN_ZOOM + 1e-6}
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted disabled:cursor-default"
            title="Zoom out (Ctrl+- or Ctrl+scroll wheel)"
            aria-label="Zoom out"
            data-testid="browser-zoom-out"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            onClick={resetZoom}
            className="px-1.5 py-1 text-xs text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors tabular-nums min-w-[3.25rem]"
            title="Reset zoom to 100% (Ctrl+0)"
            aria-label={`Reset zoom (current ${Math.round(zoomFactor * 100)}%)`}
            data-testid="browser-zoom-reset"
          >
            {Math.round(zoomFactor * 100)}%
          </button>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoomFactor >= MAX_ZOOM - 1e-6}
            className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted disabled:cursor-default"
            title="Zoom in (Ctrl+= or Ctrl+scroll wheel)"
            aria-label="Zoom in"
            data-testid="browser-zoom-in"
          >
            <ZoomIn size={14} />
          </button>
        </div>
        {/* Pop-out in its predictable top-right slot. Hidden inside a pop-out
            window (descriptor set); shown only for the in-app embed. */}
        {!window.electronAPI.popOut?.descriptor && projectId && (
          <>
            <div className="w-px h-5 bg-edge mx-1 flex-shrink-0" aria-hidden="true" />
            <PopOutButton kind="browser" params={{ taskId, projectId }} title="Open in new window" />
          </>
        )}
      </form>

      {/* Webview + canvas overlay */}
      <div ref={overlayContainerRef} className="relative flex-1 min-h-0 bg-white">
        {/* `webview` is an Electron-only intrinsic; the typing in webview-types.ts adds it to JSX.
         *  pointer-events:none while drawing - Electron's <webview> is a guest process that
         *  doesn't always honor normal CSS stacking, so we explicitly turn off its event
         *  capture when the canvas overlay needs to receive draws. */}
        <webview
          ref={webviewRef as unknown as React.Ref<HTMLElement>}
          src={initialSrc}
          // Per-worktree persistent cookie jar (browserPartitionForWorktree(cwd),
          // computed above). Sessions sharing a checkout share the jar; concurrent
          // worktrees stay isolated. Settings -> Browser -> Clear browser data wipes them.
          partition={partition}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: drawMode ? 'none' : 'auto',
          }}
          data-testid="browser-webview"
        />
        <canvas
          ref={canvasRef}
          {...handlers}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: drawMode ? 'auto' : 'none',
            cursor: drawMode ? 'crosshair' : 'default',
          }}
          data-testid="browser-overlay"
        />
        {!pageReady && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-surface pointer-events-none"
            data-testid="browser-pane-page-loading"
          >
            <Loader2 size={20} className="animate-spin text-fg-muted" />
          </div>
        )}
      </div>

      <AttachmentChips
        strokeCount={strokes.length}
        pickedElement={pickedElement}
        onClearStrokes={clear}
        onClearPicked={clearPicked}
      />

      {/* Toolbar: capture zone (left) | flex spacer | compose zone (right) */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-edge flex-shrink-0">
        {/* Capture zone: Draw + its stroke sub-actions, then Inspect. */}
        <button
          type="button"
          onClick={() => {
            setDrawMode((previous) => {
              // Drawing and inspecting both want pointer events; only one
              // at a time. Aborting Inspect's loop is what actually stops
              // the script from intercepting clicks in the webview.
              if (!previous) cancelInspect();
              return !previous;
            });
          }}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
            drawMode
              ? 'bg-accent/20 text-accent-fg border border-accent/40'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover border border-transparent'
          }`}
          title="Toggle draw mode (Ctrl/Cmd+D)"
          data-testid="browser-draw-toggle"
        >
          <Pencil size={12} />
          Draw
        </button>
        <button
          type="button"
          onClick={undo}
          disabled={strokes.length === 0}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          title="Undo last stroke"
        >
          <Undo2 size={12} />
          Undo
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={strokes.length === 0}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          title="Clear all strokes"
        >
          <Eraser size={12} />
          Clear
        </button>
        <div className="w-px h-4 bg-edge mx-1 flex-shrink-0" aria-hidden="true" />
        <button
          type="button"
          onClick={() => void startInspect()}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
            inspectActive
              ? 'bg-accent/20 text-accent-fg border border-accent/40'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover border border-transparent'
          }`}
          title="Click elements to capture their identity (Ctrl/Cmd+I, Esc to exit)"
          data-testid="browser-inspect-toggle"
        >
          <Crosshair size={12} />
          Inspect
        </button>

        {/* Compose zone */}
        <input
          ref={noteInputRef}
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || sending) return;
            event.preventDefault();
            handleSend();
          }}
          placeholder={notePlaceholder(strokes.length, pickedElement ? 1 : 0)}
          className="flex-1 ml-2 bg-surface-input text-fg text-xs px-2 py-1 rounded border border-edge-input focus:outline-none focus:border-accent min-w-0"
          spellCheck={true}
          data-testid="browser-note-input"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={sending}
          className="flex items-center gap-1 px-3 py-1 text-xs text-accent-on bg-accent-emphasis hover:bg-accent rounded transition-colors disabled:opacity-50"
          title="Send to agent (Ctrl/Cmd+Enter)"
          data-testid="browser-send"
        >
          {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Send
        </button>
      </div>

      {error && (
        <div
          className="px-2 py-1 text-[11px] text-red-400 flex-shrink-0 border-t border-edge"
          data-testid="browser-send-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Rotate placeholder copy based on what's queued so the user sees a
 * concrete example of a useful note.
 */
function notePlaceholder(strokeCount: number, pickedCount: number): string {
  if (pickedCount > 0 && strokeCount > 0) return 'e.g. "Explain what I marked"';
  if (pickedCount > 0) return 'e.g. "Why is this misaligned?"';
  if (strokeCount > 0) return 'e.g. "Match the circled spacing"';
  return 'What should the agent do with this?';
}

