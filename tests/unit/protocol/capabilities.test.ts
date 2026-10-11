import { describe, expect, it } from 'vitest';
import { CAPABILITY_VERBS, capabilitySetFromArray, capabilitySetToArray, isCapabilityVerb } from '../../../packages/protocol/src/capabilities/verbs';

/**
 * Verbs whose NAME matches the shell/file/command filter below but which were
 * reviewed and are not shell, file or arbitrary-command verbs. Each entry
 * needs its reason; adding one is a protocol-security decision, not a way to
 * quiet the test.
 *
 * - `command-terminal`: starts or stops a Command Terminal, which is the
 *   project's AGENT CLI at its root (the desktop's own Ctrl+Shift+P terminal).
 *   The phone names no command, and the desktop ends the session when the agent
 *   exits, so no bare shell is ever left for the phone to reach.
 */
const REVIEWED_VERB_NAMES: readonly string[] = ['command-terminal'];

describe('capability verbs', () => {
  it('has no shell, file, or arbitrary-command verb', () => {
    const suspicious = CAPABILITY_VERBS.filter((verb) => /shell|file|exec|command|run/i.test(verb) && !REVIEWED_VERB_NAMES.includes(verb));
    expect(suspicious).toEqual([]);
  });

  it('keeps the reviewed-name list to verbs that exist', () => {
    for (const verb of REVIEWED_VERB_NAMES) expect(isCapabilityVerb(verb)).toBe(true);
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

  it('appends pause-session after start-session (the third lifecycle verb)', () => {
    expect(isCapabilityVerb('pause-session')).toBe(true);
    // Append-only: the desktop mirrors the tuple index for index.
    expect(CAPABILITY_VERBS.indexOf('pause-session')).toBe(CAPABILITY_VERBS.indexOf('start-session') + 1);
  });

  it('appends command-terminal after pause-session, as the 13th verb', () => {
    expect(isCapabilityVerb('command-terminal')).toBe(true);
    expect(CAPABILITY_VERBS.indexOf('command-terminal')).toBe(CAPABILITY_VERBS.indexOf('pause-session') + 1);
    expect(CAPABILITY_VERBS).toHaveLength(13);
    expect(CAPABILITY_VERBS[CAPABILITY_VERBS.length - 1]).toBe('command-terminal');
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
