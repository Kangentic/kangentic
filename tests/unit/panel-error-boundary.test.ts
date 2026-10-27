/**
 * Unit coverage for PanelErrorBoundary's ordinary-error (Retry) recovery
 * path, complementing tests/ui/changes-panel-lazy-retry.spec.ts, which
 * exclusively drives the chunk-load (Reload) path at the TaskDetailBody
 * wiring site.
 *
 * This project's vitest config has no jsdom environment and no
 * @testing-library/react dependency (see use-task-split-resize.test.ts and
 * hmr-generation.test.ts for the established rationale and pattern), so a
 * click-driven `render + fireEvent` test is not available here. Instead
 * these tests call the REAL production class's static and instance methods
 * directly and inspect the plain React element objects `render()` returns --
 * `React.createElement` output is a `{ type, props }` object graph that
 * requires no renderer to walk. This exercises the actual
 * `PanelErrorBoundary` code, not a hand-rolled mirror of its logic.
 *
 * `handleRetry`'s real implementation calls `this.setState(...)`. A class
 * instantiated outside a React reconciler (`new PanelErrorBoundary(props)`,
 * no createRoot/render call) gets React's built-in no-op update queue, so an
 * unmodified `this.setState(...)` call would silently do nothing. The
 * `withWorkingSetState` helper below stubs the instance's `setState` to
 * perform the same shallow merge a real reconciler would, so `handleRetry`'s
 * real body runs untouched and its effect on `instance.state` is directly
 * observable.
 *
 * This file also covers `componentDidCatch`'s analytics wiring for BOTH
 * `PanelErrorBoundary` and the root `ErrorBoundary`. `componentDidCatch` is a
 * plain instance method (no reconciler needed to call it), and
 * `window.electronAPI` is stubbed with `vi.stubGlobal` the same way
 * `dictation-sink.test.ts` stubs `window` for a DOM-less unit test. Coverage
 * hole this closes: if either boundary's second `trackRendererError`
 * argument were ever dropped, no existing test would fail.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { Trans } from '@lingui/react';
import { PanelErrorBoundary } from '../../src/renderer/components/PanelErrorBoundary';
import { ErrorBoundary } from '../../src/renderer/components/ErrorBoundary';
import { isTerminalFocused, syncFocusedTerminals } from '../../src/renderer/utils/focused-terminals';

interface BoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function isElementLike(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  // A `<Trans>` element carries its message as a descriptor, not as children:
  // read it the way the element renders it, through the active catalog.
  if (isElementLike(node) && node.type === Trans) return i18n._(node.props as unknown as MessageDescriptor);
  if (isElementLike(node)) return collectText(node.props.children);
  return '';
}

function findByTestId(node: unknown, testId: string): ElementLike | null {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testId);
      if (found) return found;
    }
    return null;
  }
  if (isElementLike(node)) {
    if (node.props['data-testid'] === testId) return node;
    return findByTestId(node.props.children, testId);
  }
  return null;
}

/** See file header: stubs setState with a shallow-merge so handleRetry's real body is observable. */
function withWorkingSetState<Boundary extends PanelErrorBoundary | ErrorBoundary>(
  instance: Boundary,
): Boundary & { state: BoundaryState } {
  const stateful = instance as unknown as Boundary & {
    state: BoundaryState;
    setState: (
      update: Partial<BoundaryState> | ((previous: BoundaryState) => Partial<BoundaryState>),
    ) => void;
  };
  stateful.setState = (update) => {
    const partial = typeof update === 'function' ? update(stateful.state) : update;
    stateful.state = { ...stateful.state, ...partial };
  };
  return stateful;
}

