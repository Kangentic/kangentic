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
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { CodexAdapter } from '../../src/main/agent/adapters/codex/codex-adapter';
import { keepsSessionPermissionMode, resolveEffectivePermissionMode } from '../../src/main/transition-engine/spawn-preamble';

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

/**
 * keepsSessionPermissionMode decides whether a spawn leaves the mode to the
 * agent CLI, so a session the user switched out of plan mode comes back in the
 * mode it was switched to (#1056). A plan column paused four times used to
 * resume in plan mode four times.
 */
describe('keepsSessionPermissionMode', () => {
  const sameColumnResume = {
    isResume: true,
    sameColumnResume: true,
    adapterRestores: true,
    columnMode: 'plan' as const,
    lastLaunchedMode: 'plan',
  };

  it('a resume in the column the session was paused in keeps the session mode', () => {
    expect(keepsSessionPermissionMode(sameColumnResume)).toBe(true);
  });

  it('a move into a column applies that column mode', () => {
    expect(keepsSessionPermissionMode({ ...sameColumnResume, sameColumnResume: false })).toBe(false);
  });

  it('a plan column entered fresh starts in plan mode', () => {
    expect(keepsSessionPermissionMode({ ...sameColumnResume, isResume: false, lastLaunchedMode: null })).toBe(false);
    expect(resolveEffectivePermissionMode(null, 'plan', 'auto')).toBe('plan');
  });

  it('a column whose mode changed since the last launch applies the new mode', () => {
    expect(keepsSessionPermissionMode({ ...sameColumnResume, columnMode: 'auto' })).toBe(false);
  });

  it('a bypass column states its mode, which no CLI restores by itself', () => {
    expect(keepsSessionPermissionMode({
      ...sameColumnResume, columnMode: 'bypassPermissions', lastLaunchedMode: 'bypassPermissions',
    })).toBe(false);
  });

  it('an agent whose CLI does not restore the mode states the column mode', () => {
    expect(keepsSessionPermissionMode({ ...sameColumnResume, adapterRestores: false })).toBe(false);
  });

  it('a record with no mode on it states the column mode', () => {
    expect(keepsSessionPermissionMode({ ...sameColumnResume, lastLaunchedMode: null })).toBe(false);
  });

  // The two spawn chokepoints pass `adapter.restoresPermissionModeOnResume === true`.
  describe('with the real adapters', () => {
    it('Claude declares that its CLI restores the mode, so a same-column resume keeps it', () => {
      const adapter = new ClaudeAdapter();
      expect(adapter.restoresPermissionModeOnResume).toBe(true);
      expect(keepsSessionPermissionMode({
        ...sameColumnResume,
        adapterRestores: adapter.restoresPermissionModeOnResume === true,
      })).toBe(true);
    });

    it('an adapter without the flag states the column mode on the same resume', () => {
      const adapter = new CodexAdapter();
      expect(adapter.restoresPermissionModeOnResume).toBeUndefined();
      expect(keepsSessionPermissionMode({
        ...sameColumnResume,
        adapterRestores: adapter.restoresPermissionModeOnResume === true,
      })).toBe(false);
    });
  });
});
