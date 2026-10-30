/**
 * What `executeSpawnAgent` does around the recap of an expired conversation
 * (src/main/transition-engine/transition-engine.ts).
 *
 * A resume whose conversation the agent deleted starts a fresh session whose
 * opening prompt is a recap (src/main/agent/shared/expired-conversation-recap.ts).
 * Two things this pass added are pinned here, against the real engine, the real
 * recap builder and Claude's real proof that a conversation is gone:
 *
 * - **Only the main session's recap is marked.** On the task's main session the
 *   recap is the whole prompt and asks the agent to summarize and wait, so the
 *   turn that answers it runs no On agent turn end rows
 *   (automations/turn-end/recap-turns.ts). An isolated column's expired resume
 *   runs its own prompt with the recap as context, and a resume that was not
 *   expired has no recap at all: neither is marked.
 * - **The recap leaves room for the caller's own text.** The recap rides the
 *   command line beside the column's own fresh prompt (an isolated column) and a
 *   handoff pointer, so its optional parts fit in what those leave. The main
 *   session reserves only the handoff pointer: its column message is dropped.
 *
 * The harness is the one in transition-engine.test.ts, trimmed to what the
 * expired-conversation path touches. It uses a REAL mkdtemp root: the check reads
 * a real status.json, and Claude's proof stats and lists a real projects folder
 * (this file mocks only fs.mkdirSync, so fs.promises reaches the disk).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import { isRecapTurn, resetRecapSessionsForTests } from '../../src/main/automations/turn-end/recap-turns';
import { INLINE_PROMPT_BUDGET, commandLineLength } from '../../src/main/agent/shared/prompt-budget';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import { proveClaudeConversationGone } from '../../src/main/agent/adapters/claude/conversation-gone';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { ConversationExpiredNotice } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Harness (trimmed from transition-engine.test.ts)
// ---------------------------------------------------------------------------

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-abc-1',
    title: 'Fix login flow',
    description: 'Step 1: check OAuth.\n\nStep 2: refresh token.',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    agent: null,
    ...overrides,
  };
}

function makeSessionRepo() {
  return {
    getLatestForTask: vi.fn(() => null),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => null),
    insert: vi.fn(),
    update: vi.fn(),
    updateAppliedSettings: vi.fn(),
    compareAndUpdateStatus: vi.fn(() => true),
    updateAgentSessionId: vi.fn(),
    listForTaskNewestFirst: vi.fn(() => []),
  };
}

function makeTaskRepo() {
  return {
    update: vi.fn(),
    recordWorktree: vi.fn(),
    getById: vi.fn(() => undefined),
    recoverLegacyWorktreeFolder: vi.fn(() => null),
    setWorktreeSkipReason: vi.fn(),
  };
}

/** A session manager whose spawn answers with the id it was asked to use, as the real one does. */
function makeSessionManager() {
  return {
    spawn: vi.fn(async (options: { id: string; command: string }) => ({ id: options.id, status: 'running' })),
    getShell: vi.fn(async () => 'bash'),
  };
}

const mockAdapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: true,
  defaultPermission: 'default',
  launchOptions: undefined,
  detect: vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  // Returns a string that embeds the prompt; the test reads the prompt from the options.
  buildCommand: vi.fn((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`),
  buildEnv: undefined,
  getExitSequence: vi.fn(() => ['\x03']),
  removeHooks: vi.fn(),
  runtime: undefined as { statusFile?: { parseStatus: (raw: string) => unknown } } | undefined,
  locateSessionHistoryFile: vi.fn(async (): Promise<string | null> => null),
  proveConversationGone: undefined as AgentAdapter['proveConversationGone'],
  resumePromptDelivery: 'command-line' as AgentAdapter['resumePromptDelivery'],
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getOrThrow: vi.fn(() => mockAdapter),
    list: vi.fn(() => ['claude']),
  },
}));

// Transparent: the cwd migration body would touch the real filesystem.
vi.mock('../../src/main/transition-engine/resume-cwd-migration', () => ({
  migrateResumeCwdIfRenamed: vi.fn(async () => {}),
}));

// Pass-through: the stub adapter detects '/usr/bin/claude' under 'bash', which the real helper leaves alone.
vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: vi.fn(async (input: { agentPath: string; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  // The engine uses `import fs from 'node:fs'` (default import), so the default
  // export needs the mocked mkdirSync too, or the session directory is created
  // for real under the test's working directory.
  const mocked = { ...original, mkdirSync: vi.fn() };
  return { ...mocked, default: mocked };
});

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    constructor(_projectPath: string) {}
    async withLock<T>(job: () => Promise<T> | T): Promise<T> {
      return job();
    }
    ensureWorktree = vi.fn();
  },
}));

type EngineArgs = ConstructorParameters<typeof TransitionEngine>;

function makeEngine(options: {
  sessionManager?: ReturnType<typeof makeSessionManager>;
  sessionRepo?: ReturnType<typeof makeSessionRepo>;
  projectPath: string;
  services?: EngineArgs[8];
  /** The project's configured default base branch. Defaults to 'main'. */
  defaultBaseBranch?: string;
}) {
  const sessionManager = options.sessionManager ?? makeSessionManager();
  const sessionRepo = options.sessionRepo ?? makeSessionRepo();
  const getConfig = vi.fn(() => ({
    permissionMode: 'default',
    projectPath: options.projectPath,
    projectId: 'proj-1',
    projectName: 'Mock project',
    gitConfig: { worktreesEnabled: false, defaultBaseBranch: options.defaultBaseBranch ?? 'main', autoCleanup: false, copyFiles: [] },
    mcpServerEnabled: false,
    mcpServerUrl: undefined,
    mcpServerToken: undefined,
    defaultAgent: 'claude',
    cliPathOverrides: {},
    executionServers: {},
    execution: {},
    launchOptions: {},
  }));
  const engine = new TransitionEngine(
    sessionManager as unknown as EngineArgs[0],
    { submitKeystrokes: vi.fn() } as unknown as EngineArgs[1],
    makeTaskRepo() as unknown as EngineArgs[2],
    getConfig as unknown as EngineArgs[3],
    sessionRepo as unknown as EngineArgs[4],
    { getPathsForTask: vi.fn(() => []) } as unknown as EngineArgs[5],
    undefined,
    undefined,
    options.services,
  );
  return { engine, sessionManager, sessionRepo };
}

type SpawnTask = Parameters<TransitionEngine['resumeSuspendedSession']>[0];
type LegacySpawnConfig = Parameters<TransitionEngine['runLegacySpawnAgent']>[0];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransitionEngine - the recap of an expired conversation (executeSpawnAgent chokepoint)', () => {
  const RECORD_ID = 'expired-record-1';
  const AGENT_SESSION_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
  const LAST_ACTIVE_AT = '2026-08-16T14:00:00.000Z';
  const ISOLATED_LANE_ID = 'lane-review';

  let projectPath: string;
  let projectsRoot: string;
  let capturedOptions: { resume?: boolean; prompt?: string } | undefined;

  async function writeStatusWithTurns(): Promise<void> {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: AGENT_SESSION_ID,
      transcript_path: path.join(projectsRoot, '-gone-project', `${AGENT_SESSION_ID}.jsonl`),
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      cost: { total_cost_usd: 1.25, total_duration_ms: 90000, total_api_duration_ms: 60000 },
      context_window: {
        total_input_tokens: 52000,
        total_output_tokens: 3100,
        context_window_size: 200000,
        current_usage: { input_tokens: 52000, output_tokens: 3100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        used_percentage: 27,
      },
    }));
  }

  /** A repo holding one suspended record of the main session, or of the isolated column's. */
  function resumableRepo(isolatedSwimlaneId: string | null = null) {
    const sessionRepo = makeSessionRepo();
    const record = {
      id: RECORD_ID,
      agent_session_id: AGENT_SESSION_ID,
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: projectPath,
      isolated_swimlane_id: isolatedSwimlaneId,
      started_at: '2026-08-16T13:00:00.000Z',
      suspended_at: LAST_ACTIVE_AT,
      exited_at: null,
    };
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(record as never);
    sessionRepo.listForTaskNewestFirst.mockReturnValue([record] as never);
    return sessionRepo;
  }

  /** Text that grows to whatever room it is asked for: the most a recap source could hand back. */
  function conversationText(maxChars: number): string {
    const sentence = 'The agent read the file and ran the checks. ';
    return sentence.repeat(Math.ceil(maxChars / sentence.length)).slice(0, maxChars);
  }

  /** A recap source that returns as much of the old conversation as it is asked for, and records the ask. */
  function greedyTailSource() {
    const requestedRooms: number[] = [];
    return {
      requestedRooms,
      sources: {
        readConversationTail: vi.fn(async (_agentSessionId: string, maxChars: number) => {
          requestedRooms.push(maxChars);
          return conversationText(maxChars);
        }),
      },
    };
  }

  /** The id of the one session the engine spawned. */
  function spawnedSessionId(sessionManager: ReturnType<typeof makeSessionManager>): string {
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    return sessionManager.spawn.mock.calls[0][0].id;
  }

  /** A moment before now: the start of a turn that ran while the session spawned. */
  const aTurnStartedBeforeNow = (): number => Date.now() - 60_000;

  beforeEach(async () => {
    vi.clearAllMocks();
    // The engine narrates every spawn step; the assertions read the prompt, not the log.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    resetRecapSessionsForTests();
    capturedOptions = undefined;
    mockAdapter.buildCommand.mockImplementation((options: { resume?: boolean; prompt?: string }) => {
      capturedOptions = options;
      return `claude ${options.prompt ?? ''}`;
    });
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-te-recap-'));
    projectsRoot = path.join(projectPath, 'claude-projects');
    await fs.promises.mkdir(projectsRoot, { recursive: true });
    mockAdapter.runtime = { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } };
    mockAdapter.proveConversationGone = proveClaudeConversationGone;
    await writeStatusWithTurns();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectPath, { recursive: true, force: true });
    mockAdapter.runtime = undefined;
    mockAdapter.proveConversationGone = undefined;
    resetRecapSessionsForTests();
  });

  describe('which sessions are marked as having opened on the recap', () => {
    it('marks the main session\'s recap, under the id of the session it spawned', async () => {
      const { engine, sessionManager } = makeEngine({ sessionRepo: resumableRepo(), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, '/code-review', undefined, 'claude',
      );

      expect(outcome).toMatchObject({ startOver: 'expired', recapOnly: true });
      expect(isRecapTurn(spawnedSessionId(sessionManager), aTurnStartedBeforeNow())).toBe(true);
    });

    it('marks no other session: the old record\'s id, the agent\'s conversation id and the task id are not marked', async () => {
      const { engine } = makeEngine({ sessionRepo: resumableRepo(), projectPath });

      await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, '/code-review', undefined, 'claude',
      );

      expect(isRecapTurn(RECORD_ID, aTurnStartedBeforeNow())).toBe(false);
      expect(isRecapTurn(AGENT_SESSION_ID, aTurnStartedBeforeNow())).toBe(false);
      expect(isRecapTurn('task-abc-1', aTurnStartedBeforeNow())).toBe(false);
    });

    it('does not mark an isolated column\'s expired resume: it runs its own prompt with the recap as context', async () => {
      const { engine, sessionManager } = makeEngine({ sessionRepo: resumableRepo(ISOLATED_LANE_ID), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, true, '/code-review', undefined, 'claude',
        undefined, { isolatedSwimlaneId: ISOLATED_LANE_ID },
      );

      expect(outcome).toMatchObject({ startOver: 'expired', recapOnly: false });
      expect(isRecapTurn(spawnedSessionId(sessionManager), aTurnStartedBeforeNow())).toBe(false);
    });

    it('does not mark a resume that was not expired (another project folder still holds the file)', async () => {
      const elsewhere = path.join(projectsRoot, '-renamed-project', `${AGENT_SESSION_ID}.jsonl`);
      await fs.promises.mkdir(path.dirname(elsewhere), { recursive: true });
      fs.writeFileSync(elsewhere, '{"type":"user"}\n');
      const { engine, sessionManager } = makeEngine({ sessionRepo: resumableRepo(), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, '/code-review', undefined, 'claude',
      );

      expect(outcome).toEqual({ startOver: null, recapOnly: false, unsentPrompt: null });
      expect(capturedOptions?.resume).toBe(true);
      expect(isRecapTurn(spawnedSessionId(sessionManager), aTurnStartedBeforeNow())).toBe(false);
    });

    it('does not mark a plain fresh spawn, which has no resume to expire', async () => {
      const { engine, sessionManager } = makeEngine({ projectPath });

      await engine.runLegacySpawnAgent(
        { promptTemplate: '{{task_xml}}' } as unknown as LegacySpawnConfig,
        makeTask() as unknown as SpawnTask,
      );

      expect(capturedOptions?.resume).toBe(false);
      expect(isRecapTurn(spawnedSessionId(sessionManager), aTurnStartedBeforeNow())).toBe(false);
    });

    it('marks nothing when the spawn itself fails: the mark waits for the session to exist', async () => {
      const sessionManager = makeSessionManager();
      sessionManager.spawn.mockRejectedValueOnce(new Error('pty host down'));
      const { engine } = makeEngine({ sessionManager, sessionRepo: resumableRepo(), projectPath });

      await expect(engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, undefined, undefined, 'claude',
      )).rejects.toThrow('pty host down');

      expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
      expect(isRecapTurn(sessionManager.spawn.mock.calls[0][0].id, aTurnStartedBeforeNow())).toBe(false);
    });
  });

  describe('the room the recap leaves for the caller\'s own text', () => {
    // About 2,000 characters, as a column's own prompt template is.
    const COLUMN_PROMPT = 'Review the changes on this branch and report each finding with its file. '.repeat(27).trim();
    // The same size, but with a `%` in every sentence: a cmd host receives each as four characters.
    const PERCENT_COLUMN_PROMPT = 'Cover 100% of the changed lines before you report. '.repeat(40).trim();
    const HANDOFF_PREFIX = 'The previous agent session wrote its history to a file that you can read. '.repeat(27).trim();

    it('fits an isolated column\'s whole prompt on the command line beside a recap that was offered all the room', async () => {
      expect(COLUMN_PROMPT.length).toBeGreaterThan(1_900);
      const { requestedRooms, sources } = greedyTailSource();
      const { engine } = makeEngine({
        sessionRepo: resumableRepo(ISOLATED_LANE_ID), projectPath, services: { recapSources: sources },
      });

      await engine.runLegacySpawnAgent(
        { promptTemplate: COLUMN_PROMPT } as unknown as LegacySpawnConfig,
        makeTask() as unknown as SpawnTask, null, undefined, 'claude', { isolatedSwimlaneId: ISOLATED_LANE_ID },
      );

      const prompt = capturedOptions?.prompt ?? '';
      // The recap carried the old conversation, so the budget below is not met vacuously.
      expect(prompt).toContain('<previous_conversation_tail>');
      // The recap, then the column's prompt whole.
      expect(prompt.endsWith(`\n\n${COLUMN_PROMPT}`)).toBe(true);
      expect(commandLineLength(prompt)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
      // The old conversation was asked for no more than the room the column's prompt left.
      expect(requestedRooms).toHaveLength(1);
      expect(requestedRooms[0]).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET - commandLineLength(COLUMN_PROMPT) - 2);
    });

    it('measures the column\'s prompt as a cmd host receives it, where each % takes four characters', async () => {
      expect(PERCENT_COLUMN_PROMPT.length).toBeGreaterThan(1_900);
      expect(commandLineLength(PERCENT_COLUMN_PROMPT)).toBeGreaterThan(PERCENT_COLUMN_PROMPT.length + 100);
      const { sources } = greedyTailSource();
      const { engine } = makeEngine({
        sessionRepo: resumableRepo(ISOLATED_LANE_ID), projectPath, services: { recapSources: sources },
      });

      await engine.runLegacySpawnAgent(
        { promptTemplate: PERCENT_COLUMN_PROMPT } as unknown as LegacySpawnConfig,
        makeTask() as unknown as SpawnTask, null, undefined, 'claude', { isolatedSwimlaneId: ISOLATED_LANE_ID },
      );

      const prompt = capturedOptions?.prompt ?? '';
      expect(prompt).toContain('<previous_conversation_tail>');
      expect(prompt.endsWith(`\n\n${PERCENT_COLUMN_PROMPT}`)).toBe(true);
      expect(commandLineLength(prompt)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    });

    it('fits a column prompt carried as the resume\'s message together with a handoff pointer', async () => {
      const { sources } = greedyTailSource();
      const { engine } = makeEngine({
        sessionRepo: resumableRepo(ISOLATED_LANE_ID), projectPath, services: { recapSources: sources },
      });

      // skipPromptTemplate: the column's prompt rides in the resume's message slot.
      await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, true, COLUMN_PROMPT, undefined, 'claude',
        HANDOFF_PREFIX, { isolatedSwimlaneId: ISOLATED_LANE_ID },
      );

      const prompt = capturedOptions?.prompt ?? '';
      expect(prompt).toContain('<previous_conversation_tail>');
      expect(prompt.startsWith(`${HANDOFF_PREFIX}\n\n`)).toBe(true);
      expect(prompt.endsWith(`\n\n${COLUMN_PROMPT}`)).toBe(true);
      expect(commandLineLength(prompt)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    });

    it('fits the main session\'s handoff pointer beside its whole-prompt recap', async () => {
      const { sources } = greedyTailSource();
      const { engine } = makeEngine({ sessionRepo: resumableRepo(), projectPath, services: { recapSources: sources } });

      await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, undefined, undefined, 'claude', HANDOFF_PREFIX,
      );

      const prompt = capturedOptions?.prompt ?? '';
      expect(prompt).toContain('<previous_conversation_tail>');
      expect(prompt).toContain('then wait for the next instruction from the user.');
      expect(prompt.startsWith(`${HANDOFF_PREFIX}\n\n`)).toBe(true);
      expect(commandLineLength(prompt)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
    });

    it('reserves nothing for the main session\'s dropped message: the recap is offered the room it left', async () => {
      const { requestedRooms, sources } = greedyTailSource();
      const { engine } = makeEngine({ sessionRepo: resumableRepo(), projectPath, services: { recapSources: sources } });

      // The message is dropped (the recap is the whole prompt), so it takes no room.
      // skipPromptTemplate: with no template of its own, the message is what a
      // fresh spawn would send, so it is the longest thing the recap could wrongly make room for.
      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, true, COLUMN_PROMPT, undefined, 'claude',
      );

      const prompt = capturedOptions?.prompt ?? '';
      expect(outcome.recapOnly).toBe(true);
      expect(prompt).not.toContain(COLUMN_PROMPT);
      // Fixed parts of the main session's recap take well under 1,500 of the budget.
      expect(requestedRooms).toHaveLength(1);
      expect(requestedRooms[0]).toBeGreaterThan(INLINE_PROMPT_BUDGET - 1_500);
      expect(commandLineLength(prompt)).toBeLessThanOrEqual(INLINE_PROMPT_BUDGET);
      expect(commandLineLength(prompt)).toBeGreaterThan(INLINE_PROMPT_BUDGET - 100);
    });

    it('runs an isolated column on its own prompt alone when that prompt leaves no room for the recap', async () => {
      // Plain single-spaced text with no `%` and no placeholders, so the
      // template interpolates to itself and its command-line length is its length.
      const sentence = 'Read the diff and note each risk with its file. ';
      const NO_ROOM_PROMPT = sentence.repeat(Math.ceil(6_900 / sentence.length)).slice(0, 6_900).trim();
      // The recap's header and pointer alone take about 365 characters; the
      // 2 is the blank line that would join it to the column's prompt.
      const roomLeft = INLINE_PROMPT_BUDGET - commandLineLength(NO_ROOM_PROMPT) - 2;
      expect(roomLeft).toBeLessThan(300);
      const notices: ConversationExpiredNotice[] = [];
      const { sources } = greedyTailSource();
      const { engine } = makeEngine({
        sessionRepo: resumableRepo(ISOLATED_LANE_ID),
        projectPath,
        services: { recapSources: sources, onConversationExpired: (notice) => notices.push(notice) },
      });

      const outcome = await engine.runLegacySpawnAgent(
        { promptTemplate: NO_ROOM_PROMPT } as unknown as LegacySpawnConfig,
        makeTask() as unknown as SpawnTask, null, undefined, 'claude', { isolatedSwimlaneId: ISOLATED_LANE_ID },
      );

      // Exactly the column's own prompt: no recap header and no blank lines
      // before it. A boolean compare, so a failure does not print 6,900 characters.
      const prompt = capturedOptions?.prompt ?? '';
      expect(prompt.slice(0, 40)).toBe(NO_ROOM_PROMPT.slice(0, 40));
      expect(prompt.length).toBe(NO_ROOM_PROMPT.length);
      expect(prompt === NO_ROOM_PROMPT).toBe(true);
      expect(capturedOptions?.resume).toBe(false);
      expect(outcome).toEqual({ startOver: 'expired', recapOnly: false, unsentPrompt: null });
      // The notice still tells the user their conversation was replaced.
      expect(notices).toHaveLength(1);
    });
  });

  describe('whether the message the resume carried reached the fresh session (unsentPrompt)', () => {
    // A fresh spawn takes the task template over the carried message
    // (resolveSpawnIntent), so a resume that started over with a template left
    // the message out and the caller must deliver it after the spawn. Every case
    // below changes exactly one of the four things that decide it: whether the
    // resume went ahead, whether the recap withheld the message on purpose,
    // whether there was a message, and whether there was a template.
    const CARRIED_MESSAGE = '/code-review main';

    it('is true for an isolated column whose own conversation expired: the prompt is the recap and the template, without the message', async () => {
      const notices: ConversationExpiredNotice[] = [];
      const { engine } = makeEngine({
        sessionRepo: resumableRepo(ISOLATED_LANE_ID),
        projectPath,
        services: { onConversationExpired: (notice) => notices.push(notice) },
      });

      // skipPromptTemplate false: the destination column has the default template.
      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, CARRIED_MESSAGE, undefined, 'claude',
        undefined, { isolatedSwimlaneId: ISOLATED_LANE_ID },
      );

      expect(outcome).toEqual({ startOver: 'expired', recapOnly: false, unsentPrompt: CARRIED_MESSAGE });
      const prompt = capturedOptions?.prompt ?? '';
      expect(capturedOptions?.resume).toBe(false);
      // The template's task block is the prompt after the recap, and the message is nowhere in it.
      expect(prompt).toContain('for context');
      expect(prompt).toContain('Fix login flow');
      expect(prompt).not.toContain('/code-review');
      expect(notices).toHaveLength(1);
    });

    it('is false for the same isolated column with no template: the message is the fresh prompt, last in it', async () => {
      const { engine } = makeEngine({ sessionRepo: resumableRepo(ISOLATED_LANE_ID), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, true, CARRIED_MESSAGE, undefined, 'claude',
        undefined, { isolatedSwimlaneId: ISOLATED_LANE_ID },
      );

      expect(outcome).toEqual({ startOver: 'expired', recapOnly: false, unsentPrompt: null });
      expect(capturedOptions?.prompt?.endsWith(`\n\n${CARRIED_MESSAGE}`)).toBe(true);
    });

    it.each([
      ['no message', undefined],
      ['a blank message', '   '],
    ])('is false for an isolated column with a template and %s: there is nothing to deliver', async (_label, carriedMessage) => {
      const { engine } = makeEngine({ sessionRepo: resumableRepo(ISOLATED_LANE_ID), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, carriedMessage, undefined, 'claude',
        undefined, { isolatedSwimlaneId: ISOLATED_LANE_ID },
      );

      expect(outcome).toMatchObject({ startOver: 'expired', recapOnly: false, unsentPrompt: null });
    });

    it('is false for the main session: its recap withholds the message on purpose, and says so', async () => {
      const { engine } = makeEngine({ sessionRepo: resumableRepo(), projectPath });

      // The default template is present and a message was carried, so only
      // `recapOnly` keeps this from being true.
      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, CARRIED_MESSAGE, undefined, 'claude',
      );

      expect(outcome).toEqual({ startOver: 'expired', recapOnly: true, unsentPrompt: null });
      expect(capturedOptions?.prompt).not.toContain('/code-review');
    });

    // An always_spawn_new column passes `forceFresh` (agent-spawn.ts): it spawns
    // fresh over a record that could be resumed, so the conversation is neither
    // missing nor expired and `startOver` stays null. The carried message is
    // still left out of a fresh spawn that has a template.
    it('is true for an always-new column: it spawns fresh over a resumable record, with the template as the prompt and no message in it', async () => {
      const { engine } = makeEngine({ sessionRepo: resumableRepo(), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, CARRIED_MESSAGE, undefined, 'claude',
        undefined, { forceFresh: true },
      );

      expect(outcome).toEqual({ startOver: null, recapOnly: false, unsentPrompt: CARRIED_MESSAGE });
      expect(capturedOptions?.resume).toBe(false);
      const prompt = capturedOptions?.prompt ?? '';
      expect(prompt).toContain('Fix login flow');
      expect(prompt).not.toContain('/code-review');
    });

    it('is false for the same always-new column with the template skipped: the message is the fresh prompt', async () => {
      const { engine } = makeEngine({ sessionRepo: resumableRepo(), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, true, CARRIED_MESSAGE, undefined, 'claude',
        undefined, { forceFresh: true },
      );

      expect(outcome).toEqual({ startOver: null, recapOnly: false, unsentPrompt: null });
      expect(capturedOptions?.resume).toBe(false);
      expect(capturedOptions?.prompt).toBe(CARRIED_MESSAGE);
    });
  });

  describe('the outcome a legacy Start agent row hands back (runLegacySpawnAgent)', () => {
    // The Send message rows after a legacy Start agent row are withheld on a
    // recap-only start (ipc/helpers/agent-spawn.ts), so the engine has to hand
    // the spawn's outcome back rather than drop it.
    it('reports a recap-only start when the task\'s main conversation expired', async () => {
      const { engine } = makeEngine({ sessionRepo: resumableRepo(), projectPath });

      const outcome = await engine.runLegacySpawnAgent(
        { promptTemplate: '{{task_xml}}' } as unknown as LegacySpawnConfig,
        makeTask() as unknown as SpawnTask, null, undefined, 'claude',
      );

      // A legacy row carries no resume message, so none is dropped.
      expect(outcome).toEqual({ startOver: 'expired', recapOnly: true, unsentPrompt: null });
      expect(capturedOptions?.resume).toBe(false);
    });

    it('reports an ordinary start when there is no conversation to resume', async () => {
      const { engine } = makeEngine({ projectPath });

      const outcome = await engine.runLegacySpawnAgent(
        { promptTemplate: '{{task_xml}}' } as unknown as LegacySpawnConfig,
        makeTask() as unknown as SpawnTask, null, undefined, 'claude',
      );

      expect(outcome).toEqual({ startOver: null, recapOnly: false, unsentPrompt: null });
    });
  });

  describe('the branch the recap compares against', () => {
    function gitStateSource() {
      return vi.fn(async (_cwd: string, _baseBranch: string) => ({
        branch: 'feature/login',
        commits: ['a1b2c3d Refresh the token'],
        changes: [],
      }));
    }

    it('reads the branch state in the task\'s checkout against the base branch the task sets', async () => {
      const readGitState = gitStateSource();
      const { engine } = makeEngine({
        sessionRepo: resumableRepo(), projectPath, services: { recapSources: { readGitState } },
      });

      // A base the project default ('main') and the literal fallback ('main')
      // cannot both produce by accident.
      await engine.resumeSuspendedSession(
        makeTask({ base_branch: 'release/2.0' }) as unknown as SpawnTask, null, false, undefined, undefined, 'claude',
      );

      expect(readGitState).toHaveBeenCalledTimes(1);
      expect(readGitState).toHaveBeenCalledWith(projectPath, 'release/2.0');
      // The same base is the one the recap names.
      expect(capturedOptions?.prompt).toContain('Branch: feature/login, based on release/2.0');
    });

    it('falls back to the project\'s default base branch when the task sets none', async () => {
      const readGitState = gitStateSource();
      const { engine } = makeEngine({
        sessionRepo: resumableRepo(), projectPath, defaultBaseBranch: 'develop', services: { recapSources: { readGitState } },
      });

      await engine.resumeSuspendedSession(
        makeTask() as unknown as SpawnTask, null, false, undefined, undefined, 'claude',
      );

      expect(readGitState).toHaveBeenCalledWith(projectPath, 'develop');
    });
  });
});
