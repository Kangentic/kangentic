/**
 * Keeps every Command Terminal's Browser pane mounted, and lays each one over
 * the slot its terminal's window draws.
 *
 * Why the pane is not inside the window: an Electron `<webview>` guest dies the
 * instant its node unmounts, and the Command Terminal panel unmounts on every
 * hide (Ctrl+Shift+P, a backdrop click, Hide), on a project switch, and on Open
 * in new window. A pane inside it would reload on each of those and lose its
 * `sessionStorage`, which is the logout the task window's parking exists to
 * prevent. So the pane lives HERE, in a host that outlives the panel, and the
 * window only draws an empty slot (`COMMAND_TERMINAL_BROWSER_SLOT_ATTRIBUTE`).
 *
 * Each frame the host reads the slot's rect and places the pane on it. While no
 * slot shows it (the panel hidden, another project open, the terminal behind
 * an expanded one, the pane held, a swap drag in flight) the pane stays where it
 * last was at `opacity: 0`, inert and taking no pointer, never `visibility:
 * hidden` or offscreen: both stop the guest compositing, which hangs an agent's
 * screenshot (`retained-pane-never-remounts.md`). The reads run on animation
 * frames while a slot is on screen, and on a slow timer always, since a
 * minimized window runs no animation frames.
 *
 * One pane per owner key, keyed by it and rendered in a stable order, so a pane
 * never moves between parents and never remounts. A respawn (a branch switch, a
 * resume in place) leaves its slot with no session for a moment; the pane keeps
 * the last session it had and re-registers in place when the next one arrives.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { BrowserPane } from '../browser/BrowserPane';
import { useSessionStore } from '../../stores/session-store';
import { usePopOutStore } from '../../stores/pop-out-store';
import { popOutInstanceKey } from '../../../shared/pop-out';
import { isCommandTerminalBrowserOwner, parseCommandTerminalBrowserOwner } from '../../../shared/browser-owner';
import { findLiveCommandTerminalSession } from '../../../shared/session-owner';
import { resolveProjectRoot } from '../../../shared/git-utils';
import type { BrowserPaneVisibility } from '../../../shared/types';
import { commandWindowManager } from '../../window-manager';
import {
  COMMAND_TERMINAL_BROWSER_SLOT_ATTRIBUTE,
  COMMAND_TERMINAL_BROWSER_SLOT_EVENT,
  isCommandTerminalPanelDetached,
  useCommandTerminalBrowserBridge,
} from './command-terminal-browser';
import { SWAP_FLOAT_TEST_ID } from './swap-drag';

/** Where a pane sits before any slot has shown it: on screen and of a real
 *  size, so the hidden guest still composites and a capture still answers. */
const UNPLACED_RECT = { left: 0, top: 0, width: 1024, height: 768 };

/** How often a pane no slot shows checks for one, in milliseconds. */
const HIDDEN_POLL_MS = 250;

interface HostedPane {
  ownerKey: string;
  projectId: string;
  slot: string;
}

/** The session and directory a pane keeps through a respawn's gap. */
interface PaneBinding {
  sessionId: string;
  cwd: string;
}

/**
 * Main's open and close requests for Command Terminal Browser panes, and their
 * saved layout (`useCommandTerminalBrowserBridge`). A component of its own, so
 * a change to the hook's hook list remounts only this, never the root that
 * mounts it and holds every pane guest (`hmr-patterns.md`).
 */
export function CommandTerminalBrowserBridge({ scopeProjectId }: { scopeProjectId?: string }) {
  useCommandTerminalBrowserBridge(scopeProjectId);
  return null;
}

export function CommandTerminalBrowserHost({ scopeProjectId }: { scopeProjectId?: string }) {
  const ownerKeys = useSessionStore(useShallow((state) => {
    const keys = new Set<string>();
    for (const key of state.browserOpenTasks) if (isCommandTerminalBrowserOwner(key)) keys.add(key);
    for (const key of state.browserHeldTasks) if (isCommandTerminalBrowserOwner(key)) keys.add(key);
    return [...keys].sort();
  }));
  const openInstanceKeys = usePopOutStore((state) => state.openInstanceKeys);
  const panes = useMemo<HostedPane[]>(() => {
    const hosted: HostedPane[] = [];
    for (const ownerKey of ownerKeys) {
      const owner = parseCommandTerminalBrowserOwner(ownerKey);
      if (!owner) continue;
      if (scopeProjectId !== undefined && owner.projectId !== scopeProjectId) continue;
      // The main window leaves a detached panel's panes to that window.
      if (scopeProjectId === undefined && isCommandTerminalPanelDetached(owner.projectId)) continue;
      // A pane popped out into its own Browser window is that window's.
      if (openInstanceKeys[popOutInstanceKey('browser', { projectId: owner.projectId, taskId: ownerKey })]) continue;
      hosted.push({ ownerKey, projectId: owner.projectId, slot: owner.slot });
    }
    return hosted;
  }, [ownerKeys, scopeProjectId, openInstanceKeys]);

  if (panes.length === 0) return null;
  return createPortal(
    <div className="fixed inset-0 z-[46] pointer-events-none" data-testid="command-terminal-browser-host">
      {panes.map((pane) => (
        <HostedBrowserPane key={pane.ownerKey} pane={pane} />
      ))}
    </div>,
    document.body,
  );
}

