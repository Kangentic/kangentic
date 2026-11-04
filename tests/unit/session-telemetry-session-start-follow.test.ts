/**
 * An agent with no status channel follows a conversation move from its
 * SessionStart hook alone (`runtime.sessionId.followsSessionStartMoves`).
 *
 * Qwen's `/clear` and `/branch` start a new session id
 * (`config.startNewSession()` in packages/cli/src/ui/commands/clearCommand.ts,
 * v0.26.6), and Qwen writes no status file. Without the hook, the session
 * record would keep the conversation the terminal started with, and a pause and
 * resume would reopen the conversation the user had cleared away. Driven with the real Qwen
 * adapter, so its own `parseSessionStart` reads the payloads.
 *
 * Test tier: Unit (vitest, no Electron, no processes).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { QwenAdapter } from '../../src/main/agent/adapters/qwen-code';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { claudeSessionStartLine } from './helpers/claude-session-start';

const STARTED = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b';
const CLEARED = '9a8b7c6d-5e4f-4302-9b1a-0f1e2d3c4b5a';

/** A Qwen SessionStart line as event-bridge.js records it (payload fields from hooks/types.ts, v0.26.6). */
function qwenSessionStartLine(agentSessionId: string, source: string, extra: Record<string, unknown> = {}): string {
  const payload = {
    session_id: agentSessionId,
    transcript_path: `C:\\Users\\dev\\.qwen\\projects\\c--users-dev-repo\\chats\\${agentSessionId}.jsonl`,
    cwd: 'C:\\Users\\dev\\repo',
    hook_event_name: 'SessionStart',
    timestamp: '2026-11-03T10:00:00.000Z',
    permission_mode: 'default',
    source,
    model: 'qwen3-coder-plus',
    ...extra,
  };
  return JSON.stringify({ ts: 1, type: 'session_start', hookContext: JSON.stringify(payload) });
}

interface Capture {
  agentReportedId: string;
  conversationMoved: boolean;
}

describe('SessionTelemetry: a SessionStart move switches the id of an agent with no status channel', () => {
  let telemetry: SessionTelemetry;
  let captures: Capture[];

  beforeEach(() => {
    vi.useFakeTimers();
    captures = [];
    telemetry = new SessionTelemetry(
      {
        onUsageChange: () => {},
        onActivityChange: () => {},
        onEvent: () => {},
        onIdleTimeout: () => {},
        onPlanExit: () => {},
        onPRCandidate: () => {},
        onAgentSessionId: (_sessionId, agentReportedId, options) => {
          captures.push({ agentReportedId, conversationMoved: options?.conversationMoved === true });
        },
        requestSuspend: () => {},
        isSessionRunning: () => true,
      },
      { disableBgShellWatcher: true },
    );
  });

  afterEach(() => {
    telemetry.dispose();
    vi.useRealTimers();
  });

  /** The spawn's own SessionStart, the way session-manager feeds each batch. */
  function deliver(lines: string[]): void {
    telemetry.captureHookSessionIds('s1', lines);
    telemetry.noteSessionStartHooks('s1', lines);
  }

  it('a /clear after the launch moves the session to the new id, flagged as a move', () => {
    telemetry.initSession('s1', new QwenAdapter());
    deliver([qwenSessionStartLine(STARTED, 'startup')]);
    deliver([qwenSessionStartLine(CLEARED, 'clear')]);
    expect(captures).toEqual([
      { agentReportedId: STARTED, conversationMoved: false },
      { agentReportedId: CLEARED, conversationMoved: true },
    ]);
  });

  it('a resume or a compaction naming the same id switches nothing', () => {
    telemetry.initSession('s1', new QwenAdapter());
    deliver([qwenSessionStartLine(STARTED, 'resume')]);
    deliver([qwenSessionStartLine(STARTED, 'compact'), qwenSessionStartLine(STARTED, 'resume')]);
    expect(captures.map((capture) => capture.agentReportedId)).toEqual([STARTED]);
  });

  it('a /clear away and a /resume back to the first id each switch the session, both flagged as moves', () => {
    telemetry.initSession('s1', new QwenAdapter());
    deliver([qwenSessionStartLine(STARTED, 'startup')]);
    deliver([qwenSessionStartLine(CLEARED, 'clear')]);
    deliver([qwenSessionStartLine(STARTED, 'resume')]);
    expect(captures).toEqual([
      { agentReportedId: STARTED, conversationMoved: false },
      { agentReportedId: CLEARED, conversationMoved: true },
      { agentReportedId: STARTED, conversationMoved: true },
    ]);
  });

  it('a /clear that is the first SessionStart seen seeds the id and is not a move', () => {
    telemetry.initSession('s1', new QwenAdapter());
    deliver([qwenSessionStartLine(CLEARED, 'clear')]);
    expect(captures).toEqual([{ agentReportedId: CLEARED, conversationMoved: false }]);
  });

  it('a subagent\'s SessionStart, or a launch naming another id, never moves the terminal', () => {
    telemetry.initSession('s1', new QwenAdapter());
    deliver([qwenSessionStartLine(STARTED, 'startup')]);
    deliver([
      qwenSessionStartLine(CLEARED, 'clear', { agent_id: 'agent-3f2a' }),
      qwenSessionStartLine(CLEARED, 'startup'),
    ]);
    expect(captures.map((capture) => capture.agentReportedId)).toEqual([STARTED]);
  });

  // Claude reports its id through the status file, and a hook alone only
  // admits a status write (session-telemetry-conversation-switch.test.ts).
  it('an adapter that does not opt in is not moved by a hook alone', () => {
    telemetry.initSession('s1', new ClaudeAdapter());
    telemetry.notifyAgentSessionId('s1', STARTED);
    telemetry.noteSessionStartHooks('s1', [claudeSessionStartLine(CLEARED, 'clear')]);
    expect(captures.map((capture) => capture.agentReportedId)).toEqual([STARTED]);
  });
});

