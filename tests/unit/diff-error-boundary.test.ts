/**
 * Unit coverage for DiffErrorBoundary.componentDidCatch's Sentry reporting.
 * Mirrors panel-error-boundary.test.ts's "componentDidCatch analytics wiring"
 * describe block: this project's vitest config has no jsdom environment (see
 * that file's header for the established rationale), so the REAL production
 * class is instantiated directly (`new DiffErrorBoundary(props)`, no
 * reconciler) and `componentDidCatch` is invoked as a plain instance method.
 *
 * Unlike PanelErrorBoundary and the root ErrorBoundary, DiffErrorBoundary's
 * componentDidCatch does not call window.electronAPI.analytics.trackRendererError
 * at all - it forwards only through reportBoundaryError (src/renderer/error-reporting.ts),
 * which itself calls @sentry/electron/renderer's captureException. So the
 * "global the reporter ultimately calls" here is that SDK export, mocked the
 * same way tests/unit/error-reporting-renderer.test.ts mocks it, rather than
 * window.electronAPI. Coverage hole this closes: if the
 * `reportBoundaryError(error)` line in DiffErrorBoundary.componentDidCatch
 * were ever dropped, no existing test would fail - it would only reach
 * Sentry through the async, out-of-band monaco crash class the boundary's own
 * comment says it does NOT cover.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({
  init: vi.fn(),
  captureException: mocks.captureException,
}));

import { DiffErrorBoundary } from '../../src/renderer/components/dialogs/task-detail/changes/DiffErrorBoundary';

describe('DiffErrorBoundary componentDidCatch analytics wiring', () => {
  afterEach(() => {
    mocks.captureException.mockReset();
  });

  it('forwards the caught error to Sentry via reportBoundaryError', () => {
    // componentDidCatch also calls console.error; silence it so the test's
    // own output stays clean, matching the established pattern.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const children = React.createElement('span', null, 'child content');
    const instance = new DiffErrorBoundary({ children });

    const error = new Error('Illegal value for lineNumber');
    instance.componentDidCatch(error, { componentStack: '\n    at Foo (x)\n    at Bar (y)' });

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException).toHaveBeenCalledWith(error);

    consoleErrorSpy.mockRestore();
  });
});