describe('PanelErrorBoundary', () => {
  it('shows the Retry action (not Reload) for an ordinary render error, and reflects the label prop', () => {
    const children = React.createElement('span', null, 'child content');
    const instance = withWorkingSetState(new PanelErrorBoundary({ children, label: 'Changes panel' }));

    const derived = PanelErrorBoundary.getDerivedStateFromError(
      new Error('Cannot read properties of undefined (reading map)'),
    );
    instance.state = { ...instance.state, ...derived };

    const output = instance.render();
    const boundary = findByTestId(output, 'panel-error-boundary');
    expect(boundary).not.toBeNull();
    expect(collectText(boundary)).toContain('Failed to load the Changes panel');
    expect(collectText(boundary)).toContain('Cannot read properties of undefined (reading map)');

    const button = findByTestId(output, 'panel-error-retry');
    expect(button).not.toBeNull();
    expect(collectText(button)).toContain('Retry');
    expect(collectText(button)).not.toContain('Reload');
    // Reverting the `chunkLoadFailure ? handleReload : handleRetry` ternary
    // (hardcoding Reload for both) would rewire this onClick to
    // handleReload instead - this pins the real handler wired up.
    expect(button?.props.onClick).toBe(instance.handleRetry);
  });

  it('defaults the label to "panel" when no label prop is given', () => {
    const children = React.createElement('span', null, 'child content');
    const instance = withWorkingSetState(new PanelErrorBoundary({ children }));

    instance.state = {
      ...instance.state,
      ...PanelErrorBoundary.getDerivedStateFromError(new Error('boom')),
    };

    const boundary = findByTestId(instance.render(), 'panel-error-boundary');
    expect(collectText(boundary)).toContain('Failed to load the panel');
  });

  it('shows the caller-translated message, not the label sentence, when panel and message are given', () => {
    const children = React.createElement('span', null, 'child content');
    const instance = withWorkingSetState(
      new PanelErrorBoundary({
        children,
        panel: 'agent monitor',
        message: 'Failed to load the agent monitor',
      }),
    );

    instance.state = {
      ...instance.state,
      ...PanelErrorBoundary.getDerivedStateFromError(new Error('boom')),
    };

    const text = collectText(findByTestId(instance.render(), 'panel-error-boundary'));
    expect(text).toContain('Failed to load the agent monitor');
    // `panel` is the analytics key, never shown, and no label means no spliced
    // noun: ignoring `message` would fall through to the bare "panel" sentence.
    expect(text).not.toContain('Failed to load the panel');
  });

  it('prefers message over the label sentence when both are given', () => {
    const children = React.createElement('span', null, 'child content');
    const instance = withWorkingSetState(
      new PanelErrorBoundary({
        children,
        label: 'Changes panel',
        message: 'Der Agent-Monitor konnte nicht geladen werden',
      }),
    );

    instance.state = {
      ...instance.state,
      ...PanelErrorBoundary.getDerivedStateFromError(new Error('boom')),
    };

    const text = collectText(findByTestId(instance.render(), 'panel-error-boundary'));
    expect(text).toContain('Der Agent-Monitor konnte nicht geladen werden');
    expect(text).not.toContain('Changes panel');
    expect(text).not.toContain('Failed to load the');
  });

  it('handleRetry resets error state so render() passes through children again (recovery)', () => {
    const children = React.createElement('span', null, 'recovered content');
    const instance = withWorkingSetState(new PanelErrorBoundary({ children }));

    // Simulate a caught ordinary error, same as getDerivedStateFromError
    // being invoked by a real reconciler.
    instance.state = {
      ...instance.state,
      ...PanelErrorBoundary.getDerivedStateFromError(new Error('boom')),
    };
    expect(findByTestId(instance.render(), 'panel-error-boundary')).not.toBeNull();

    // The REAL handleRetry, wired through the working setState stub - not a
    // re-derivation of its logic.
    instance.handleRetry();

    expect(instance.state).toEqual({ hasError: false, error: null });
    const recovered = instance.render();
    expect(recovered).toBe(children);
    expect(findByTestId(recovered, 'panel-error-boundary')).toBeNull();
  });

  it('shows the Reload action (not Retry) for a chunk-load error, without invoking it', () => {
    const children = React.createElement('span', null, 'child content');
    const instance = withWorkingSetState(new PanelErrorBoundary({ children }));

    instance.state = {
      ...instance.state,
      ...PanelErrorBoundary.getDerivedStateFromError(
        new Error('Failed to fetch dynamically imported module: /ChangesPanel.tsx'),
      ),
    };

    const output = instance.render();
    const button = findByTestId(output, 'panel-error-retry');
    expect(button).not.toBeNull();
    expect(collectText(button)).toContain('Reload');
    expect(collectText(button)).not.toContain('Retry');
    expect(button?.props.onClick).toBe(instance.handleReload);
    // Do NOT invoke the click handler: jsdom is not available here, and
    // handleReload calls the real window.location.reload(), which is
    // neither implemented nor safe to trigger in a unit test process.
  });
});

