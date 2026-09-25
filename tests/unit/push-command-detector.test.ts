import { describe, it, expect, beforeEach } from 'vitest';
import { PushCommandDetector } from '../../src/main/activity-engine/push-command-detector';
import { HOOK_DETAIL_CAP } from '../../src/main/git/push-command';
import { EventType, AgentTool } from '../../src/shared/types';
import type { SessionEvent } from '../../src/shared/types';

const SID = 'session-1';

/**
 * Mirrors pr-command-detector.test.ts: the command string is only on the Bash
 * ToolStart, so the parsed branch is remembered there and reported on that
 * call's ToolEnd. The additions over the PR detector are the `toolId` pairing
 * (a parallel or subagent Bash call ending first must not report the push
 * early), the Interrupted clear, and the truncation guard.
 */
describe('PushCommandDetector', () => {
  let detector: PushCommandDetector;

  beforeEach(() => {
    detector = new PushCommandDetector();
  });

  function event(partial: Partial<SessionEvent> & { type: EventType }): SessionEvent {
    return { ts: Date.now(), ...partial };
  }

  function start(detail: string, toolId?: string): { pushedBranch: string | null } {
    return detector.detect(SID, event({ type: EventType.ToolStart, tool: AgentTool.Bash, detail, toolId }));
  }

  function end(toolId?: string): { pushedBranch: string | null } {
    return detector.detect(SID, event({ type: EventType.ToolEnd, tool: AgentTool.Bash, toolId }));
  }

  it('defaults to no pending', () => {
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('remembers the destination of a Bash git push on ToolStart without reporting it yet', () => {
    expect(start('git push -u origin feature/x')).toEqual({ pushedBranch: null });
    expect(detector.hasPending(SID)).toBe(true);
  });

  it('reports the branch on the matching Bash ToolEnd and clears pending', () => {
    start('git push -u origin feature/x', 'tool-a');
    expect(end('tool-a')).toEqual({ pushedBranch: 'feature/x' });
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('keeps waiting when a DIFFERENT Bash call ends first (parallel or subagent call)', () => {
    start('git push -u origin feature/x', 'tool-a');
    expect(end('tool-b')).toEqual({ pushedBranch: null });
    expect(detector.hasPending(SID)).toBe(true);
    expect(end('tool-a')).toEqual({ pushedBranch: 'feature/x' });
  });

  it('pairs by session alone when either event carries no toolId', () => {
    start('git push -u origin feature/x');
    expect(end('tool-b')).toEqual({ pushedBranch: 'feature/x' });

    start('git push -u origin feature/y', 'tool-c');
    expect(end()).toEqual({ pushedBranch: 'feature/y' });
  });

  it('does not remember a Bash command that names no destination', () => {
    start('git push');
    expect(detector.hasPending(SID)).toBe(false);
    start('npm run typecheck');
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('ignores non-Bash tools', () => {
    detector.detect(SID, event({ type: EventType.ToolStart, tool: AgentTool.Read, detail: 'git push origin feature/x' }));
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('does not report on a Bash ToolEnd when nothing was remembered', () => {
    expect(end()).toEqual({ pushedBranch: null });
  });

  it('a second push start replaces the first', () => {
    start('git push -u origin feature/one', 'tool-a');
    start('git push -u origin feature/two', 'tool-b');
    expect(end('tool-b')).toEqual({ pushedBranch: 'feature/two' });
    expect(end('tool-a')).toEqual({ pushedBranch: null });
  });

  it('an Interrupted turn clears the entry without reporting', () => {
    start('git push -u origin feature/x', 'tool-a');
    detector.detect(SID, event({ type: EventType.Interrupted, tool: AgentTool.Bash }));
    expect(detector.hasPending(SID)).toBe(false);
    expect(end('tool-a')).toEqual({ pushedBranch: null });
  });

  it('refuses a detail at the bridge cap whose refspec runs to the end', () => {
    const tail = ' && git push -u origin feature/cut';
    const detail = `echo ${'a'.repeat(HOOK_DETAIL_CAP - tail.length - 5)}${tail}`;
    expect(detail).toHaveLength(HOOK_DETAIL_CAP);

    start(detail);
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('isolates pending state per session', () => {
    detector.detect('a', event({ type: EventType.ToolStart, tool: AgentTool.Bash, detail: 'git push origin feature/a' }));
    expect(detector.hasPending('a')).toBe(true);
    expect(detector.hasPending('b')).toBe(false);

    const resultB = detector.detect('b', event({ type: EventType.ToolEnd, tool: AgentTool.Bash }));
    expect(resultB).toEqual({ pushedBranch: null });
    expect(detector.hasPending('a')).toBe(true);
  });

  it('takePending returns the branch once and clears it', () => {
    start('git push -u origin feature/x');
    expect(detector.takePending(SID)).toBe('feature/x');
    expect(detector.takePending(SID)).toBeNull();
    expect(detector.hasPending(SID)).toBe(false);
  });

  it('removeSession is idempotent', () => {
    start('git push -u origin feature/x');
    detector.removeSession(SID);
    detector.removeSession(SID);
    expect(detector.hasPending(SID)).toBe(false);
  });
});
