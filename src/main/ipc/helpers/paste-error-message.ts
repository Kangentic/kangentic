import type { PasteSubmitError } from '../../pty/paste-engine';

/**
 * The toast text for a paste the Browser pane's Send could not submit. These
 * strings are the user-facing contract of `BROWSER_CAPTURE_SEND`.
 *
 * The `no-submission-evidence` code covers two situations the paste engine
 * words differently. When the agent turned bracketed-paste mode off during the
 * call, a modal or permission prompt has focus, and the engine's message says
 * "bracketed-paste mode". Any other `no-submission-evidence` is a paste that
 * landed but never submitted. Every other code (`aborted`, `held`) reads as
 * cancelled.
 */
export function translatePasteSubmitError(caught: Pick<PasteSubmitError, 'code' | 'message'>): string {
  if (caught.code === 'timeout') {
    return 'Paste timed out - the agent may be busy. Try again.';
  }
  if (caught.code === 'no-submission-evidence') {
    return caught.message.includes('bracketed-paste mode')
      ? 'Agent has a permission prompt or modal open. Resolve it in the terminal, then send again.'
      : 'Paste landed but Enter did not submit. Press Enter in the terminal to submit.';
  }
  return 'Paste was cancelled.';
}