describe('componentDidCatch analytics wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubTrackRendererError(): ReturnType<typeof vi.fn> {
    const trackRendererError = vi.fn();
    vi.stubGlobal('window', { electronAPI: { analytics: { trackRendererError } } });
    return trackRendererError;
  }

  it('PanelErrorBoundary forwards boundary "panel" and the label prop as panel, never the component stack', () => {
    const trackRendererError = stubTrackRendererError();
    // componentDidCatch also calls console.error; silence it so the test's
    // own output stays clean, as instructed by the established pattern.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const children = React.createElement('span', null, 'child content');
    const instance = new PanelErrorBoundary({ children, label: 'Changes panel' });

    instance.componentDidCatch(new Error('Cannot read properties of undefined (reading map)'), {
      componentStack: '\n    at Foo (x)\n    at Bar (y)',
    });

    // The real production label ('Changes panel') must land in `panel`, not
    // just any string - this is the specific regression Hole 2 calls out:
    // PanelErrorBoundary forwarding its OWN `label` prop, not a hardcoded one.
    // React's component stack stays local (console.error) and never crosses
    // IPC: the packaged bundle is minified, so main could not read it, and
    // Sentry carries the real stack.
    expect(trackRendererError).toHaveBeenCalledTimes(1);
    expect(trackRendererError).toHaveBeenCalledWith(
      'Cannot read properties of undefined (reading map)',
      {
        boundary: 'panel',
        panel: 'Changes panel',
      },
    );
    const [, context] = trackRendererError.mock.calls[0];
    expect(context).not.toHaveProperty('componentStack');

    consoleErrorSpy.mockRestore();
  });

  it('PanelErrorBoundary forwards panel: undefined when no label prop is given', () => {
    const trackRendererError = stubTrackRendererError();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const children = React.createElement('span', null, 'child content');
    const instance = new PanelErrorBoundary({ children });

    instance.componentDidCatch(new Error('boom'), { componentStack: '\n    at Foo (x)' });

    expect(trackRendererError).toHaveBeenCalledWith('boom', {
      boundary: 'panel',
      panel: undefined,
    });

    consoleErrorSpy.mockRestore();
  });

  it('PanelErrorBoundary forwards the English panel key, not the translated message', () => {
    const trackRendererError = stubTrackRendererError();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const children = React.createElement('span', null, 'child content');
    const instance = new PanelErrorBoundary({
      children,
      panel: 'agent monitor',
      // Translated by the caller for display only; analytics must stay English.
      message: 'Der Agent-Monitor konnte nicht geladen werden',
    });

    instance.componentDidCatch(new Error('boom'), { componentStack: '\n    at Foo (x)' });

    expect(trackRendererError).toHaveBeenCalledTimes(1);
    expect(trackRendererError).toHaveBeenCalledWith('boom', {
      boundary: 'panel',
      panel: 'agent monitor',
    });

    consoleErrorSpy.mockRestore();
  });

  it('PanelErrorBoundary sends panel over the older label when both are given', () => {
    const trackRendererError = stubTrackRendererError();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const children = React.createElement('span', null, 'child content');
    const instance = new PanelErrorBoundary({ children, panel: 'agent monitor', label: 'Changes panel' });

    instance.componentDidCatch(new Error('boom'), { componentStack: '\n    at Foo (x)' });

    expect(trackRendererError).toHaveBeenCalledWith('boom', {
      boundary: 'panel',
      panel: 'agent monitor',
    });

    consoleErrorSpy.mockRestore();
  });

  it('PanelErrorBoundary falls back to label for analytics when a message is given without a panel', () => {
    const trackRendererError = stubTrackRendererError();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const children = React.createElement('span', null, 'child content');
    const instance = new PanelErrorBoundary({
      children,
      label: 'Changes panel',
      message: 'Der Agent-Monitor konnte nicht geladen werden',
    });

    instance.componentDidCatch(new Error('boom'), { componentStack: '\n    at Foo (x)' });

    // `panel ?? label`: the message is display text and never reaches analytics.
    expect(trackRendererError).toHaveBeenCalledWith('boom', {
      boundary: 'panel',
      panel: 'Changes panel',
    });

    consoleErrorSpy.mockRestore();
  });

  it('ErrorBoundary sends boundary "root" alone: no panel field and no component stack', () => {
    const trackRendererError = stubTrackRendererError();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const children = React.createElement('span', null, 'child content');
    const instance = new ErrorBoundary({ children });

    instance.componentDidCatch(new Error('Something went wrong'), {
      componentStack: '\n    at App (x)',
    });

    expect(trackRendererError).toHaveBeenCalledTimes(1);
    expect(trackRendererError).toHaveBeenCalledWith('Something went wrong', {
      boundary: 'root',
    });
    // ErrorBoundary's context never carries a `panel` key at all - unlike
    // PanelErrorBoundary, which always sets it (to undefined without a label).
    const [, context] = trackRendererError.mock.calls[0];
    expect(context).not.toHaveProperty('panel');
    expect(context).not.toHaveProperty('componentStack');

    consoleErrorSpy.mockRestore();
  });
});

