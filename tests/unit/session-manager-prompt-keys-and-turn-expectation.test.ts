/**
 * Two reads the push-to-talk and paste paths make of a live session:
 *
 *  - `SessionManager.getPromptEndKeys` is what dictation prepends to its write
 *    and to its erase, so the cursor sits at the end of the draft first. It must
 *    return the session's agent adapter keys, and '' when there is nothing to
 *    send (an unknown session, a shell, an agent that declares none).
 *  - `SessionManager.expectsTurnAfterSubmit` is what the paste engine reads to
 *    decide whether output alone proves a submit. Only an idle session whose
 *    agent reports activity through hooks expects a turn: mid-turn a submitted
 *    message queues, at a permission prompt the Enter answers it, and an agent
 *    read from the PTY may never fire a hook.
 *
 * Both run against a real SessionManager with the real activity engine. The key
 * chain is proven from the real Claude adapter, so dropping `promptEndKeys` from
 * it turns the Claude case red.
 *
 * Tier: Unit. Node-pty is mocked; the pty host core runs in this process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as pty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import {
  ActivityDetection,
  EventType,
  IdleReason,
  type ActivityDetectionStrategy,
  type AgentParser,
} from '../../src/shared/types';

function createMockPty() {
  return {
    pid: 4242,
    cols: 120,
    rows: 30,
    onData: vi.fn(() => ({ dispose: () => undefined })),
    onExit: vi.fn(() => ({ dispose: () => undefined })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

/** An agent with a chosen activity strategy and, optionally, prompt-end keys. */
function agentWith(activity: ActivityDetectionStrategy, promptEndKeys?: string): AgentParser {
  return {
    name: 'test-agent',
    detectFirstOutput: () => false,
    runtime: { activity, reportsTurnEnd: true },
    promptEndKeys,
    removeHooks: () => undefined,
  } as unknown as AgentParser;
}

function getTelemetry(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

/** A spawned session starts out thinking; an Idle event is how its turn ends. */
function settleIdle(sessionId: string): void {
  getTelemetry(manager).ingestEvents(sessionId, [{ ts: Date.now(), type: EventType.Idle }]);
}

let tmpDir: string;
let manager: SessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-prompt-keys-'));
  manager = new SessionManager({
    activityEngineOptions: {
      bgShellEscapeHatchMs: 60_000,
      staleThinkingTimeoutMs: 60_000,
      idleStabilityWindowMs: 0,
    },
  });
});

afterEach(() => {
  manager.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function spawnWith(taskId: string, agentParser: AgentParser | undefined): Promise<string> {
  vi.mocked(pty.spawn).mockReturnValue(createMockPty() as unknown as pty.IPty);
  const session = await manager.spawn({
    taskId,
    command: '',
    cwd: tmpDir,
    agentParser,
    agentName: agentParser ? 'test-agent' : undefined,
  });
  return session.id;
}

describe('SessionManager.getPromptEndKeys', () => {
  it("returns the real Claude adapter's keys for a session built on it", async () => {
    const claude = new ClaudeAdapter();
    const sessionId = await spawnWith('task-claude-keys', claude as unknown as AgentParser);
    const keys = manager.getPromptEndKeys(sessionId);
    expect(keys).not.toBe('');
    expect(keys).toBe(claude.promptEndKeys);
  });

  it("returns the session adapter's own keys, whatever they are", async () => {
    const sessionId = await spawnWith('task-custom-keys', agentWith(ActivityDetection.hooks(), '\x01'));
    expect(manager.getPromptEndKeys(sessionId)).toBe('\x01');
  });

  it('returns an empty string for an agent that declares none', async () => {
    const sessionId = await spawnWith('task-no-keys', agentWith(ActivityDetection.hooks()));
    expect(manager.getPromptEndKeys(sessionId)).toBe('');
  });

  it('returns an empty string for a shell session with no agent', async () => {
    const sessionId = await spawnWith('task-shell', undefined);
    expect(manager.getPromptEndKeys(sessionId)).toBe('');
  });

  it('returns an empty string for an unknown session', () => {
    expect(manager.getPromptEndKeys('no-such-session')).toBe('');
  });
});

describe('SessionManager.expectsTurnAfterSubmit', () => {
  it('is true for an idle session whose agent reports activity through hooks', async () => {
    const sessionId = await spawnWith('task-idle-hooks', agentWith(ActivityDetection.hooks()));
    settleIdle(sessionId);
    expect(getTelemetry(manager).getSessionActivity(sessionId)).toBe('idle');
    expect(manager.expectsTurnAfterSubmit(sessionId)).toBe(true);
  });

  it('is false while the session is thinking, since a submitted message queues', async () => {
    const sessionId = await spawnWith('task-thinking', agentWith(ActivityDetection.hooks()));
    getTelemetry(manager).ingestEvents(sessionId, [{ ts: Date.now(), type: EventType.Prompt }]);
    expect(getTelemetry(manager).getSessionActivity(sessionId)).toBe('thinking');
    expect(manager.expectsTurnAfterSubmit(sessionId)).toBe(false);
  });

  it('is false at a permission prompt, where an Enter answers the prompt', async () => {
    const sessionId = await spawnWith('task-permission', agentWith(ActivityDetection.hooks()));
    const telemetry = getTelemetry(manager);
    telemetry.ingestEvents(sessionId, [{ ts: Date.now(), type: EventType.Prompt }]);
    telemetry.ingestEvents(sessionId, [
      { ts: Date.now() + 1, type: EventType.Idle, detail: IdleReason.Permission, tool: 'Bash' },
    ]);
    expect(telemetry.getSessionActivity(sessionId)).toBe('permission');
    expect(manager.expectsTurnAfterSubmit(sessionId)).toBe(false);
  });

  it.each([
    ['pty', ActivityDetection.pty()],
    ['hooks_and_pty', ActivityDetection.hooksAndPty()],
  ])('is false while idle for an agent whose activity kind is %s', async (_kind, activity) => {
    const sessionId = await spawnWith(`task-${_kind}`, agentWith(activity));
    settleIdle(sessionId);
    expect(getTelemetry(manager).getSessionActivity(sessionId)).toBe('idle');
    expect(manager.expectsTurnAfterSubmit(sessionId)).toBe(false);
  });

  it('is false for a session with no agent', async () => {
    const sessionId = await spawnWith('task-shell-turn', undefined);
    expect(manager.expectsTurnAfterSubmit(sessionId)).toBe(false);
  });

  it('is false for an unknown session', () => {
    expect(manager.expectsTurnAfterSubmit('no-such-session')).toBe(false);
  });
});
