/**
 * Unit coverage for IconSlot's own contract, pinned once at the unit tier instead of
 * with a slow browser test per adoption site. IconSlot is adopted at three places
 * (StopButtonIcon in CommandTerminalWindow.tsx, PauseButtonIcon in
 * TaskDetailHeader.tsx, StateGlyph in MonitorCard.tsx), but only StopButtonIcon's
 * adoption is exercised end-to-end (tests/ui/command-terminal.spec.ts, "Stop still
 * fires when the activity mark changes mid-press"). PauseButtonIcon's and
 * StateGlyph's adoptions would fail no test if reverted. This file asserts the
 * mechanism itself is intact, independent of any one call site.
 *
 * Same rationale and pattern as activity-mark-render.test.ts: this project's vitest
 * config has no jsdom environment and no @testing-library/react dependency (see
 * panel-error-boundary.test.ts and dialog-form-primitives.test.ts for the
 * established rationale), so IconSlot is called directly as a plain function and its
 * real `React.createElement` output (`{ type, props }`) is walked without a
 * renderer. IconSlot takes no hooks, so unlike activity-mark-render.test.ts this
 * file needs no `react` hook stubbing.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { IconSlot } from '../../src/renderer/components/IconSlot';

interface ElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function isElementLike(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'props' in node;
}

describe('IconSlot', () => {
  it('renders a <span>', () => {
    const output = IconSlot({ size: 20, children: React.createElement('svg') });
    if (!isElementLike(output)) throw new Error('IconSlot did not return an element');

    expect(output.type).toBe('span');
  });

  it('sizes both width and height in style to the size prop, not a hardcoded default', () => {
    // 37 is a deliberately distinctive value: a hardcoded default (18 or 20, the
    // two sizes the real call sites use) would fail this assertion, whereas a
    // coincidental match at 18 or 20 would not prove the prop is actually wired.
    const output = IconSlot({ size: 37, children: React.createElement('svg') });
    if (!isElementLike(output)) throw new Error('IconSlot did not return an element');

    expect(output.props.style).toEqual({ width: 37, height: 37 });
  });

  it('carries [&>*]:pointer-events-none - the property that puts hits on the span instead of the glyph - and appends the caller className', () => {
    const output = IconSlot({ size: 20, className: 'shrink-0', children: React.createElement('svg') });
    if (!isElementLike(output)) throw new Error('IconSlot did not return an element');

    const className = output.props.className;
    if (typeof className !== 'string') throw new Error('expected className to be a string');
    expect(className).toContain('[&>*]:pointer-events-none');
    expect(className).toContain('shrink-0');
  });

  it('passes children through untouched', () => {
    const child = React.createElement('svg', { 'data-mark': 'control-stop-idle' });
    const output = IconSlot({ size: 20, children: child });
    if (!isElementLike(output)) throw new Error('IconSlot did not return an element');

    expect(output.props.children).toBe(child);
  });
});
