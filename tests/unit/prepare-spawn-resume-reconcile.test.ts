/**
 * Tests for resume-time agent-session-id reconcile WIRING inside
 * prepareAgentSpawn (src/main/transition-engine/session-startup/prepare-spawn.ts).
 *
 * reconcileResumeAgentSessionId itself is fully unit-tested in
 * tests/unit/resume-id-reconcile.test.ts. This file pins the wiring at
 * prepareAgentSpawn's resume branch (issue #481 review coverage hole): that a
 * resume's reconciled id (not the stale DB-stored `resume.agentSessionId`) is
 * what reaches the built command and the returned PreparedSpawn, that the
 * persist callback fires, and that `resume.recordCwd` (not the spawn `cwd`) is
 * what reaches `adapter.locateSessionHistoryFile` as its second argument when
 * provided.
 *
 * No prior test exercised the resume branch at all - the sibling
 * prepare-spawn-first-spawn-lock.test.ts always passes `resume: null`.
 *
 * Neither `resume-id-reconcile.ts` (the reconcile helper) nor
 * `spawn-preamble.ts` (runSpawnPreamble) do any filesystem I/O of their own,
 * so this file mocks only the agent registry, letting `prepareAgentSpawn`,
 * `runSpawnPreamble`, and `reconcileResumeAgentSessionId` run for real against
 * a real mkdtemp project directory (cross-platform-parity: filesystem writes
 * stay under os.tmpdir()).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, SessionStartReport, Swimlane, Task } from '../../src/shared/types';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import { claudeSessionStartLine } from './helpers/claude-session-start';

const buildCommandMock = vi.fn((options: { sessionId?: string }) => `claude --resume ${options.sessionId ?? ''}`);
const locateSessionHistoryFileMock = vi.fn(async (_agentSessionId: string, _cwd: string): Promise<string | null> => null);
const stopBackgroundSessionMock = vi.fn(async (_options: { agentSessionId: string; cliPath: string }): Promise<boolean> => true);

/** The path the stub adapter's `detect` reports, which the reconcile must be handed as `cliPath`. */
const DETECTED_CLI_PATH = '/mock/bin/claude';

// `parseSessionStart` is left off: with it the reconcile also demands a
// SessionStart hook before it follows a status-file swap, which the swap tests
// below do not write. The background-session describe sets it per test.
const statusFile: {
  parseStatus: (raw: string) => { sessionId?: string } | null;
  parseSessionStart?: (hookContext: string) => SessionStartReport | null;
} = {
  parseStatus: (raw: string): { sessionId?: string } | null => {
    try {
      const parsed = JSON.parse(raw) as { session_id?: string };
      return { sessionId: parsed.session_id };
    } catch {
      return null;
    }
  },
};

const adapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: true,
  detect: vi.fn(async () => ({ found: true, path: DETECTED_CLI_PATH, version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: buildCommandMock,
  locateSessionHistoryFile: locateSessionHistoryFileMock,
  stopBackgroundSession: stopBackgroundSessionMock,
  runtime: { statusFile },
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn((agentName: string) => (agentName === 'claude' ? adapterRef : undefined)),
  },
}));

// Referenced from the vi.mock factory above (hoisted), so declared via
// module scope after the mock declaration runs.
const adapterRef = adapter;

import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

const TASK_ID = 'task-resume-reconcile-001';
const LANE_ID = 'lane-main';
const RECORD_ID = 'session-record-resume-1';
const STORED_ID = 'stored-agent-session-id-aaaa';
const FORKED_ID = 'forked-agent-session-id-bbbb';

function makeTask(overrides: Partial<Task> = {}): Task {
  const merged = {
    id: TASK_ID,
    display_id: 1,
    title: 'Resume task',
    description: 'Resume me',
    swimlane_id: LANE_ID,
    position: 0,
    // Non-null task.agent + run_mode 'column_settings': not a first-ever
    // spawn, so lockAdvancedOverridesOnFirstSpawn is a no-op and this file's
    // assertions stay focused on the reconcile wiring.
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    run_mode: 'column_settings',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
  return merged as Task;
}

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Main',
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Swimlane;
}

function makeEffectiveConfig(): AppConfig {
  return {
    agent: {
      permissionMode: 'acceptEdits',
      cliPaths: {},
    },
    mcpServer: { enabled: false },
  } as unknown as AppConfig;
}

