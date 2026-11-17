import { useEffect, useRef } from 'react';
import { describeIpcError } from '../../../lib/ipc-error';
import { reportRendererFailure } from '../../../utils/renderer-failure';

/** The board providers whose Connect dialog offers a browser sign-in. */
export type BrowserSignInProvider = 'jira' | 'trello' | 'linear';

/** What main answers a browser sign-in with, in the shape every provider shares. */
export interface BrowserSignInAnswer {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
}

/**
 * How one sign-in ended, for the dialog that started it.
 * - `saved`: main saved it. Told even after a Back or a newer sign-in, since the
 *   sign-in is saved whichever screen shows. Never told once the dialog closed,
 *   so a sign-in that lands after Cancel does not carry on what the dialog was for.
 * - `failed`: why, the provider's own text when it gave one, or null.
 * - `cancelled`: the user left the waiting screen.
 * - `stale`: a Back, a Cancel, a close or a newer sign-in moved on, so the dialog
 *   shows nothing for it.
 */
export type BrowserSignInOutcome =
  | { kind: 'saved' }
  | { kind: 'failed'; error: string | null }
  | { kind: 'cancelled' }
  | { kind: 'stale' };

/** The `reportRendererFailure` area each provider's dialog reports under. */
const REPORT_AREA: Record<BrowserSignInProvider, string> = {
  jira: 'jira-connect',
  trello: 'trello',
  linear: 'linear',
};

function sendCancel(provider: BrowserSignInProvider): void {
  window.electronAPI.backlog[provider].cancelSignIn().catch((cancelError: unknown) => {
    reportRendererFailure(REPORT_AREA[provider], 'cancel-sign-in', cancelError);
  });
}

/**
 * The waiting half of a Connect dialog's browser sign-in, shared by every
 * provider. It tracks which attempt is current, so an earlier one that answers
 * late cannot change the screen, and whether one still waits on the browser, so
 * a Back, a close or an unmount asks main to stop it and free its port.
 */
export function useBrowserSignIn(provider: BrowserSignInProvider) {
  // Which sign-in is current. A Back, a Cancel or a newer sign-in moves it on.
  const attemptRef = useRef(0);
  // True while a sign-in waits on the browser.
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  // A dialog that unmounts mid-wait stops the sign-in, so its port and timer go with it.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      if (!pendingRef.current) return;
      pendingRef.current = false;
      sendCancel(provider);
    };
  }, [provider]);

  /** Move past the current sign-in, and ask main to stop it when it still waits. */
  const cancel = (): void => {
    attemptRef.current += 1;
    if (!pendingRef.current) return;
    pendingRef.current = false;
    sendCancel(provider);
  };

  /** Open the pending sign-in's page again, for a browser tab the user closed. */
  const reopen = (): void => {
    window.electronAPI.backlog[provider].reopenSignIn().catch((reopenError: unknown) => {
      reportRendererFailure(REPORT_AREA[provider], 'reopen-sign-in', reopenError);
    });
  };

  /** Run one sign-in through `start` and say how it ended. */
  const run = async (start: () => Promise<BrowserSignInAnswer>): Promise<BrowserSignInOutcome> => {
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    pendingRef.current = true;
    try {
      const answer = await start();
      if (attempt === attemptRef.current) pendingRef.current = false;
      if (answer.ok) return mountedRef.current ? { kind: 'saved' } : { kind: 'stale' };
      if (attempt !== attemptRef.current || !mountedRef.current) return { kind: 'stale' };
      return answer.cancelled ? { kind: 'cancelled' } : { kind: 'failed', error: answer.error ?? null };
    } catch (signInError: unknown) {
      reportRendererFailure(REPORT_AREA[provider], 'sign-in', signInError);
      if (attempt !== attemptRef.current || !mountedRef.current) return { kind: 'stale' };
      pendingRef.current = false;
      return { kind: 'failed', error: signInError instanceof Error ? describeIpcError(signInError) : null };
    }
  };

  return { run, cancel, reopen };
}
