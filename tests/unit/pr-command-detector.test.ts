import { describe, it, expect, beforeEach } from 'vitest';
import { PRCommandDetector } from '../../src/main/activity-engine/pr-command-detector';
import { EventType, AgentTool } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

const SID = 'session-1';

describe('PRCommandDetector', () => {
  let detector: PRCommandDetector;

  beforeEach(() => {
    detector = new PRCommandDetector();
  });

  function event(partial: Partial<SessionEvent> & { type: EventType }): SessionEvent {
    return { ts: Date.now(), ...partial };
  }

  it('defaults to no pending', () => {
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('flips pending on a Bash ToolStart that matches a PR command', () => {
    const result = detector.detect(SID, event({
      type: EventType.ToolStart,
      tool: AgentTool.Bash,
      detail: 'gh pr create --fill',
    }));
    expect(result.fireCandidate).toBe(false);
    expect(detector.hasPending(SID)).toBe(true);
  });

  it('does not flip pending on a non-PR Bash command', () => {
    detector.detect(SID, event({
      type: EventType.ToolStart,
      tool: AgentTool.Bash,
      detail: 'npm run typecheck',
    }));
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('does not flip pending on non-Bash tools', () => {
    detector.detect(SID, event({
      type: EventType.ToolStart,
      tool: AgentTool.Read,
      detail: 'gh pr create',
    }));
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('fires candidate on the matching Bash ToolEnd and clears pending', () => {
    detector.detect(SID, event({
      type: EventType.ToolStart,
      tool: AgentTool.Bash,
      detail: 'gh pr create --fill',
    }));
    expect(detector.hasPending(SID)).toBe(true);

    const endResult = detector.detect(SID, event({
      type: EventType.ToolEnd,
      tool: AgentTool.Bash,
    }));
    expect(endResult.fireCandidate).toBe(true);
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('does not fire on a Bash ToolEnd when no pending PR was flagged', () => {
    const result = detector.detect(SID, event({
      type: EventType.ToolEnd,
      tool: AgentTool.Bash,
    }));
    expect(result.fireCandidate).toBe(false);
  });

  it('isolates pending state per session', () => {
    detector.detect('a', event({
      type: EventType.ToolStart,
      tool: AgentTool.Bash,
      detail: 'gh pr create',
    }));
    expect(detector.hasPending('a')).toBe(true);
    expect(detector.hasPending('b')).toBe(false);

    const resultB = detector.detect('b', event({
      type: EventType.ToolEnd,
      tool: AgentTool.Bash,
    }));
    expect(resultB.fireCandidate).toBe(false);
    expect(detector.hasPending('a')).toBe(true);
  });

  it('clearPending drops the flag without firing', () => {
    detector.detect(SID, event({
      type: EventType.ToolStart,
      tool: AgentTool.Bash,
      detail: 'gh pr create',
    }));
    detector.clearPending(SID);
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('removeSession is idempotent', () => {
    detector.removeSession(SID);
    detector.removeSession(SID);
    expect(detector.hasPending(SID)).toBe(false);
  });
});
