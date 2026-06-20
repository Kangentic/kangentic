import { describe, it, expect } from 'vitest';
import {
  resolveSessionTarget,
  resolveIsolatedSwimlaneId,
  resolveForceFresh,
} from '../../src/main/transition-engine/session-isolation';
import type { Swimlane } from '../../src/shared/types';

/** Minimal swimlane stub - only the target/spawn fields matter here. */
function lane(overrides: Partial<Swimlane>): Pick<Swimlane, 'id' | 'session_target' | 'session_spawn_strategy'> {
  return {
    id: 'lane-1',
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    ...overrides,
  };
}

describe('resolveSessionTarget', () => {
  it('defaults to main for null/undefined lanes (legacy columns)', () => {
    expect(resolveSessionTarget(null)).toBe('main');
    expect(resolveSessionTarget(undefined)).toBe('main');
  });

  it('passes through each target value', () => {
    expect(resolveSessionTarget(lane({ session_target: 'main' }))).toBe('main');
    expect(resolveSessionTarget(lane({ session_target: 'isolated' }))).toBe('isolated');
  });
});

describe('resolveIsolatedSwimlaneId', () => {
  it('returns null (main session) for main-target columns', () => {
    expect(resolveIsolatedSwimlaneId(lane({ session_target: 'main' }))).toBeNull();
    expect(resolveIsolatedSwimlaneId(null)).toBeNull();
    expect(resolveIsolatedSwimlaneId(undefined)).toBeNull();
  });

  it('returns the swimlane id for an isolated column', () => {
    expect(resolveIsolatedSwimlaneId(lane({ id: 'review-col', session_target: 'isolated' }))).toBe('review-col');
  });

  it('is stable across calls for the same lane', () => {
    const isolatedLane = lane({ id: 'review-col', session_target: 'isolated' });
    expect(resolveIsolatedSwimlaneId(isolatedLane)).toBe(resolveIsolatedSwimlaneId(isolatedLane));
  });

  it('keeps two different isolated columns separate', () => {
    const a = resolveIsolatedSwimlaneId(lane({ id: 'review-col', session_target: 'isolated' }));
    const b = resolveIsolatedSwimlaneId(lane({ id: 'qa-col', session_target: 'isolated' }));
    expect(a).not.toBe(b);
  });
});

describe('resolveForceFresh', () => {
  it('context-aware default: main columns resume, isolated columns spawn fresh', () => {
    // session_spawn_strategy unset -> default depends on the target.
    expect(resolveForceFresh({ session_target: 'main', session_spawn_strategy: undefined as never })).toBe(false);
    expect(resolveForceFresh({ session_target: 'isolated', session_spawn_strategy: undefined as never })).toBe(true);
    // null/undefined lane resolves to main -> resume.
    expect(resolveForceFresh(null)).toBe(false);
    expect(resolveForceFresh(undefined)).toBe(false);
  });

  it('an explicit spawn strategy always wins over the context-aware default', () => {
    // Persistent isolated track: isolated + create_or_resume -> resume.
    expect(resolveForceFresh(lane({ session_target: 'isolated', session_spawn_strategy: 'create_or_resume' }))).toBe(false);
    // Reset-main: main + always_spawn_new -> fresh.
    expect(resolveForceFresh(lane({ session_target: 'main', session_spawn_strategy: 'always_spawn_new' }))).toBe(true);
    // The two "obvious" combos.
    expect(resolveForceFresh(lane({ session_target: 'isolated', session_spawn_strategy: 'always_spawn_new' }))).toBe(true);
    expect(resolveForceFresh(lane({ session_target: 'main', session_spawn_strategy: 'create_or_resume' }))).toBe(false);
  });
});
