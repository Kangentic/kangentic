/**
 * `automationNeedsAgent` (src/shared/automation-manifest.ts): does a row of a
 * given type need the task's agent?
 *
 * The answer is the manifest's `needs` list, asked by type and never by the
 * type's name. A Resume of an agent that was paused when its task entered the
 * column runs only the enter rows this says need the agent
 * (`TransitionEngine.executeTransition`'s `onlyRowsNeedingAgent`), so a wrong
 * answer either re-runs a row that already ran at the entry or drops one that
 * is still owed.
 *
 * Tier: Unit (pure function over a constant).
 */
import { describe, it, expect } from 'vitest';
import { AUTOMATION_MANIFEST, automationNeedsAgent } from '../../src/shared/automation-manifest';
import type { AutomationType } from '../../src/shared/types';

const allTypes = Object.keys(AUTOMATION_MANIFEST) as AutomationType[];

describe('automationNeedsAgent', () => {
  it('is true for send_message, whose whole job is to message the agent', () => {
    expect(automationNeedsAgent('send_message')).toBe(true);
  });

  it('is false for notify, which only notifies the user on the desktop and the phone', () => {
    expect(automationNeedsAgent('notify')).toBe(false);
  });

  it('is false for run_script, webhook, move_to_column and the legacy spawn_agent', () => {
    for (const type of ['run_script', 'webhook', 'move_to_column', 'spawn_agent'] as const) {
      expect(automationNeedsAgent(type), type).toBe(false);
    }
  });

  it.each(allTypes)('answers %s the way its manifest entry declares it', (type) => {
    expect(automationNeedsAgent(type)).toBe(AUTOMATION_MANIFEST[type].needs.includes('agent'));
  });

  it('splits the manifest into types that need the agent and types that do not, so the loop above is not vacuous', () => {
    const needing = allTypes.filter((type) => automationNeedsAgent(type));
    const notNeeding = allTypes.filter((type) => !automationNeedsAgent(type));
    expect(needing).toContain('send_message');
    expect(notNeeding).toContain('notify');
  });

  // A stored row can carry a type this build does not know (a retired type, or a
  // newer build's). The group's early filter must read it as not needing the
  // agent rather than throw on the missing manifest entry.
  it.each(['not-a-type', '', 'kill_session', 'SEND_MESSAGE'])('is false, without throwing, for the unknown type "%s"', (type) => {
    expect(() => automationNeedsAgent(type)).not.toThrow();
    expect(automationNeedsAgent(type)).toBe(false);
  });

  // The manifest is a plain object, so a lookup that skipped the own-property
  // check would find these on Object.prototype and read `.needs` of a function.
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])('is false, without throwing, for the inherited object key "%s"', (type) => {
    expect(() => automationNeedsAgent(type)).not.toThrow();
    expect(automationNeedsAgent(type)).toBe(false);
  });
});
