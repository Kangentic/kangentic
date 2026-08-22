/**
 * Guards the literal preload glue that forwards a renderer error's context
 * from `window.electronAPI.analytics.trackRendererError(message, context)`
 * through to `ipcRenderer.send`.
 *
 * Why this needs its own test: TypeScript's structural typing allows a
 * function with FEWER parameters to satisfy an interface that declares an
 * optional trailing parameter - `(message: string) => void` is assignable
 * to `ElectronAPI['analytics']['trackRendererError']`
 * (`(message: string, context?: RendererErrorContext) => void`). So `tsc`
 * would not catch a regression where preload silently stopped forwarding
 * `context`, and neither would the two existing tests that touch this data
 * flow: `tests/unit/panel-error-boundary.test.ts` stubs
 * `window.electronAPI.analytics.trackRendererError` directly (never runs
 * preload.ts), and `tests/unit/register-all-idempotency.test.ts` invokes the
 * registered `ipcMain.on` callback directly (never runs `ipcRenderer.send`).
 * The one line in `src/preload/preload.ts` that actually threads `context`
 * across the process boundary is otherwise exercised nowhere.
 *
 * preload.ts cannot be safely dynamic-imported in vitest: it calls
 * `installConsoleCapture()` at module scope, which patches `window.console.*`
 * and registers `window` listeners unconditionally, so importing it needs a
 * full `window`/`electron` shim just to load. `tests/unit/project-scoped-ipc.test.ts`
 * hits the same constraint and parses the source as text instead - this test
 * follows that established pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PRELOAD_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/preload/preload.ts'), 'utf-8');

describe('preload analytics.trackRendererError forwards its context argument', () => {
  it('passes both parameters through to ipcRenderer.send, in declaration order', () => {
    const match = PRELOAD_SOURCE.match(
      /trackRendererError:\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.send\(([^)]*)\)/,
    );
    expect(
      match,
      'trackRendererError implementation not found in preload.ts in the expected arrow-function shape',
    ).not.toBeNull();

    const [, paramList, callArgs] = match as RegExpMatchArray;
    const paramNames = paramList
      .split(',')
      .map((parameter) => parameter.trim().split(':')[0].replace('?', '').trim())
      .filter(Boolean);
    expect(
      paramNames.length,
      'trackRendererError must declare exactly (message, context)',
    ).toBe(2);
    const [messageParam, contextParam] = paramNames;

    const callArgList = callArgs.split(',').map((argument) => argument.trim());
    // First argument is always the channel constant.
    expect(callArgList[0]).toBe('IPC.TRACK_RENDERER_ERROR');
    // The remaining two must be the declared params, forwarded IN ORDER - this
    // is exactly the shape a "just forward message and drop context" revert
    // would break, and it would break silently (see file header).
    expect(callArgList[1]).toBe(messageParam);
    expect(callArgList[2]).toBe(contextParam);
  });
});
