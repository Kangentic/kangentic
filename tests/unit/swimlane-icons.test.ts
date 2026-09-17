/**
 * Unit coverage for the new registry-icon pattern introduced alongside the
 * React Compiler rule adoption: `RegistryIcon` (src/renderer/utils/swimlane-icons.tsx)
 * and `AutomationIcon` (src/renderer/components/dialogs/board-manager/automation-icons.tsx)
 * both route a `Map`/lookup-object read through `createElement` in one place,
 * because the compiler rules forbid `const Icon = lookup(name); <Icon />` at
 * each call site (see the JSDoc on `RegistryIcon`). That indirection is new
 * exported branching logic with no prior coverage: the name-registered hit,
 * the unregistered-name-plus-fallback branch, the null/empty-name branch, the
 * no-match-no-fallback null return, and the rest-prop pass-through (which a
 * botched destructure could leak `name`/`fallback` onto the DOM element for).
 * `getSwimlaneIconName`'s custom-icon-vs-role-default priority ladder is also
 * new and untested.
 *
 * This project's vitest config has no React reconciler (see
 * activity-reason-tooltip.test.ts), so every component here is called as a
 * plain function and asserted on the returned element's `.type` / `.props`
 * rather than rendered.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import { Bell, Zap } from 'lucide-react';
import {
  RegistryIcon,
  getSwimlaneIconName,
  ICON_REGISTRY,
} from '../../src/renderer/utils/swimlane-icons';
import { AutomationIcon } from '../../src/renderer/components/dialogs/board-manager/automation-icons';

describe('RegistryIcon', () => {
  it('renders the registered component for a known name', () => {
    const output = RegistryIcon({ name: 'layers' });
    expect(output).not.toBeNull();
    expect(output?.type).toBe(ICON_REGISTRY.get('layers'));
  });

  it('prefers the registered icon over a provided fallback when name is valid', () => {
    const output = RegistryIcon({ name: 'layers', fallback: Bell });
    expect(output?.type).toBe(ICON_REGISTRY.get('layers'));
  });

  it('falls back to the given fallback for an unregistered name', () => {
    const output = RegistryIcon({ name: 'not-a-real-icon-xyz', fallback: Bell });
    expect(output?.type).toBe(Bell);
  });

  it('falls back to the given fallback when name is null', () => {
    const output = RegistryIcon({ name: null, fallback: Bell });
    expect(output?.type).toBe(Bell);
  });

  it('falls back to the given fallback when name is an empty string', () => {
    const output = RegistryIcon({ name: '', fallback: Bell });
    expect(output?.type).toBe(Bell);
  });

  it('renders nothing for an unknown name with no fallback', () => {
    expect(RegistryIcon({ name: 'not-a-real-icon-xyz' })).toBeNull();
  });

  it('passes icon props through and never leaks name/fallback onto the element', () => {
    const output = RegistryIcon({ name: 'layers', size: 16, className: 'x' });
    expect(output?.props).toMatchObject({ size: 16, className: 'x' });
    expect(output?.props).not.toHaveProperty('name');
    expect(output?.props).not.toHaveProperty('fallback');
  });
});

describe('getSwimlaneIconName', () => {
  it('prefers a registered custom icon over the role default', () => {
    expect(getSwimlaneIconName({ icon: 'layers', role: 'done' })).toBe('layers');
  });

  it('falls through to the role default name when the custom icon is unregistered', () => {
    expect(getSwimlaneIconName({ icon: 'not-a-real-icon-xyz', role: 'todo' })).toBe('layers');
    expect(getSwimlaneIconName({ icon: 'not-a-real-icon-xyz', role: 'done' })).toBe(
      'circle-check-big',
    );
  });

  it('returns null when there is no icon and no role', () => {
    expect(getSwimlaneIconName({ icon: null, role: null })).toBeNull();
  });

  it('returns null for an unregistered icon with no role', () => {
    expect(getSwimlaneIconName({ icon: 'not-a-real-icon-xyz', role: null })).toBeNull();
  });
});

describe('AutomationIcon', () => {
  it('renders the mapped component for a known automation type name', () => {
    const output = AutomationIcon({ name: 'bell' });
    expect(output.type).toBe(Bell);
  });

  it('falls back to Zap for an unknown name', () => {
    const output = AutomationIcon({ name: 'not-a-real-automation-type' });
    expect(output.type).toBe(Zap);
  });

  it('does not leak name onto the rendered element props', () => {
    const output = AutomationIcon({ name: 'bell', size: 20 });
    expect(output.props).toMatchObject({ size: 20 });
    expect(output.props).not.toHaveProperty('name');
  });
});
