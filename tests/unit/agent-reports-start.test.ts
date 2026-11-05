/**
 * Which adapters say their agent reports its own start (`reportsAgentStart`).
 *
 * A session of an adapter that declares it is judged a launch that never
 * started when the agent-absence sweep finds no sign of a start (Claude's and
 * Droid's SessionStart hook). For any other adapter silence proves nothing, so
 * the flag must stay off: a wrong `true` pauses a healthy task whose agent
 * simply has no start signal. Checked over the REAL registry, so a new adapter
 * is covered without an edit here.
 */
import { describe, it, expect } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';

const REPORTS_START = ['claude', 'droid'];

describe('reportsAgentStart over the registered adapters', () => {
  it('is declared by Claude and Droid', () => {
    for (const name of REPORTS_START) {
      expect(agentRegistry.get(name).reportsAgentStart, name).toBe(true);
    }
  });

  it('is declared by no other adapter', () => {
    const others = agentRegistry.list().filter((name) => !REPORTS_START.includes(name));
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) {
      expect(agentRegistry.get(name).reportsAgentStart === true, name).toBe(false);
    }
  });
});
