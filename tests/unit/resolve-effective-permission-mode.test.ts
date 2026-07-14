/**
 * Tests for resolveEffectivePermissionMode
 * (src/main/transition-engine/spawn-preamble.ts).
 *
 * The single source of truth for the effective permission mode a spawn runs
 * under: "a lane forcing 'plan' always wins, else task -> lane -> global".
 * Extracted from two hand-copied ternaries (transition-engine.ts, which
 * receives the lane's mode as its permissionOverride param, and
 * prepare-spawn.ts, which reads the lane directly) - both call shapes are
 * pinned here. Red-green: changing any precedence leg (e.g. letting a task
 * pin beat a plan lane, or dropping the lane fallback) fails the matching
 * case below.
 */

import { describe, it, expect } from 'vitest';
import { resolveEffectivePermissionMode } from '../../src/main/transition-engine/spawn-preamble';

describe('resolveEffectivePermissionMode', () => {
  it("a lane forcing 'plan' beats a task-level pin (plan is a safety guarantee)", () => {
    expect(resolveEffectivePermissionMode('acceptEdits', 'plan', 'auto')).toBe('plan');
  });

  it("a task-level 'plan' pin survives a non-plan lane", () => {
    expect(resolveEffectivePermissionMode('plan', 'acceptEdits', 'auto')).toBe('plan');
  });

  it('the task override beats a non-plan lane mode', () => {
    expect(resolveEffectivePermissionMode('acceptEdits', 'auto', 'plan')).toBe('acceptEdits');
  });

  it('the lane mode beats the global default when the task has no pin', () => {
    expect(resolveEffectivePermissionMode(null, 'acceptEdits', 'auto')).toBe('acceptEdits');
  });

  it('falls through to the global default when task and lane are unset', () => {
    expect(resolveEffectivePermissionMode(null, null, 'auto')).toBe('auto');
  });

  it('handles the prepare-spawn call shape: an undefined lane (swimlane?.permission_mode)', () => {
    expect(resolveEffectivePermissionMode(null, undefined, 'acceptEdits')).toBe('acceptEdits');
    expect(resolveEffectivePermissionMode('auto', undefined, 'acceptEdits')).toBe('auto');
  });

  it('handles the engine call shape: an undefined permissionOverride param', () => {
    expect(resolveEffectivePermissionMode(undefined, undefined, 'auto')).toBe('auto');
    expect(resolveEffectivePermissionMode('plan', undefined, 'auto')).toBe('plan');
  });
});
