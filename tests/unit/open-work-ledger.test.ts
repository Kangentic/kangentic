/**
 * The open-work ledger (src/main/activity-engine/open-work-ledger.ts): what a
 * session still has open, from its hook events alone. Only an event that says
 * the work ended closes an entry; the engine's display resets never do.
 */
import { describe, it, expect } from 'vitest';
import { OpenWorkLedger } from '../../src/main/activity-engine/open-work-ledger';
import { EventType, IdleReason, type SessionEvent } from '../../src/shared/types';

const SESSION = 'session-1';

function at(ts: number, type: EventType, fields: Partial<SessionEvent> = {}): SessionEvent {
  return { ts, type, ...fields };
}

describe('OpenWorkLedger', () => {
  it('keeps a tool call open through a permission prompt, a subagent start and a prompt, until its own end', () => {
    // The overnight lost-prompt sequence: an Artifact call waiting on a
    // permission prompt, three subagents starting beside it, and the prompt
    // events a nudge's keys made. Only the call's own end closes it.
    const ledger = new OpenWorkLedger();
    ledger.observe(SESSION, at(1, EventType.ToolStart, { tool: 'Artifact', toolId: 'artifact' }));
    ledger.observe(SESSION, at(2, EventType.Idle, { detail: IdleReason.Permission, tool: 'Artifact' }));
    ledger.observe(SESSION, at(3, EventType.SubagentStart, { detail: 'Explore', subagentId: 'agent-1' }));
    ledger.observe(SESSION, at(4, EventType.Notification, { detail: 'Claude needs your permission' }));
    ledger.observe(SESSION, at(5, EventType.Prompt));
    expect(ledger.get(SESSION).toolCalls).toEqual([{ id: 'artifact', tool: 'Artifact', since: 1 }]);

    ledger.observe(SESSION, at(6, EventType.ToolEnd, { tool: 'Artifact', toolId: 'artifact' }));
    expect(ledger.get(SESSION).toolCalls).toEqual([]);
  });

  it('closes every open call at a turn end, an interrupt or a failed turn', () => {
    for (const ending of [
      at(9, EventType.Idle),
      at(9, EventType.Interrupted),
      at(9, EventType.TurnFailed, { detail: 'rate_limit' }),
    ]) {
      const ledger = new OpenWorkLedger();
      ledger.observe(SESSION, at(1, EventType.ToolStart, { tool: 'Bash', toolId: 'bash' }));
      ledger.observe(SESSION, ending);
      expect(ledger.get(SESSION).toolCalls).toEqual([]);
    }
  });

  it('leaves the main agent\'s calls open when a subagent\'s own Stop arrives', () => {
    const ledger = new OpenWorkLedger();
    ledger.observe(SESSION, at(1, EventType.ToolStart, { tool: 'Artifact', toolId: 'artifact' }));
    ledger.observe(SESSION, at(2, EventType.Idle, { subagentId: 'agent-1' }));
    expect(ledger.get(SESSION).toolCalls).toHaveLength(1);
  });

  it('closes a call by name when the agent reports no ids', () => {
    const ledger = new OpenWorkLedger();
    ledger.observe(SESSION, at(1, EventType.ToolStart, { tool: 'Read' }));
    ledger.observe(SESSION, at(2, EventType.ToolStart, { tool: 'Bash' }));
    ledger.observe(SESSION, at(3, EventType.ToolEnd, { tool: 'Read' }));
    expect(ledger.get(SESSION).toolCalls.map((call) => call.tool)).toEqual(['Bash']);
  });

  it('closes a call the transcript shows was denied, and a call moved to the background', () => {
    const ledger = new OpenWorkLedger();
    ledger.observe(SESSION, at(1, EventType.ToolStart, { tool: 'Bash', toolId: 'denied' }));
    ledger.observe(SESSION, at(2, EventType.ToolStart, { tool: 'Bash', toolId: 'moved' }));
    ledger.closeToolCallById(SESSION, 'denied');
    ledger.observe(SESSION, at(3, EventType.BackgroundShellStart, { detail: 'shell-1', toolId: 'moved' }));
    expect(ledger.get(SESSION).toolCalls).toEqual([]);
  });

  it('closes every open call on a synthesized interrupt (a Ctrl+C that fired no hook)', () => {
    const ledger = new OpenWorkLedger();
    ledger.observe(SESSION, at(1, EventType.ToolStart, { tool: 'Bash', toolId: 'bash' }));
    ledger.noteInterrupted(SESSION);
    expect(ledger.get(SESSION).toolCalls).toEqual([]);
  });

  it('keeps a held background shell open until an end names it, with the command its launch reported', () => {
    const ledger = new OpenWorkLedger();
    ledger.observe(SESSION, at(1, EventType.BackgroundShellStart, { detail: 'pnpm verify' }));
    ledger.observe(SESSION, at(2, EventType.BackgroundShellStart, { detail: 'shell-1' }));
    ledger.noteHoldingShell(SESSION, 'shell-1', 2);
    // A turn end does not end a background shell; that is the point of one.
    ledger.observe(SESSION, at(3, EventType.Idle));
    expect(ledger.get(SESSION).backgroundShells).toEqual([{ id: 'shell-1', command: 'pnpm verify', since: 2 }]);

    ledger.observe(SESSION, at(4, EventType.BackgroundShellEnd, { detail: 'shell-1' }));
    expect(ledger.get(SESSION).backgroundShells).toEqual([]);
  });

  it('closes a shell the watcher saw end, or the agent marked a service', () => {
    const ledger = new OpenWorkLedger();
    ledger.noteHoldingShell(SESSION, 'gate', 1);
    ledger.noteHoldingShell(SESSION, 'dev-server', 1);
    ledger.closeShells(SESSION, ['gate', 'dev-server']);
    expect(ledger.get(SESSION).backgroundShells).toEqual([]);
  });

  it('counts a subagent still running after a turn end as background work, and not before', () => {
    const ledger = new OpenWorkLedger();
    ledger.observe(SESSION, at(1, EventType.SubagentStart, { detail: 'test-builder', subagentId: 'agent-1' }));
    expect(ledger.get(SESSION).backgroundSubagents).toEqual([]);

    ledger.observe(SESSION, at(2, EventType.Idle));
    expect(ledger.get(SESSION).backgroundSubagents).toEqual([{ id: 'agent-1', type: 'test-builder', since: 1 }]);

    // A subagent's inner-loop stop (empty detail) ends nothing; its named one does.
    ledger.observe(SESSION, at(3, EventType.SubagentStop, { detail: '', subagentId: 'agent-1' }));
    expect(ledger.get(SESSION).backgroundSubagents).toHaveLength(1);
    ledger.observe(SESSION, at(4, EventType.SubagentStop, { detail: 'test-builder', subagentId: 'agent-1' }));
    expect(ledger.get(SESSION).backgroundSubagents).toEqual([]);
  });

  it('forgets a session at its end', () => {
    const ledger = new OpenWorkLedger();
    ledger.observe(SESSION, at(1, EventType.ToolStart, { tool: 'Bash', toolId: 'bash' }));
    ledger.noteHoldingShell(SESSION, 'gate', 1);
    ledger.observe(SESSION, at(2, EventType.SessionEnd));
    expect(ledger.get(SESSION)).toEqual({ toolCalls: [], backgroundShells: [], backgroundSubagents: [] });
  });

  // A caller may sort or trim what it reads. For a session the ledger has never
  // seen, "nothing open" must be a new value each time, never one object shared
  // by every caller and every session.
  describe('the result of get()', () => {
    const NOTHING_OPEN = { toolCalls: [], backgroundShells: [], backgroundSubagents: [] };

    it('is a fresh value on every call for a session the ledger has never seen', () => {
      const ledger = new OpenWorkLedger();
      const first = ledger.get('never-seen');

      first.toolCalls.push({ id: 'leaked', tool: 'Bash', since: 1 });
      first.backgroundShells.push({ id: 'leaked-shell', command: null, since: 1 });
      first.backgroundSubagents.push({ id: 'leaked-agent', type: null, since: 1 });

      const second = ledger.get('never-seen');
      expect(second).toEqual(NOTHING_OPEN);
      expect(second.toolCalls).not.toBe(first.toolCalls);
      expect(second.backgroundShells).not.toBe(first.backgroundShells);
      expect(second.backgroundSubagents).not.toBe(first.backgroundSubagents);
    });

    it('does not carry one unknown session\'s mutation into another unknown session', () => {
      const ledger = new OpenWorkLedger();
      ledger.get('never-seen-a').toolCalls.push({ id: 'leaked', tool: 'Bash', since: 1 });

      expect(ledger.get('never-seen-b')).toEqual(NOTHING_OPEN);
    });

    it('is a fresh value for a session that ended and was forgotten', () => {
      const ledger = new OpenWorkLedger();
      ledger.observe(SESSION, at(1, EventType.SessionEnd));
      ledger.get(SESSION).toolCalls.push({ id: 'leaked', tool: 'Bash', since: 1 });

      expect(ledger.get(SESSION)).toEqual(NOTHING_OPEN);
    });

    it('is a copy for a known session: trimming its tool calls leaves the ledger\'s record whole', () => {
      const ledger = new OpenWorkLedger();
      ledger.observe(SESSION, at(1, EventType.ToolStart, { tool: 'Bash', toolId: 'bash' }));

      ledger.get(SESSION).toolCalls.length = 0;

      expect(ledger.get(SESSION).toolCalls).toEqual([{ id: 'bash', tool: 'Bash', since: 1 }]);
    });
  });
});
