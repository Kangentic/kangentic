/**
 * Tests for the resume check's WIRING inside prepareAgentSpawn
 * (src/main/transition-engine/session-startup/prepare-spawn.ts), the STARTUP
 * spawn chokepoint (crash recovery / auto-spawn reconcile).
 *
 * assessResumeConversation itself is fully unit-tested in
 * tests/unit/resume-conversation-guard.test.ts, and the board-move chokepoint's
 * wiring (executeSpawnAgent) in transition-engine.test.ts. But
 * transition-engine.ts and prepare-spawn.ts are two INDEPENDENT callers of the
 * same check - the board path re-resolves via resolveSpawnIntent, while the
 * startup path has no spawn-intent resolver and decides `canResume` and the
 * prompt locally. A startup recovery spawn carries no prompt, except the recap
 * of a conversation the agent deleted. Per
 * .claude/rules/spawn-entry-point-parity.md, both chokepoints have to apply the
 * same check.
 *
 * Uses a REAL mkdtemp projectPath (matches prepare-spawn-resume-reconcile.test.ts)
 * because assessResumeConversation reads a real status.json from disk, and
 * Claude's proof stats and lists a real projects folder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, Swimlane, Task } from '../../src/shared/types';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import { proveClaudeConversationGone } from '../../src/main/agent/adapters/claude/conversation-gone';

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
  // The REAL Claude status parser, not a stub - assessResumeConversation's
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
   * makes assessResumeConversation resolve `never-started`. */
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

  it('downgrades to fresh: a new agent session id, resume=false on the built command, and no id swap', async () => {
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

    // The reconcile runs before the check now (the check needs the id being
    // resumed), but the status report names the stored id, so nothing swaps.
    expect(sessionRepo.updateAgentSessionId).not.toHaveBeenCalled();
    // A never-started downgrade carries no prompt and stays a quiet resume-style spawn.
    expect(result.data.prompt).toBeNull();
    expect(result.data.startOver).toBe('never-started');
    expect(result.data.resumed).toBe(false);
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
    expect(result.data.startOver).toBeNull();
    expect(result.data.prompt).toBeNull();
  });

  it('starts fresh from the recap when the agent deleted a conversation that had turns', async () => {
    // Claude deletes transcripts older than cleanupPeriodDays. Startup carries
    // no message and no template, so the recap is the whole prompt.
    const projectsRoot = path.join(projectPath, 'claude-projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: STORED_ID,
      transcript_path: path.join(projectsRoot, '-gone-project', `${STORED_ID}.jsonl`),
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      cost: { total_cost_usd: 0.9, total_duration_ms: 60000, total_api_duration_ms: 40000 },
      context_window: { total_input_tokens: 30000, total_output_tokens: 900, context_window_size: 200000, current_usage: null, used_percentage: null },
    }));
    const adapterWithProof = adapter as typeof adapter & { proveConversationGone?: typeof proveClaudeConversationGone };
    adapterWithProof.proveConversationGone = proveClaudeConversationGone;
    try {
      const { result } = await runPrepare();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.startOver).toBe('expired');
      expect(result.data.resumed).toBe(false);
      expect(result.data.agentSessionId).not.toBe(STORED_ID);
      expect(result.data.prompt).toContain('deleted it after its retention period');
      expect(result.data.prompt).toContain('Startup recovery task');
      const commandOptions = buildCommandMock.mock.calls[0][0] as { resume?: boolean; prompt?: string };
      expect(commandOptions.resume).toBe(false);
      expect(commandOptions.prompt).toBe(result.data.prompt);
    } finally {
      delete adapterWithProof.proveConversationGone;
    }
  });
});
