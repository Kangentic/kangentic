/**
 * The PasteSubmitError -> toast text translation behind the Browser pane's
 * Send button (`BROWSER_CAPTURE_SEND` in src/main/ipc/handlers/browser.ts).
 * The strings are the user-facing contract: they appear in toasts, and the
 * e2e spec browser-evidence-retry.spec.ts asserts two of them.
 *
 * The message fixtures are the ones paste-engine.ts throws today (the
 * `bracketed-paste mode` branch and the post-retry branch), because the
 * translator keys on that phrase.
 */
import { describe, it, expect } from 'vitest';
import { PasteSubmitError } from '../../src/main/pty/paste-engine';
import { translatePasteSubmitError } from '../../src/main/ipc/helpers/paste-error-message';

const MODAL_OPEN_MESSAGE =
  'paste-engine: browser-capture sent paste but agent disabled bracketed-paste mode (modal/prompt focused). Skipped retry to avoid confirming a destructive action.';
const NO_SIGNAL_MESSAGE =
  'paste-engine: browser-capture sent paste + \\r (1 retry) but agent emitted no signal in 3000ms';

describe('translatePasteSubmitError', () => {
  it('translates a timeout to the retry-prompt message', () => {
    const error = new PasteSubmitError('timeout', 'paste-engine: browser-capture exceeded 15000ms');
    expect(translatePasteSubmitError(error)).toBe('Paste timed out - the agent may be busy. Try again.');
  });

  it('translates no-submission-evidence after the TUI disabled bracketed paste to the modal message', () => {
    const error = new PasteSubmitError('no-submission-evidence', MODAL_OPEN_MESSAGE);
    expect(translatePasteSubmitError(error)).toBe(
      'Agent has a permission prompt or modal open. Resolve it in the terminal, then send again.',
    );
  });

  it('translates no-submission-evidence after a retry with no signal to the press-Enter message', () => {
    const error = new PasteSubmitError('no-submission-evidence', NO_SIGNAL_MESSAGE);
    expect(translatePasteSubmitError(error)).toBe(
      'Paste landed but Enter did not submit. Press Enter in the terminal to submit.',
    );
  });

  it('translates an abort to the cancelled message', () => {
    const error = new PasteSubmitError('aborted', 'paste-engine: aborted before write');
    expect(translatePasteSubmitError(error)).toBe('Paste was cancelled.');
  });

  it('reads a held paste as cancelled too (the code has no message of its own)', () => {
    const error = new PasteSubmitError('held', 'paste-engine: browser-capture held before the paste: the session cannot take keys');
    expect(translatePasteSubmitError(error)).toBe('Paste was cancelled.');
  });
});
