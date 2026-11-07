/**
 * What `runtimeEvaluate` reports for an expression that threw, through the
 * REAL cdp.ts against a fake debugger.
 *
 * Chromium puts the word "Uncaught" in `exceptionDetails.text` for a thrown
 * error and the error itself in `exceptionDetails.exception.description`. The
 * text alone left agents retrying `kangentic_browser_eval` blind, with nothing
 * to say what threw.
 *
 * Tier: Unit (vitest; the debugger is a stub, no Electron).
 */
import { describe, it, expect, vi } from 'vitest';
import type { WebContents } from 'electron';
import { runtimeEvaluate } from '../../src/main/browser/cdp/cdp';

function guestReplying(reply: unknown): WebContents {
  return { debugger: { sendCommand: vi.fn(() => Promise.resolve(reply)) } } as unknown as WebContents;
}

describe('runtimeEvaluate', () => {
  it('reports the thrown error, not the word "Uncaught"', async () => {
    const description = 'TypeError: Cannot read properties of null (reading \'click\')\n    at <anonymous>:1:29';
    const guest = guestReplying({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: 'Uncaught',
        exception: { type: 'object', subtype: 'error', className: 'TypeError', description },
      },
    });

    expect(await runtimeEvaluate(guest, 'document.querySelector("#gone").click()')).toEqual({ value: null, error: description });
  });

  it('falls back to the text when the exception has no description', async () => {
    const guest = guestReplying({
      result: { type: 'undefined' },
      exceptionDetails: { text: 'Uncaught SyntaxError: Unexpected token', exception: { type: 'string', value: 'x' } },
    });

    expect((await runtimeEvaluate(guest, 'let')).error).toBe('Uncaught SyntaxError: Unexpected token');
  });

  it('keeps a generic error when Chromium names nothing at all', async () => {
    const guest = guestReplying({ result: { type: 'undefined' }, exceptionDetails: {} });

    expect((await runtimeEvaluate(guest, '1')).error).toBe('evaluation error');
  });

  it('returns the value of an expression that did not throw', async () => {
    const guest = guestReplying({ result: { type: 'number', value: 2 } });

    expect(await runtimeEvaluate(guest, '1 + 1')).toEqual({ value: 2, error: null });
  });
});
