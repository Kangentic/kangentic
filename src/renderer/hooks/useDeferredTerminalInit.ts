/**
 * Defers a terminal host's initTerminal() until its container has real pixel
 * dimensions, by one animation frame. Shared by TerminalTab and
 * CommandTerminalPane (the same "cannot drift" pattern as useTerminalRefit)
 * because the deferral carries three load-bearing behaviors at once:
 *
 * - The commit that mounts a pane already pays the panel subtree render;
 *   folding xterm construction (open + WebGL context + fit, ~10ms) into that
 *   same task produced a 40-60ms pointer-thread stall when a spawning
 *   session's pane mounted mid-drag (task #468).
 * - StrictMode's mount -> unmount -> remount constructs ONE terminal instead
 *   of two: the first mount's cleanup cancels its scheduled init before it
 *   ever runs. The synchronous init CommandTerminalPane hand-rolled instead
 *   built a throwaway xterm whose geometry-changing work raced the survivor
 *   through the settle pipeline (observed live: 'joined' twice, zero-wait,
 *   'no-tui-marker' twice per open).
 * - A display:none container (an inactive tab) has no dimensions yet; the
 *   ResizeObserver re-schedules the init when they arrive.
 *
 * The imperative core lives in runDeferredTerminalInit, exported so
 * tests/unit/deferred-terminal-init.test.ts asserts the contract against the
 * REAL code (this project's vitest has no DOM environment to render the hook
 * in; earlier coverage replicated the effect body and could drift).
 *
 * onInit/onCleanup are read through refs, so hosts may pass inline closures:
 * the effect re-runs only when initTerminal or the ref identity changes,
 * exactly as TerminalTab's inline effect always did. Note initTerminal is
 * NOT stable across settings changes (useTerminal rebuilds it on font/color
 * option changes) - a pre-existing quirk both hosts shared before the
 * extraction: the cleanup resets the flag and the next frame re-inits.
 */
import { useEffect, useRef, type RefObject } from 'react';

/** The two size fields the controller reads; tests pass plain objects. */
export interface DeferredInitHost {
  offsetWidth: number;
  offsetHeight: number;
}

export function runDeferredTerminalInit(input: {
  element: DeferredInitHost;
  initializedRef: { current: boolean };
  initTerminal: () => void;
  /** Runs right after a successful initTerminal(), in the same frame. */
  onInit?: () => void;
}): () => void {
  const { element, initializedRef, initTerminal, onInit } = input;
  let initRafId: number | null = null;

  // Init on the next frame if the container has dimensions by then.
  const scheduleInit = (): void => {
    if (initializedRef.current || initRafId !== null) return;
    initRafId = requestAnimationFrame(() => {
      initRafId = null;
      if (initializedRef.current) return;
      if (element.offsetWidth > 0 && element.offsetHeight > 0) {
        initTerminal();
        initializedRef.current = true;
        observer.disconnect();
        onInit?.();
      }
    });
  };

  // If the container has no dimensions yet (a display:none tab), the rAF
  // above no-ops and this observer re-schedules when dimensions arrive.
  const observer: ResizeObserver = new ResizeObserver(() => {
    if (initializedRef.current) {
      observer.disconnect();
      return;
    }
    scheduleInit();
  });
  observer.observe(element as unknown as Element);

  scheduleInit();

  return () => {
    if (initRafId !== null) cancelAnimationFrame(initRafId);
    observer.disconnect();
    initializedRef.current = false;
  };
}

interface DeferredTerminalInitOptions {
  terminalRef: RefObject<HTMLDivElement | null>;
  initTerminal: () => void;
  /** Runs right after a successful initTerminal(), in the same frame. */
  onInit?: () => void;
  /** Runs in the effect cleanup, after any pending init has been cancelled
   *  and the initialized flag has been reset. */
  onCleanup?: () => void;
}

export function useDeferredTerminalInit({
  terminalRef,
  initTerminal,
  onInit,
  onCleanup,
}: DeferredTerminalInitOptions): { initializedRef: RefObject<boolean> } {
  const initializedRef = useRef(false);
  const onInitRef = useRef(onInit);
  onInitRef.current = onInit;
  const onCleanupRef = useRef(onCleanup);
  onCleanupRef.current = onCleanup;

  useEffect(() => {
    const element = terminalRef.current;
    if (!element) return;
    const cleanup = runDeferredTerminalInit({
      element,
      initializedRef,
      initTerminal,
      onInit: () => onInitRef.current?.(),
    });
    return () => {
      cleanup();
      onCleanupRef.current?.();
    };
  }, [initTerminal, terminalRef]);

  return { initializedRef };
}
