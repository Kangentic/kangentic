/**
 * Tests for the resume-conversation-absent downgrade WIRING inside
 * prepareAgentSpawn (src/main/transition-engine/session-startup/prepare-spawn.ts),
 * the STARTUP spawn chokepoint (crash recovery / auto-spawn reconcile).
 *
 * isResumeConversationAbsent itself is fully unit-tested in
 * tests/unit/resume-conversation-guard.test.ts. The board-move chokepoint's own
 * wiring (executeSpawnAgent in transition-engine.ts) is covered by the
 * "resume downgraded to fresh..." describe block added to
 * transition-engine.test.ts in the same change. But transition-engine.ts and
 * prepare-spawn.ts are two INDEPENDENT implementations of the same guard - the
 * board path re-resolves via resolveSpawnIntent (a different prompt on the
 * fresh branch), while the startup path (this file) has no spawn-intent
 * resolver at all and just flips a local `canResume` boolean, since a startup
 * recovery spawn carries no prompt to begin with (skipPromptTemplate is
 * implicit: `commandOptions.prompt` is always `undefined` here). Per
 * .claude/rules/spawn-entry-point-parity.md, both chokepoints have to apply the
 * same guard - and before this file, only ONE of the two had any test
 * exercising the downgrade actually firing (verified by grep: no
 * resume-suspended / session-auto-resume test configures
 * `adapter.runtime.statusFile`, so the block was structurally unreachable in
 * every existing test for this chokepoint).
 *
 * Deliberately does NOT test the conversation-lineage walk (multiple
 * recordIds): prepare-spawn.ts's own comment says startup recovery holds only
 * the record it is recovering and has no repository handle to walk the
 * lineage, so it always passes a single-element `recordIds` array. Asserting a
 * lineage walk here would be pinning a contract this call site does not
 * implement.
 *
 * Uses a REAL mkdtemp projectPath (matches prepare-spawn-resume-reconcile.test.ts)
 * because isResumeConversationAbsent reads a real status.json from disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, Swimlane, Task } from '../../src/shared/types';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';

const buildCommandMock = vi.fn((options: { sessionId?: string; resume?: boolean }) =>
  `claude ${options.resume ? `--resume ${options.sessionId ?? ''}` : `--session-id ${options.sessionId ?? ''}`}`);
const locateSessionHistoryFileMock = vi.fn(async (_agentSessionId: string, _cwd: string): Promise<string | null> => null);

const adapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: true,
  detect: vi.fn(async () => ({ found: true, path: '/mock/bin/claude', version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: buildCommandMock,
  locateSessionHistoryFile: locateSessionHistoryFileMock,
  // The REAL Claude status parser, not a stub - isResumeConversationAbsent's
  // decision depends on the actual hadTurns / transcriptPath derivation
  // (contextWindow + cost fields), which a `{ sessionId }`-only stub (as used
  // in prepare-spawn-resume-reconcile.test.ts, which never exercises this
  // guard) cannot produce.
  runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } },
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

const TASK_ID = 'task-startup-downgrade-001';
const LANE_ID = 'lane-main';
const RECORD_ID = 'startup-poisoned-record-1';
const STORED_ID = 'stored-agent-session-id-startup';

function makeTask(overrides: Partial<Task> = {}): Task {
  const merged = {
    id: TASK_ID,
    display_id: 1,
    title: 'Startup recovery task',
    description: 'Recover me',
    swimlane_id: LANE_ID,
    position: 0,
    // Non-null task.agent + run_mode 'column_settings': not a first-ever
    // spawn, so lockAdvancedOverridesOnFirstSpawn is a no-op and this file's
    // assertions stay focused on the downgrade wiring.
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

describe('prepareAgentSpawn downgrades a resume to fresh when the conversation was never persisted (startup chokepoint)', () => {
  let projectPath: string;

  /** The exact reported state a session that ended before its first turn
   * leaves behind: a named transcript_path that was never written, and zero
   * cost/token usage. Mirrors resume-conversation-guard.test.ts's and
   * transition-engine.test.ts's identical fixture, which pins that this shape
   * makes isResumeConversationAbsent resolve true. */
  function writeEmptyStatusFile(recordId: string): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', recordId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: STORED_ID,
      transcript_path: path.join(projectPath, 'history', `${STORED_ID}.jsonl`),
      model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
      cost: { total_cost_usd: 0, total_duration_ms: 1200, total_api_duration_ms: 0 },
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 200000,
        current_usage: null,
        used_percentage: null,
      },
    }));
  }

  /** The report a conversation that actually had a turn leaves behind: nonzero
   * cost, and (for this test) a transcript that really exists on disk. Used to
   * prove the guard is not just always-downgrading. */
  function writeRealConversationStatusFile(recordId: string): string {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', recordId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const transcriptPath = path.join(projectPath, 'history', `${STORED_ID}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '{"type":"user","message":"hi"}\n');
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: STORED_ID,
      transcript_path: transcriptPath,
      model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
      cost: { total_cost_usd: 0.02, total_duration_ms: 4000, total_api_duration_ms: 1200 },
      context_window: {
        total_input_tokens: 400,
        total_output_tokens: 120,
        context_window_size: 200000,
        current_usage: null,
        used_percentage: null,
      },
    }));
    return transcriptPath;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    buildCommandMock.mockImplementation((options: { sessionId?: string; resume?: boolean }) =>
      `claude ${options.resume ? `--resume ${options.sessionId ?? ''}` : `--session-id ${options.sessionId ?? ''}`}`);
    locateSessionHistoryFileMock.mockResolvedValue(null);
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-prepare-spawn-downgrade-'));
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  async function runPrepare() {
    const sessionRepo = { updateAgentSessionId: vi.fn() };
    const tasksUpdate = vi.fn();
    const result = await prepareAgentSpawn({
      task: makeTask(),
      swimlane: makeSwimlane(),
      cwd: projectPath,
      projectId: 'proj-123',
      projectPath,
      effectiveConfig: makeEffectiveConfig(),
      projectDefaultAgent: 'claude',
      projectDefaultModel: null,
      projectDefaultEffort: null,
      resolvedShell: 'bash',
      mcpServerHandle: null,
      resume: { agentSessionId: STORED_ID, recordId: RECORD_ID },
      sessionRepo,
      hasSessionRecord: true,
      tasks: { update: tasksUpdate },
    });
    return { result, sessionRepo };
  }

  it('downgrades to fresh: a new agent session id, resume=false on the built command, and no id-reconcile attempt', async () => {
    writeEmptyStatusFile(RECORD_ID);

    const { result, sessionRepo } = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Red: reverting the downgrade block (or inverting its condition) leaves
    // canResume=true, so this stays STORED_ID instead of a freshly generated one.
    expect(result.data.agentSessionId).not.toBe(STORED_ID);
    // Claude accepts caller-specified ids, so the fresh branch still generates
    // a real one rather than leaving it null.
    expect(result.data.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);

    expect(buildCommandMock).toHaveBeenCalledTimes(1);
    const commandOptions = buildCommandMock.mock.calls[0][0] as { resume?: boolean; sessionId?: string };
    expect(commandOptions.resume).toBe(false);
    expect(commandOptions.sessionId).not.toBe(STORED_ID);

    // The reconcile branch (reconcileResumeAgentSessionId) is only reached
    // when canResume stays true - the downgrade must skip it entirely, not
    // just discard its result.
    expect(locateSessionHistoryFileMock).not.toHaveBeenCalled();
    expect(sessionRepo.updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('does NOT downgrade a resume whose conversation actually has turns, even though the same record id is probed', async () => {
    const transcriptPath = writeRealConversationStatusFile(RECORD_ID);
    expect(fs.existsSync(transcriptPath)).toBe(true);

    const { result, sessionRepo } = await runPrepare();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The stored id survives (reconciled, since locateSessionHistoryFileMock
    // resolves null by default in beforeEach - keeping the stored id unchanged
    // is reconcileResumeAgentSessionId's own "not found" contract, not this
    // guard's concern).
    expect(result.data.agentSessionId).toBe(STORED_ID);

    const commandOptions = buildCommandMock.mock.calls[0][0] as { resume?: boolean; sessionId?: string };
    expect(commandOptions.resume).toBe(true);
    expect(commandOptions.sessionId).toBe(STORED_ID);
    expect(sessionRepo.updateAgentSessionId).not.toHaveBeenCalled();
  });
});
