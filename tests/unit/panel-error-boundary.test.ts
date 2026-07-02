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
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { PanelErrorBoundary } from '../../src/renderer/components/PanelErrorBoundary';

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
function withWorkingSetState(
  instance: PanelErrorBoundary,
): PanelErrorBoundary & { state: BoundaryState } {
  const stateful = instance as unknown as PanelErrorBoundary & {
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