describe('QwenStatusParser.parseSessionStart', () => {
  const parse = (line: string) => {
    const { hookContext } = JSON.parse(line) as { hookContext: string };
    return new QwenAdapter().runtime.statusFile!.parseSessionStart!(hookContext);
  };

  it('reads the moving sources as moves and startup as a launch', () => {
    for (const source of ['clear', 'branch', 'resume', 'compact']) {
      expect(parse(qwenSessionStartLine(CLEARED, source))).toEqual({ agentSessionId: CLEARED, movesConversation: true, inBackgroundSession: false });
    }
    expect(parse(qwenSessionStartLine(STARTED, 'startup'))?.movesConversation).toBe(false);
    expect(parse(qwenSessionStartLine(STARTED, 'something-new'))?.movesConversation).toBe(false);
  });

  it('reads the real captured startup payload as a launch of its own session', () => {
    const capturePath = path.join(__dirname, '..', 'fixtures', 'qwen-hooks', 'session-background-and-foreground-subagents.jsonl');
    const firstLine = fs.readFileSync(capturePath, 'utf-8').split('\n')[0];
    const capture = JSON.parse(firstLine) as { event: string; stdin: { session_id: string; source: string } };
    expect(capture.event).toBe('SessionStart');
    expect(capture.stdin.source).toBe('startup');
    const report = new QwenAdapter().runtime.statusFile!.parseSessionStart!(JSON.stringify(capture.stdin));
    expect(report).toEqual({ agentSessionId: capture.stdin.session_id, movesConversation: false, inBackgroundSession: false });
  });

  it.each([
    ['a forward slash', '../' + CLEARED],
    ['a bare forward slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a dot-dot segment', '..'],
    ['an embedded dot-dot', 'abc..def'],
  ])('reads nothing from a session_id holding %s', (_label, unsafeId) => {
    expect(parse(qwenSessionStartLine(unsafeId, 'clear'))).toBeNull();
    expect(parse(qwenSessionStartLine(unsafeId, 'startup'))).toBeNull();
  });

  it('reads nothing from a subagent\'s payload or an unreadable one', () => {
    expect(parse(qwenSessionStartLine(CLEARED, 'clear', { agent_id: 'agent-1' }))).toBeNull();
    expect(new QwenAdapter().runtime.statusFile!.parseSessionStart!('not json')).toBeNull();
  });
});
