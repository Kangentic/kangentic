/**
 * Unit coverage for three red-green coverage holes a /code-review pass found on
 * ActivityMark.tsx and CommandTerminalIcon.tsx (both hookless function components
 * introduced with the activity-marks work):
 *
 *   1. ActivityMark's isLabelled derivation (role / aria-hidden), which nothing
 *      previously asserted.
 *   2. The structural claim in ActivityMark's own JSDoc that the mark's inner
 *      markup goes into a sibling <g> so a <title> child stays free (React
 *      forbids `children` alongside `dangerouslySetInnerHTML` on ONE element).
 *   3. CommandTerminalIcon's `showPlus` ternary precedence over `isWorking`.
 *
 * This project's vitest config has no jsdom environment and no
 * @testing-library/react dependency (see panel-error-boundary.test.ts and
 * dialog-form-primitives.test.ts for the established rationale and pattern),
 * so - same as those two files - both components are called directly as
 * plain functions and their real `React.createElement` output
 * (`{ type, props }`) is walked without a renderer.
 *
 * ActivityMark is no longer hookless. It takes a ref on the injected `<g>` and
 * runs a layout effect that anchors the marching dash to the document timeline,
 * so a re-injected or DOM-moved mark does not restart its animation mid-march.
 * Calling a component as a plain function invokes hooks outside a render, where
 * React's dispatcher is null, so the two hooks are stubbed below.
 *
 * That is sound for what this file asserts and nothing more: every assertion
 * here is about the SHAPE of the returned element (role / aria-hidden, and the
 * sibling `<g>` that keeps a `<title>` child free), which the hooks do not
 * influence. The animation behavior the layout effect exists for is covered
 * separately in `activity-mark.test.ts`. If a future assertion depends on ref
 * or effect behavior, this file needs a real reconciler, not a bigger stub.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const withStubbedHooks = {
    ...actual,
    useRef: <T,>(initial: T) => ({ current: initial }),
    useLayoutEffect: () => {},
  };
  // `ActivityMark` reaches the hooks through the DEFAULT import (`React.useRef`),
  // so the stub has to land on `default` as well as the named exports.
  return { ...withStubbedHooks, default: withStubbedHooks };
});
import { ActivityMark, type ActivityMarkProps } from '../../src/renderer/components/ActivityMark';
import { CommandTerminalIcon } from '../../src/renderer/components/command-bar/CommandTerminalIcon';

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

describe('ActivityMark isLabelled derivation (role / aria-hidden)', () => {
  it('is aria-hidden with no role when unlabelled (SidebarActivityCounts usage)', () => {
    const output = ActivityMark({ mark: 'terminal-idle' });
    if (!isElementLike(output)) throw new Error('ActivityMark did not return an element');

    expect(output.props.role).toBeUndefined();
    // aria-hidden is a real boolean in the prop graph (React only serializes
    // it to the string "true" once it reaches the DOM).
    expect(output.props['aria-hidden']).toBe(true);
  });

  it('is role=img and not aria-hidden when labelled via aria-label (TaskCard usage)', () => {
    const output = ActivityMark({ mark: 'agent-idle', 'aria-label': 'Idle' });
    if (!isElementLike(output)) throw new Error('ActivityMark did not return an element');

    expect(output.props.role).toBe('img');
    expect(output.props['aria-hidden']).toBeUndefined();
  });

  it('is role=img and not aria-hidden when labelled via a <title> child alone, with no aria-label', () => {
    // Pins the `|| children !== undefined` half of the isLabelled derivation
    // specifically: the aria-label case above alone would stay green even if
    // that clause were deleted.
    const output = ActivityMark({
      mark: 'agent-idle',
      children: React.createElement('title', null, 'Idle for 3m'),
    });
    if (!isElementLike(output)) throw new Error('ActivityMark did not return an element');

    expect(output.props.role).toBe('img');
    expect(output.props['aria-hidden']).toBeUndefined();
  });
});

describe('ActivityMark <title> child renders alongside the injected mark geometry', () => {
  it('injects the mark geometry into a sibling <g>, not the root <svg>, so a <title> child stays free', () => {
    const title = React.createElement('title', null, 'Idle for 3m');
    const output = ActivityMark({ mark: 'agent-idle', 'aria-label': 'Idle', children: title });
    if (!isElementLike(output)) throw new Error('ActivityMark did not return an element');

    // The root element must be the <svg> itself (not a wrapper <span>), and it
    // must not carry dangerouslySetInnerHTML directly - that is exactly the
    // shape the JSDoc warns against ("must not be simplified into BrandMark's
    // wrapper-<span> + dangerouslySetInnerHTML form"), and it is what would
    // collide with the <title> child on a real reconciler.
    expect(output.type).toBe('svg');
    expect(output.props.dangerouslySetInnerHTML).toBeUndefined();

    const children = output.props.children;
    if (!Array.isArray(children)) {
      throw new Error('expected <svg> to have both the injected <g> and the <title> as children');
    }
    const [markGroup, titleChild] = children;

    if (!isElementLike(markGroup)) throw new Error('expected the first child to be the injected <g>');
    expect(markGroup.type).toBe('g');
    const markup = markGroup.props.dangerouslySetInnerHTML;
    if (typeof markup !== 'object' || markup === null || !('__html' in markup)) {
      throw new Error('expected the <g> to carry dangerouslySetInnerHTML with the mark geometry');
    }
    expect((markup as { __html: string }).__html.length).toBeGreaterThan(0);

    // The <title> must survive as a direct sibling of the <g>, not be
    // swallowed by it.
    expect(titleChild).toBe(title);
    expect(collectText(titleChild)).toBe('Idle for 3m');
  });
});

describe('CommandTerminalIcon showPlus precedence', () => {
  it('renders terminal-new even when tone is thinking (showPlus wins over the working mark)', () => {
    const iconElement = CommandTerminalIcon({ tone: 'thinking', showPlus: true });
    if (!isElementLike(iconElement)) throw new Error('CommandTerminalIcon did not return an element');

    // CommandTerminalIcon renders <ActivityMark ... /> unrendered (nothing
    // here goes through a reconciler), so confirm the wrapped component is
    // still ActivityMark before invoking it directly to reach the <svg>.
    expect(iconElement.type).toBe(ActivityMark);

    const markElement = (iconElement.type as (props: ActivityMarkProps) => React.ReactNode)(
      iconElement.props as ActivityMarkProps,
    );
    if (!isElementLike(markElement)) throw new Error('ActivityMark did not return an element');

    expect(markElement.props['data-mark']).toBe('terminal-new');
  });
});