describe('prepareAgentSpawn resume-time agent-session-id reconcile wiring', () => {
  let projectPath: string;

  function writeStatusFile(reportedSessionId: string): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({ session_id: reportedSessionId }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    buildCommandMock.mockImplementation((options: { sessionId?: string }) => `claude --resume ${options.sessionId ?? ''}`);
    locateSessionHistoryFileMock.mockResolvedValue('/found/transcript.jsonl');
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-prepare-spawn-reconcile-'));
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  async function runPrepare(resume: { agentSessionId: string; recordId?: string; recordCwd?: string } | null) {
    const sessionRepo = { updateAgentSessionId: vi.fn() };
    const tasksUpdate = vi.fn();
    const result = await prepareAgentSpawn({
      task: makeTask(),
      swimlane: makeSwimlane(),
      // Deliberately different from any recordCwd used below, so a wiring
      // regression that reads `cwd` instead of `resume.recordCwd` is visible.
      cwd: '/mock/spawn-cwd',
      projectId: 'proj-123',
      projectPath,
      effectiveConfig: makeEffectiveConfig(),
      projectDefaultAgent: 'claude',
      projectDefaultModel: null,
      projectDefaultEffort: null,
      resolvedShell: 'bash',
      mcpServerHandle: null,
      resume,
      sessionRepo,
      hasSessionRecord: true,
      tasks: { update: tasksUpdate },
    });
    return { result, sessionRepo, tasksUpdate };
  }

  it('resumes the id reported by the retiring record status.json, not the stale DB-stored id, and pins recordCwd (not the spawn cwd) as the locate probe', async () => {
    writeStatusFile(FORKED_ID);
    const recordCwd = '/mock/record-cwd';

    const { result, sessionRepo } = await runPrepare({
      agentSessionId: STORED_ID,
      recordId: RECORD_ID,
      recordCwd,
    });

    // Red: deleting the `agentSessionId = await reconcileResumeAgentSessionId({...})`
    // call in prepareAgentSpawn's resume branch (falling back to
    // `input.resume!.agentSessionId` directly) makes every one of these
    // STORED_ID instead of FORKED_ID.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.agentSessionId).toBe(FORKED_ID);

    expect(buildCommandMock).toHaveBeenCalledTimes(1);
    const commandOptions = buildCommandMock.mock.calls[0][0] as { sessionId?: string };
    expect(commandOptions.sessionId).toBe(FORKED_ID);

    // The swap is persisted so a LATER resume agrees.
    expect(sessionRepo.updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, FORKED_ID);

    // Red: reverting `cwd: input.resume!.recordCwd ?? cwd` to the spawn `cwd`
    // makes this '/mock/spawn-cwd' instead of recordCwd.
    expect(locateSessionHistoryFileMock).toHaveBeenCalledWith(FORKED_ID, recordCwd, null, null);
  });

  it('falls back to the spawn cwd for the locate probe when recordCwd is omitted', async () => {
    writeStatusFile(FORKED_ID);

    await runPrepare({
      agentSessionId: STORED_ID,
      recordId: RECORD_ID,
      // recordCwd omitted.
    });

    expect(locateSessionHistoryFileMock).toHaveBeenCalledWith(FORKED_ID, '/mock/spawn-cwd', null, null);
  });

  it('keeps the stale DB-stored id when the reported id has no locatable transcript', async () => {
    writeStatusFile(FORKED_ID);
    locateSessionHistoryFileMock.mockResolvedValue(null);

    const { result, sessionRepo } = await runPrepare({
      agentSessionId: STORED_ID,
      recordId: RECORD_ID,
      recordCwd: '/mock/record-cwd',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.agentSessionId).toBe(STORED_ID);
    expect(sessionRepo.updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('skips the reconcile entirely (keeps the caller id unchanged) when no recordId is given', async () => {
    writeStatusFile(FORKED_ID);

    const { result, sessionRepo } = await runPrepare({ agentSessionId: STORED_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.agentSessionId).toBe(STORED_ID);
    expect(sessionRepo.updateAgentSessionId).not.toHaveBeenCalled();
    expect(locateSessionHistoryFileMock).not.toHaveBeenCalled();
  });

  describe('a conversation the record saw move into a background session', () => {
    function writeEventsFile(lines: string[]): void {
      const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), lines.map((line) => `${line}\n`).join(''));
    }

    beforeEach(() => {
      statusFile.parseSessionStart = ClaudeStatusParser.parseSessionStart;
    });

    afterEach(() => {
      delete statusFile.parseSessionStart;
    });

    it('hands the stop the CLI path this spawn detected, so the resume does not run beside the background session', async () => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'fork', 1)]);

      await runPrepare({
        agentSessionId: STORED_ID,
        recordId: RECORD_ID,
        recordCwd: '/mock/record-cwd',
      });

      // Red: deleting `cliPath: detection.path` from prepareAgentSpawn's
      // reconcileResumeAgentSessionId call makes the reconcile skip the stop
      // (`if (cliPath)`), so the resume starts a second process on the
      // conversation and this spy is never called.
      expect(stopBackgroundSessionMock).toHaveBeenCalledTimes(1);
      expect(stopBackgroundSessionMock).toHaveBeenCalledWith({ agentSessionId: STORED_ID, cliPath: DETECTED_CLI_PATH });
    });
  });
});
