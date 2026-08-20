/**
 * Unit tests for `src/renderer/utils/guest-text-target.ts` - the two exported
 * functions that reach a field inside a Browser pane's `<webview>` guest.
 *
 * The PROBE_SCRIPT / WRITE_SCRIPT string bodies only ever run inside a real
 * guest page and are deliberately left untested here (there is no jsdom in
 * this project's unit tier, and the module header explains why every
 * DECISION already stays host-side so it does not need to be). What this file
 * covers is the part that runs in THIS process: how `probeGuestField` and
 * `writeGuestField` handle whatever the `<webview>` hands back, including the
 * exception path a navigated-away or crashed guest takes, and exactly what
 * `writeGuestField` sends across the process boundary.
 *
 * The exception path is load-bearing for this commit specifically:
 * `useDictation.ts`'s `startDictationSafely` now SURFACES an unexpected throw
 * instead of swallowing it, so a guest that goes away mid-dictation must
 * degrade these two calls to `null` / `false` rather than let a rejection
 * propagate out of the press handler.
 */
import { describe, it, expect, vi } from 'vitest';
import { probeGuestField, writeGuestField, type GuestFieldProbe } from '../../src/renderer/utils/guest-text-target';
import type { WebviewElement } from '../../src/renderer/components/browser/webview-types';

function fakeWebview(executeJavaScript: (script: string) => Promise<unknown>): WebviewElement {
  return { executeJavaScript } as unknown as WebviewElement;
}

describe('probeGuestField', () => {
  it('returns exactly what the guest reports on an eligible field', async () => {
    const probe: GuestFieldProbe = {
      eligible: true,
      reason: 'ok',
      richText: false,
      value: 'existing',
      selectionStart: 3,
      selectionEnd: 3,
      rect: { left: 1, top: 2, width: 3, height: 4 },
    };
    const webview = fakeWebview(() => Promise.resolve(probe));

    expect(await probeGuestField(webview)).toEqual(probe);
  });

  it('passes the refusal through unchanged, including a rect on a named refusal', async () => {
    const refusal: GuestFieldProbe = {
      eligible: false,
      reason: 'password',
      rect: { left: 5, top: 6, width: 7, height: 8 },
    };
    const webview = fakeWebview(() => Promise.resolve(refusal));

    expect(await probeGuestField(webview)).toEqual(refusal);
  });

  it('returns null when the guest has navigated, crashed, or is not attached', async () => {
    // executeJavaScript rejects in exactly that situation. Indistinguishable
    // from "nothing focused" as far as the caller is concerned - it must not
    // propagate, or the dictation press handler above it throws.
    const webview = fakeWebview(() => Promise.reject(new Error('render frame gone')));

    expect(await probeGuestField(webview)).toBeNull();
  });

  it('sends the exact PROBE_SCRIPT with no arguments', async () => {
    const executeJavaScript = vi.fn(() => Promise.resolve(null));
    const webview = fakeWebview(executeJavaScript);

    await probeGuestField(webview);

    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    const [script, userGesture] = executeJavaScript.mock.calls[0];
    expect(script).toContain('document.activeElement');
    expect(userGesture).toBeUndefined();
  });
});

describe('writeGuestField', () => {
  it('resolves true when the guest reports the write landed', async () => {
    const webview = fakeWebview(() => Promise.resolve(true));
    expect(await writeGuestField(webview, 'hello', 5)).toBe(true);
  });

  it('resolves false when the guest reports the write did not land', async () => {
    const webview = fakeWebview(() => Promise.resolve(false));
    expect(await writeGuestField(webview, 'hello', 5)).toBe(false);
  });

  it('returns false, rather than rejecting, when the guest is gone', async () => {
    const webview = fakeWebview(() => Promise.reject(new Error('render frame gone')));
    expect(await writeGuestField(webview, 'hello', 5)).toBe(false);
  });

  it('defaults previousLength to 0 when the caller omits it', async () => {
    const executeJavaScript = vi.fn(() => Promise.resolve(true));
    const webview = fakeWebview(executeJavaScript);

    await writeGuestField(webview, 'hello', 5);

    const script = executeJavaScript.mock.calls[0][0] as string;
    expect(script.endsWith(', 0)')).toBe(true);
  });

  it('passes an explicit previousLength through untouched', async () => {
    const executeJavaScript = vi.fn(() => Promise.resolve(true));
    const webview = fakeWebview(executeJavaScript);

    await writeGuestField(webview, 'hello', 5, 3);

    const script = executeJavaScript.mock.calls[0][0] as string;
    expect(script.endsWith(', 3)')).toBe(true);
  });

  it('JSON-escapes a value carrying a quote, backslash, and newline', async () => {
    // The only thing standing between a dictated transcript and a broken
    // injected script. A naive '"' + value + '"' would end the string
    // literal early on the embedded quote and throw inside the guest instead
    // of writing the field.
    const executeJavaScript = vi.fn(() => Promise.resolve(true));
    const webview = fakeWebview(executeJavaScript);
    const hazardousValue = 'she said "hi"\\then\nleft';

    await writeGuestField(webview, hazardousValue, hazardousValue.length);

    const script = executeJavaScript.mock.calls[0][0] as string;
    expect(script).toContain(JSON.stringify(hazardousValue));
    // The literal characters must NOT appear unescaped in the script text -
    // an unescaped quote there would terminate the argument early.
    expect(script.includes('"she said "hi"')).toBe(false);
  });

  it('sends value, caret, and previousLength as the call arguments, in order', async () => {
    const executeJavaScript = vi.fn(() => Promise.resolve(true));
    const webview = fakeWebview(executeJavaScript);

    await writeGuestField(webview, 'value here', 4, 2);

    const script = executeJavaScript.mock.calls[0][0] as string;
    // The call arguments are the tail of the script, closed by the final ")".
    // Checking the SUFFIX (rather than locating ")(" ourselves) does not
    // depend on that separator being unique inside the function body above it.
    expect(script.endsWith(`${JSON.stringify('value here')}, ${JSON.stringify(4)}, ${JSON.stringify(2)})`)).toBe(true);
  });
});