function HostedBrowserPane({ pane }: { pane: HostedPane }) {
  const liveSession = useSessionStore((state) => findLiveCommandTerminalSession(state.sessions, pane.projectId, pane.slot));
  // The last session the slot had, so a respawn's gap leaves the pane mounted.
  // State set during render (React's "information from previous renders"
  // pattern): a ref may be neither read nor written while rendering.
  const [binding, setBinding] = useState<PaneBinding | null>(null);
  if (liveSession) {
    const cwd = resolveProjectRoot(liveSession.cwd);
    if (binding?.sessionId !== liveSession.id || binding.cwd !== cwd) setBinding({ sessionId: liveSession.id, cwd });
  }
  const frameRef = useRef<HTMLDivElement>(null);
  const visibility = usePlacement(frameRef, pane.ownerKey);

  if (!binding) return null;
  return (
    <div
      ref={frameRef}
      className="fixed overflow-hidden"
      style={{ ...rectStyle(UNPLACED_RECT), opacity: 0, pointerEvents: 'none' }}
      data-testid="command-terminal-browser-pane"
      data-owner-key={pane.ownerKey}
      data-visibility={visibility}
      aria-hidden={visibility === 'showing' ? undefined : true}
      inert={visibility === 'showing' ? undefined : true}
    >
      <BrowserPane
        sessionId={binding.sessionId}
        taskId={pane.ownerKey}
        cwd={binding.cwd}
        projectId={pane.projectId}
        visibility={visibility}
      />
    </div>
  );
}

function rectStyle(rect: { left: number; top: number; width: number; height: number }) {
  return { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` };
}

/**
 * Follow the slot drawn for `ownerKey`: place the frame on it while it shows,
 * and leave it, invisible, where it last was while it does not. Styles are
 * written to the frame directly, never through React state, so a moving panel
 * costs no render. Returns what the agent is told about the pane.
 */
function usePlacement(frameRef: React.RefObject<HTMLDivElement | null>, ownerKey: string): BrowserPaneVisibility {
  const [visibility, setVisibility] = useState<BrowserPaneVisibility>('hidden');
  useEffect(() => {
    let lastRect = UNPLACED_RECT;
    let lastShowing: boolean | null = null;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const selector = `[${COMMAND_TERMINAL_BROWSER_SLOT_ATTRIBUTE}="${CSS.escape(ownerKey)}"]`;
    const tick = (fromTimer = false): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (fromTimer) timer = null;
      const element = frameRef.current;
      const slot = document.querySelector<HTMLElement>(selector);
      const rect = slot?.getBoundingClientRect();
      // Behind an expanded terminal the window is inert at the same rect, and a
      // swap drag moves real frames under a picture of the terminal: the pane
      // must not paint over either.
      const showing = !!slot && !!rect && rect.width > 0 && rect.height > 0
        && slot.closest('[inert]') === null
        && document.querySelector(`[data-testid="${SWAP_FLOAT_TEST_ID}"]`) === null;
      if (element) {
        if (showing && rect) {
          lastRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }
        const style = element.style;
        const next = rectStyle(lastRect);
        if (style.left !== next.left) style.left = next.left;
        if (style.top !== next.top) style.top = next.top;
        if (style.width !== next.width) style.width = next.width;
        if (style.height !== next.height) style.height = next.height;
        const opacity = showing ? '1' : '0';
        if (style.opacity !== opacity) style.opacity = opacity;
        // A drag in flight (the split seam, a window edge) locks text selection
        // on the body. The page must not take the pointer then: a `<webview>`
        // swallows every event over it, and this host sits above the panel, so
        // the drag's own capture overlay cannot cover it.
        const dragging = document.body.style.userSelect === 'none';
        const pointerEvents = showing && !dragging ? 'auto' : 'none';
        if (style.pointerEvents !== pointerEvents) style.pointerEvents = pointerEvents;
      }
      if (showing !== lastShowing) {
        lastShowing = showing;
        setVisibility(showing ? 'showing' : 'hidden');
      }
      // Animation frames while a slot shows, so the pane moves with the panel.
      // The timer runs beside them because Chromium pauses animation frames in
      // a minimized or hidden window: without it the pane kept reporting
      // `showing` to the agent after the panel hid behind a minimized window.
      // One timer at a time, armed only once the last has fired: re-arming it
      // on every frame cost a timer per frame per pane.
      if (slot) frame = requestAnimationFrame(() => tick());
      if (timer === null) timer = setTimeout(() => tick(true), HIDDEN_POLL_MS);
    };
    tick();
    // Events place or hide the pane at once: a slot mounting or unmounting, the
    // panel showing or hiding, a window expanding over another. The loop above
    // keeps it on a moving slot; these keep it right when the window is
    // minimized, which throttles the loop's frames and timers alike.
    // A microtask, so the read lands after the commit that moved the slot.
    let disposed = false;
    const tickSoon = (): void => queueMicrotask(() => { if (!disposed) tick(); });
    window.addEventListener(COMMAND_TERMINAL_BROWSER_SLOT_EVENT, tickSoon);
    const unsubscribeWindows = commandWindowManager.store.subscribe(tickSoon);
    const unsubscribePanel = useSessionStore.subscribe((state, previous) => {
      if (state.commandBarVisible !== previous.commandBarVisible) tickSoon();
    });
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      window.removeEventListener(COMMAND_TERMINAL_BROWSER_SLOT_EVENT, tickSoon);
      unsubscribeWindows();
      unsubscribePanel();
    };
  }, [frameRef, ownerKey]);
  return visibility;
}
