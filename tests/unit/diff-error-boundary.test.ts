/**
 * Every error boundary reaches Sentry through the root's `onCaughtError`
 * (`src/renderer/index.tsx` -> `reportCaughtRenderError`), which React hands the
 * boundary instance. These pin, for the three real boundary classes, that the
 * boundary names itself through `boundaryReportTags` and that its own
 * `componentDidCatch` sends nothing, so a caught error is one event, not two.
 *
 * This project's vitest config has no jsdom environment (see
 * panel-error-boundary.test.ts's header), so each REAL class is instantiated
 * directly and `componentDidCatch` is called as a plain method.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({
  init: vi.fn(),
  captureException: mocks.captureException,
}));

import { DiffErrorBoundary } from '../../src/renderer/components/dialogs/task-detail/changes/DiffErrorBoundary';
import { PanelErrorBoundary } from '../../src/renderer/components/PanelErrorBoundary';
import { ErrorBoundary } from '../../src/renderer/components/ErrorBoundary';
import { reportCaughtRenderError } from '../../src/renderer/error-reporting';

const children = React.createElement('span', null, 'child content');

describe('a boundary reports once, through the root onCaughtError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('window', { electronAPI: { analytics: { trackRendererError: vi.fn() }, sessions: { setFocused: vi.fn() } } });
  });

  afterEach(() => {
    mocks.captureException.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['DiffErrorBoundary', () => new DiffErrorBoundary({ children }), { boundary: 'diff' }],
    ['PanelErrorBoundary', () => new PanelErrorBoundary({ children, panel: 'agent monitor' }), { boundary: 'panel', panel: 'agent monitor' }],
    ['ErrorBoundary', () => new ErrorBoundary({ children }), { boundary: 'root' }],
  ])('%s sends nothing itself and is tagged by the root handler', (_name, build, expectedTags) => {
    const instance = build();
    const error = new Error('Illegal value for lineNumber');
    instance.componentDidCatch(error, { componentStack: '\n    at Foo (x)' });
    expect(mocks.captureException).not.toHaveBeenCalled();

    reportCaughtRenderError(error, { componentStack: '\n    at Foo (x)', errorBoundary: instance });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect((mocks.captureException.mock.calls[0][1] as { tags: Record<string, string> }).tags).toMatchObject(expectedTags);
  });

  it('is wired on the one createRoot', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.tsx'), 'utf8');
    expect(source.match(/createRoot\(/g)).toHaveLength(1);
    expect(source).toMatch(/createRoot\(document\.getElementById\('root'\)!, \{[\s\S]*?onCaughtError:[\s\S]*?reportCaughtRenderError\(error, errorInfo\)/);
  });
});
