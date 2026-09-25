import { describe, expect, it } from 'vitest';
import { CAPABILITY_VERBS, capabilitySetFromArray, capabilitySetToArray, isCapabilityVerb } from '../../../packages/protocol/src/capabilities/verbs';

describe('capability verbs', () => {
  it('has no shell, file, or arbitrary-command verb', () => {
    const suspicious = CAPABILITY_VERBS.filter((verb) => /shell|file|exec|command|run/i.test(verb));
    expect(suspicious).toEqual([]);
  });

  it('isCapabilityVerb accepts only the known set', () => {
    expect(isCapabilityVerb('move-task')).toBe(true);
    expect(isCapabilityVerb('run-shell-command')).toBe(false);
    expect(isCapabilityVerb('')).toBe(false);
  });

  it('includes register-push (the E2E push registration verb)', () => {
    expect(CAPABILITY_VERBS).toContain('register-push');
    expect(isCapabilityVerb('register-push')).toBe(true);
  });

  it('includes start-session (the second lifecycle verb beside move-task)', () => {
    expect(CAPABILITY_VERBS).toContain('start-session');
    expect(isCapabilityVerb('start-session')).toBe(true);
  });

  it('capabilitySetFromArray drops unrecognized entries (deny-by-default for unknown verbs)', () => {
    const set = capabilitySetFromArray(['read-board', 'delete-everything', 'move-task']);
    expect(capabilitySetToArray(set).sort()).toEqual(['move-task', 'read-board']);
  });

  it('capability set membership is deny-by-default for anything not explicitly granted', () => {
    const set = capabilitySetFromArray(['read-board']);
    expect(set.has('read-board')).toBe(true);
    expect(set.has('answer-permission-prompt')).toBe(false);
  });
});