describe('ErrorBoundary (the whole-window boundary)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    syncFocusedTerminals(new Set());
  });

  it('releases the window\'s terminal focus when it catches, in main and in the renderer registry', () => {
    // Every terminal under it is gone while the page lives on. Left in place,
    // the focus set kept the pty host posting output nobody acked, and the
    // agent sat paused at the backpressure high water (task #912).
    const setFocused = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      electronAPI: { sessions: { setFocused }, analytics: { trackRendererError: vi.fn() } },
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    syncFocusedTerminals(new Set(['session-1']));
    expect(isTerminalFocused('session-1')).toBe(true);

    const instance = new ErrorBoundary({ children: React.createElement('span', null, 'app') });
    instance.componentDidCatch(new Error("Cannot read properties of null (reading 'getSnapshot')"), {
      componentStack: '\n    at AppLayout (x)',
    });

    expect(setFocused).toHaveBeenCalledTimes(1);
    expect(setFocused).toHaveBeenCalledWith([]);
    expect(isTerminalFocused('session-1')).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it('offers Reload, which starts a fresh module graph, beside Try again', () => {
    const children = React.createElement('span', null, 'app');
    const instance = withWorkingSetState(new ErrorBoundary({ children }));
    instance.state = { ...instance.state, ...ErrorBoundary.getDerivedStateFromError(new Error('boom')) };

    const output = instance.render();
    const reload = findByTestId(output, 'root-error-reload');
    const retry = findByTestId(output, 'root-error-retry');
    expect(collectText(reload)).toContain('Reload');
    expect(reload?.props.onClick).toBe(instance.handleReload);
    expect(collectText(retry)).toContain('Try again');
    expect(retry?.props.onClick).toBe(instance.handleRetry);
    // handleReload is not invoked here: it needs a stubbed window.location (next test).

    instance.handleRetry();
    expect(instance.render()).toBe(children);
  });

  it('Reload reloads the page once, which starts a fresh module graph', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });

    const instance = new ErrorBoundary({ children: React.createElement('span', null, 'app') });
    instance.handleReload();

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
