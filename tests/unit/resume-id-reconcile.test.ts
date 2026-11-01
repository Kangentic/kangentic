/**
 * Tests for reconcileResumeAgentSessionId (the resume-time defensive
 * reconcile against the retiring record's own status.json).
 *
 * The fork fixtures under tests/fixtures/claude-clear-fork-status/ are REAL
 * statusline payloads captured from a live claude CLI (v2.1.220) driven
 * through prompt -> /clear -> prompt by scripts/validate-clear-fork.mjs, with
 * personal paths sanitized. pre-clear.json reports the launch id;
 * post-clear.json reports the forked id.
 *
 * Filesystem writes stay under os.tmpdir() (cross-platform-parity).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reconcileResumeAgentSessionId } from '../../src/main/transition-engine/resume-id-reconcile';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';
import type { SessionStartReport, SessionUsage } from '../../src/shared/types';
import { claudeSessionStartLine } from './helpers/claude-session-start';

const RECORD_ID = 'record-1111-2222-3333-444444444444';
const STORED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FORKED_ID = 'ffffffff-1111-2222-3333-444444444444';

type ParseSessionStart = (hookContext: string) => SessionStartReport | null;

interface AdapterStub {
  runtime: {
    statusFile: { parseStatus: (raw: string) => SessionUsage | null; parseSessionStart?: ParseSessionStart } | undefined;
  };
  locateSessionHistoryFile: ReturnType<typeof vi.fn>;
}

function makeAdapter(options: {
  parseStatus?: (raw: string) => SessionUsage | null;
  parseSessionStart?: ParseSessionStart;
  hasStatusFile?: boolean;
  locateResult?: string | null;
}): AdapterStub {
  const parseStatus = options.parseStatus
    ?? ((raw: string): SessionUsage | null => {
      try {
        const parsed = JSON.parse(raw) as { session_id?: string };
        return { sessionId: parsed.session_id } as SessionUsage;
      } catch {
        return null;
      }
    });
  return {
    runtime: {
      statusFile: options.hasStatusFile === false
        ? undefined
        : { parseStatus, ...(options.parseSessionStart ? { parseSessionStart: options.parseSessionStart } : {}) },
    },
    locateSessionHistoryFile: vi.fn(async () =>
      'locateResult' in options ? (options.locateResult ?? null) : '/located/transcript.jsonl'),
  };
}

const asAdapter = (stub: AdapterStub): AgentAdapter => stub as unknown as AgentAdapter;

describe('reconcileResumeAgentSessionId', () => {
  let projectPath: string;
  let updateAgentSessionId: ReturnType<typeof vi.fn>;
  let sessionRepo: { updateAgentSessionId: ReturnType<typeof vi.fn> };

  function writeStatusFile(content: string): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), content);
  }

  function writeEventsFile(lines: string[]): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), lines.map((line) => line + '\n').join(''));
  }

  function reconcile(adapter: AdapterStub, overrides?: Partial<Parameters<typeof reconcileResumeAgentSessionId>[0]>) {
    return reconcileResumeAgentSessionId({
      adapter: asAdapter(adapter),
      recordId: RECORD_ID,
      storedAgentSessionId: STORED_ID,
      cwd: path.join(projectPath, 'worktree'),
      projectPath,
      sessionRepo,
      ...overrides,
    });
  }

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-reconcile-'));
    updateAgentSessionId = vi.fn();
    sessionRepo = { updateAgentSessionId };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('swaps to the reported id when it differs and its transcript exists, persisting once', async () => {
    writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
    const adapter = makeAdapter({ locateResult: '/found.jsonl' });

    const resolved = await reconcile(adapter);

    expect(resolved).toBe(FORKED_ID);
    expect(adapter.locateSessionHistoryFile).toHaveBeenCalledWith(FORKED_ID, path.join(projectPath, 'worktree'), null, null);
    expect(updateAgentSessionId).toHaveBeenCalledTimes(1);
    expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, FORKED_ID);
  });

  it('keeps the stored id when status.json is missing (mocked CLI / pruned dir)', async () => {
    const adapter = makeAdapter({});

    const resolved = await reconcile(adapter);

    expect(resolved).toBe(STORED_ID);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
    expect(adapter.locateSessionHistoryFile).not.toHaveBeenCalled();
  });

  it('keeps the stored id on malformed JSON', async () => {
    writeStatusFile('{not json');
    const adapter = makeAdapter({});

    expect(await reconcile(adapter)).toBe(STORED_ID);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('keeps the stored id when the report matches it (no fork happened)', async () => {
    writeStatusFile(JSON.stringify({ session_id: STORED_ID }));
    const adapter = makeAdapter({});

    expect(await reconcile(adapter)).toBe(STORED_ID);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('keeps the stored id when the reported id transcript cannot be located (crash right after the fork)', async () => {
    writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
    const adapter = makeAdapter({ locateResult: null });

    expect(await reconcile(adapter)).toBe(STORED_ID);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('keeps the stored id when the reported value is not id-shaped', async () => {
    writeStatusFile(JSON.stringify({ session_id: 'bad value with spaces and a\npath' }));
    const adapter = makeAdapter({});

    expect(await reconcile(adapter)).toBe(STORED_ID);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('is a structural no-op for adapters without a status-file pipeline', async () => {
    writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
    const adapter = makeAdapter({ hasStatusFile: false });

    expect(await reconcile(adapter)).toBe(STORED_ID);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('degrades to the stored id for an adapter with no runtime shape at all', async () => {
    // A partially-shaped adapter stub (unit tests mock adapters without a
    // runtime) must hit the structural no-op, never throw.
    writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
    const adapter = { locateSessionHistoryFile: vi.fn() } as unknown as AdapterStub;

    expect(await reconcile(adapter)).toBe(STORED_ID);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('returns the stored id unchanged when inputs are missing', async () => {
    writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
    const adapter = makeAdapter({});

    expect(await reconcile(adapter, { recordId: null })).toBe(STORED_ID);
    expect(await reconcile(adapter, { projectPath: null })).toBe(STORED_ID);
    expect(await reconcile(adapter, { storedAgentSessionId: null })).toBe(null);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('still returns the corrected id when no sessionRepo is provided', async () => {
    writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
    const adapter = makeAdapter({});

    expect(await reconcile(adapter, { sessionRepo: null })).toBe(FORKED_ID);
  });

  it('a throwing locate degrades to the stored id (best-effort contract)', async () => {
    writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
    const adapter = makeAdapter({});
    adapter.locateSessionHistoryFile.mockRejectedValueOnce(new Error('EACCES'));

    expect(await reconcile(adapter)).toBe(STORED_ID);
    expect(updateAgentSessionId).not.toHaveBeenCalled();
  });

  describe('against the real Claude parser and the pinned live-CLI fork fixtures', () => {
    const fixturesDir = path.join(__dirname, '..', 'fixtures', 'claude-clear-fork-status');
    const preClear = fs.readFileSync(path.join(fixturesDir, 'pre-clear.json'), 'utf8');
    const postClear = fs.readFileSync(path.join(fixturesDir, 'post-clear.json'), 'utf8');
    const preClearId = (JSON.parse(preClear) as { session_id: string }).session_id;
    const postClearId = (JSON.parse(postClear) as { session_id: string }).session_id;

    it('the fixtures really carry two different ids (fork captured live)', () => {
      expect(preClearId).not.toBe(postClearId);
    });

    it('ClaudeStatusParser surfaces the forked session id from the post-clear payload', () => {
      // The post-clear payload has current_usage: null and used_percentage:
      // null (a status write from the instant after the fork, before any
      // turn) - the parser must still yield the session id.
      const usage = ClaudeStatusParser.parseStatus(postClear);
      expect(usage?.sessionId).toBe(postClearId);
    });

    it('reconciles a record stored on the pre-clear id to the post-clear id', async () => {
      writeStatusFile(postClear);
      const adapter = makeAdapter({
        parseStatus: ClaudeStatusParser.parseStatus,
        locateResult: '/found.jsonl',
      });

      const resolved = await reconcile(adapter, { storedAgentSessionId: preClearId });

      expect(resolved).toBe(postClearId);
      expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, postClearId);
    });
  });

  // Every process started with the record's --settings writes its status file,
  // so the last write can come from a sibling: Claude Code's background daemon
  // ran an empty spare (SessionStart `startup`) beside the conversation it
  // moved (SessionStart `fork`). An adapter that reads its SessionStart hooks
  // follows only an id a hook that moves the conversation named.
  describe('with an adapter that reads its SessionStart hooks', () => {
    const SPARE_ID = '9dfc0083-eb3a-4c38-bb6c-c4d991525d2b';

    it('keeps the stored id when the status file last named a spare that no hook moved to', async () => {
      writeStatusFile(JSON.stringify({ session_id: SPARE_ID }));
      writeEventsFile([
        JSON.stringify({ ts: 1, type: 'tool_start', tool: 'Read' }),
        claudeSessionStartLine(SPARE_ID, 'startup', 2),
        claudeSessionStartLine(FORKED_ID, 'fork', 3),
      ]);
      const adapter = makeAdapter({ parseSessionStart: ClaudeStatusParser.parseSessionStart, locateResult: '/spare.jsonl' });

      expect(await reconcile(adapter)).toBe(STORED_ID);
      expect(adapter.locateSessionHistoryFile).not.toHaveBeenCalled();
      expect(updateAgentSessionId).not.toHaveBeenCalled();
    });

    it('keeps the stored id when the events file is missing', async () => {
      writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
      const adapter = makeAdapter({ parseSessionStart: ClaudeStatusParser.parseSessionStart, locateResult: '/found.jsonl' });

      expect(await reconcile(adapter)).toBe(STORED_ID);
      expect(updateAgentSessionId).not.toHaveBeenCalled();
    });

    it('swaps to the id a fork moved the conversation to', async () => {
      writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
      writeEventsFile([
        claudeSessionStartLine(STORED_ID, 'resume', 1),
        claudeSessionStartLine(SPARE_ID, 'startup', 2),
        claudeSessionStartLine(FORKED_ID, 'fork', 3),
        // A torn final line, as an append in progress leaves it.
        '{"ts":4,"type":"session_st',
      ]);
      const adapter = makeAdapter({ parseSessionStart: ClaudeStatusParser.parseSessionStart, locateResult: '/found.jsonl' });

      expect(await reconcile(adapter)).toBe(FORKED_ID);
      expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, FORKED_ID);
    });

    // `/fork` fires the same hook as `/bg` but leaves the conversation in the
    // terminal; the copy writes the same status file and can write it last.
    it('keeps the stored id when the adapter finds the fork was a copy, not a move', async () => {
      writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const confirmsBackgroundMove = vi.fn(async () => false);
      const adapter = makeAdapter({ parseSessionStart: ClaudeStatusParser.parseSessionStart, locateResult: '/copy.jsonl' });
      Object.assign(adapter.runtime.statusFile!, { confirmsBackgroundMove });

      expect(await reconcile(adapter)).toBe(STORED_ID);
      expect(confirmsBackgroundMove).toHaveBeenCalledWith({
        cwd: path.join(projectPath, 'worktree'),
        fromAgentSessionId: STORED_ID,
        toAgentSessionId: FORKED_ID,
        cliTarget: null,
      });
      expect(updateAgentSessionId).not.toHaveBeenCalled();
    });

    it('swaps when the adapter confirms the fork was the move', async () => {
      writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const adapter = makeAdapter({ parseSessionStart: ClaudeStatusParser.parseSessionStart, locateResult: '/found.jsonl' });
      Object.assign(adapter.runtime.statusFile!, { confirmsBackgroundMove: vi.fn(async () => true) });

      expect(await reconcile(adapter)).toBe(FORKED_ID);
    });
  });

  // `/bg` moves the conversation into Claude Code's own background session,
  // which outlives the task's PTY: a pause ends only the terminal's client.
  // Measured on 2.1.316: the session was still alive after the pause, and a
  // fork that took no turn answered `--resume` with "No conversation found"
  // while the conversation it continued resumed.
  describe('a conversation the record saw move into a background session', () => {
    const CLI_PATH = 'C:\\Users\\dev\\.local\\bin\\claude.exe';
    const CONTINUED_FROM = '6e21471d-887a-42d3-97d3-fcfedac9dd51';
    const SECOND_MOVE_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
    // The three ids in tests/fixtures/claude-background-move/session-starts.jsonl.
    const LIVE_RESUMED_ID = '206fcc54-ddb8-497b-9d57-a0f6defcced9';
    const LIVE_SPARE_ID = '9dfc0083-eb3a-4c38-bb6c-c4d991525d2b';
    const LIVE_MOVED_ID = '58bd8a86-0d47-4861-8449-63202d8e6a43';
    const CAPTURED_HOOKS = path.join(__dirname, '..', 'fixtures', 'claude-background-move', 'session-starts.jsonl');

    function backgroundAdapter(options: { resumable?: string; resolveThrows?: boolean; stopResult?: boolean; stopThrows?: boolean } = {}) {
      const stopBackgroundSession = vi.fn(async () => {
        if (options.stopThrows) throw new Error('supervisor gone');
        return options.stopResult ?? true;
      });
      const resolveResumableSessionId = vi.fn(async ({ agentSessionId }: { agentSessionId: string }) => {
        if (options.resolveThrows) throw new Error('EACCES');
        return options.resumable ?? agentSessionId;
      });
      const stub = makeAdapter({ parseSessionStart: ClaudeStatusParser.parseSessionStart });
      return { stub: Object.assign(stub, { stopBackgroundSession, resolveResumableSessionId }), stopBackgroundSession, resolveResumableSessionId };
    }

    it('stops the background session and resumes the conversation the fork continued, before any spawn', async () => {
      writeEventsFile([
        claudeSessionStartLine(CONTINUED_FROM, 'startup', 1),
        JSON.stringify({ ts: 2, type: 'session_end' }),
        claudeSessionStartLine(STORED_ID, 'fork', 3),
      ]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter({ resumable: CONTINUED_FROM });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(CONTINUED_FROM);
      expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: STORED_ID, cliPath: CLI_PATH });
      expect(resolveResumableSessionId).toHaveBeenCalledWith({ agentSessionId: STORED_ID, cwd: path.join(projectPath, 'worktree'), place: null });
      expect(stopBackgroundSession.mock.invocationCallOrder[0]).toBeLessThan(resolveResumableSessionId.mock.invocationCallOrder[0]);
    });

    it('runs neither step for a conversation that never moved into a background session', async () => {
      writeEventsFile([
        claudeSessionStartLine(STORED_ID, 'resume', 1),
        claudeSessionStartLine(STORED_ID, 'compact', 2),
      ]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter({ resumable: CONTINUED_FROM });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(stopBackgroundSession).not.toHaveBeenCalled();
      expect(resolveResumableSessionId).not.toHaveBeenCalled();
    });

    // A pause or a Done move between the background session's hook and its
    // first status write leaves the record on the conversation the move left,
    // which the live switch never got to replace.
    it('follows a stored id the move left to the background session the CLI\'s own record proves', async () => {
      writeEventsFile([
        claudeSessionStartLine(STORED_ID, 'resume', 1),
        JSON.stringify({ ts: 2, type: 'tool_start', tool: 'Read' }),
        claudeSessionStartLine(FORKED_ID, 'fork', 3),
      ]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter({ resumable: STORED_ID });
      const confirmsBackgroundMove = vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === FORKED_ID);
      Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(confirmsBackgroundMove).toHaveBeenCalledWith({
        cwd: path.join(projectPath, 'worktree'),
        fromAgentSessionId: STORED_ID,
        toAgentSessionId: FORKED_ID,
        cliTarget: null,
      });
      expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, FORKED_ID);
      expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cliPath: CLI_PATH });
      expect(resolveResumableSessionId).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cwd: path.join(projectPath, 'worktree'), place: null });
    });

    it('stops nothing for a /fork copy started beside the stored conversation', async () => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter({ resumable: CONTINUED_FROM });
      Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove: vi.fn(async () => false) });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(stopBackgroundSession).not.toHaveBeenCalled();
      expect(resolveResumableSessionId).not.toHaveBeenCalled();
      expect(updateAgentSessionId).not.toHaveBeenCalled();
    });

    it('a fork of another conversation is no evidence for this one', async () => {
      writeEventsFile([claudeSessionStartLine(FORKED_ID, 'fork', 1)]);
      const { stub, stopBackgroundSession } = backgroundAdapter();

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(stopBackgroundSession).not.toHaveBeenCalled();
    });

    it('still resolves the resumable id with no CLI path, and keeps the id when that check throws', async () => {
      writeEventsFile([claudeSessionStartLine(CONTINUED_FROM, 'startup', 1), claudeSessionStartLine(STORED_ID, 'fork', 2)]);
      const withoutCli = backgroundAdapter({ resumable: CONTINUED_FROM });
      expect(await reconcile(withoutCli.stub)).toBe(CONTINUED_FROM);
      expect(withoutCli.stopBackgroundSession).not.toHaveBeenCalled();

      const throwing = backgroundAdapter({ resolveThrows: true });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await reconcile(throwing.stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(throwing.stopBackgroundSession).toHaveBeenCalledTimes(1);
    });

    // The gate in front of the CLI steps: no proof in the record's own events
    // file means no CLI runs, even with a CLI path and every step available.
    it('runs no CLI step and no move check when the record has no events file', async () => {
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter({ resumable: CONTINUED_FROM });
      const confirmsBackgroundMove = vi.fn(async () => true);
      Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(stopBackgroundSession).not.toHaveBeenCalled();
      expect(resolveResumableSessionId).not.toHaveBeenCalled();
      expect(confirmsBackgroundMove).not.toHaveBeenCalled();
      expect(updateAgentSessionId).not.toHaveBeenCalled();
    });

    // The expected id differs from the stored one on purpose: with the check
    // missing, a guard that is dropped throws, the catch hands back the stored
    // id, and a hook naming the stored id itself would pass that by accident.
    it('stops the session and returns the background id when the adapter cannot resolve a resumable id', async () => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const stopBackgroundSession = vi.fn(async () => true);
      const stub = Object.assign(makeAdapter({ parseSessionStart: ClaudeStatusParser.parseSessionStart }), { stopBackgroundSession });
      Object.assign(stub.runtime.statusFile!, {
        confirmsBackgroundMove: vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === FORKED_ID),
      });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(FORKED_ID);
      expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
      expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cliPath: CLI_PATH });
      expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, FORKED_ID);
    });

    it('asks no move check and stops nothing without a cwd, whatever the hooks name', async () => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter({ resumable: CONTINUED_FROM });
      const confirmsBackgroundMove = vi.fn(async () => true);
      Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove });

      expect(await reconcile(stub, { cwd: null, cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(confirmsBackgroundMove).not.toHaveBeenCalled();
      expect(stopBackgroundSession).not.toHaveBeenCalled();
      expect(resolveResumableSessionId).not.toHaveBeenCalled();
      expect(updateAgentSessionId).not.toHaveBeenCalled();
    });

    // A conversation moved twice continues in the later background session, so
    // the newer hook is asked about first and, once confirmed, is the only one
    // stopped.
    it('stops the newest of two confirmed background sessions, asking about it first', async () => {
      writeEventsFile([
        claudeSessionStartLine(STORED_ID, 'resume', 1),
        claudeSessionStartLine(FORKED_ID, 'fork', 2),
        claudeSessionStartLine(SECOND_MOVE_ID, 'fork', 3),
      ]);
      const { stub, stopBackgroundSession } = backgroundAdapter();
      const confirmsBackgroundMove = vi.fn(async () => true);
      Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(SECOND_MOVE_ID);
      expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
      expect(confirmsBackgroundMove).toHaveBeenNthCalledWith(1, {
        cwd: path.join(projectPath, 'worktree'),
        fromAgentSessionId: STORED_ID,
        toAgentSessionId: SECOND_MOVE_ID,
        cliTarget: null,
      });
      expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
      expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: SECOND_MOVE_ID, cliPath: CLI_PATH });
      expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, SECOND_MOVE_ID);
    });

    // A long session's events file runs well past any head read, and the hook
    // that proves the move can be the last thing in it.
    it('finds a background hook placed after more than 64 KB of tool events', async () => {
      const toolEventLines = Array.from({ length: 2000 }, (_, index) =>
        JSON.stringify({ ts: index + 1, type: 'tool_start', tool: 'Read' }));
      // The premise: the hook starts past byte 65536, not merely in a big file.
      expect(Buffer.byteLength(toolEventLines.map((line) => line + '\n').join(''))).toBeGreaterThan(64 * 1024);
      writeEventsFile([...toolEventLines, claudeSessionStartLine(STORED_ID, 'fork', 3000)]);
      const { stub, stopBackgroundSession } = backgroundAdapter();

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
      expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: STORED_ID, cliPath: CLI_PATH });
    });

    // A record whose CLI ran in a WSL distro keeps its transcript in the
    // distro's home, so both move checks are handed where the record ran, in the
    // stored form a session row keeps. Passed as null, they would read the
    // transcript on this machine, find none, and read a real move as a copy.
    describe('for a record whose CLI ran in a WSL distro', () => {
      const WSL_PLACE: CliPlace = {
        kind: 'wsl',
        distro: 'Ubuntu',
        facts: {
          distro: 'Ubuntu',
          homeLinux: '/home/dev',
          homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
          uncRoot: '\\\\wsl.localhost\\Ubuntu',
          interactivePath: '',
          env: {},
          networkingMode: 'unknown',
        },
      };
      const STORED_TARGET = {
        kind: 'wsl',
        distro: 'Ubuntu',
        homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
        uncRoot: '\\\\wsl.localhost\\Ubuntu',
      };

      it('gives the move check of a stored id the move left the record\'s place', async () => {
        // No status.json: only the settle step asks about the move here.
        writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
        const { stub, stopBackgroundSession } = backgroundAdapter();
        const confirmsBackgroundMove = vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === FORKED_ID);
        Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove });

        expect(await reconcile(stub, { cliPath: CLI_PATH, place: WSL_PLACE })).toBe(FORKED_ID);
        expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
        expect(confirmsBackgroundMove).toHaveBeenCalledWith({
          cwd: path.join(projectPath, 'worktree'),
          fromAgentSessionId: STORED_ID,
          toAgentSessionId: FORKED_ID,
          cliTarget: expect.objectContaining(STORED_TARGET),
        });
        expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cliPath: CLI_PATH });
      });

      it('gives the move check of a status swap the record\'s place', async () => {
        // The status file names the fork, so the swap asks. The settle step then
        // finds the fork among the record's own background hooks and asks nothing.
        writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
        writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
        const { stub, stopBackgroundSession } = backgroundAdapter();
        const confirmsBackgroundMove = vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === FORKED_ID);
        Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove });

        expect(await reconcile(stub, { cliPath: CLI_PATH, place: WSL_PLACE })).toBe(FORKED_ID);
        expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
        expect(confirmsBackgroundMove).toHaveBeenCalledWith({
          cwd: path.join(projectPath, 'worktree'),
          fromAgentSessionId: STORED_ID,
          toAgentSessionId: FORKED_ID,
          cliTarget: expect.objectContaining(STORED_TARGET),
        });
        expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cliPath: CLI_PATH });
      });
    });

    // The record is pointed at the background session only once the stop and the
    // resumable-id check are both done, so a step that throws leaves the record
    // on the conversation it stored and the resume on that same id.
    it('leaves the record on the stored id when a step after the stop throws', async () => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter({ resolveThrows: true });
      Object.assign(stub.runtime.statusFile!, {
        confirmsBackgroundMove: vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === FORKED_ID),
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      // The path reached both steps, so an unwritten record is not an early exit.
      expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
      expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cliPath: CLI_PATH });
      expect(resolveResumableSessionId).toHaveBeenCalledTimes(1);
      expect(updateAgentSessionId).not.toHaveBeenCalled();
    });

    // `claude stop` reports false when no live background session held the
    // conversation (the listing showed none alive, or the stop never ran). The
    // conversation is as stopped as it will get, so the resume goes on exactly as
    // after a stop that ran: the resumable id, and the record pointed at the
    // background session. Red-green: returning the stored id on a false stop
    // leaves the record on the conversation the move left.
    it('still resumes the resolved id and follows the move when no background session was stopped', async () => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter({ resumable: CONTINUED_FROM, stopResult: false });
      Object.assign(stub.runtime.statusFile!, {
        confirmsBackgroundMove: vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === FORKED_ID),
      });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(CONTINUED_FROM);
      expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
      expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cliPath: CLI_PATH });
      expect(resolveResumableSessionId).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cwd: path.join(projectPath, 'worktree'), place: null });
      // The record follows the move to the background session, not to the id the resume resolved.
      expect(updateAgentSessionId).toHaveBeenCalledTimes(1);
      expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, FORKED_ID);
    });

    // A stop that throws is a step that failed: the record and the returned id
    // stay on the conversation the record stored, as when the lookup after it
    // throws. Red-green: swallowing the stop's rejection as a false stop goes on
    // to resume the resolved id, which this return value rejects.
    it('leaves the record and the returned id on the stored conversation when the stop itself throws', async () => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const { stub, stopBackgroundSession } = backgroundAdapter({ resumable: CONTINUED_FROM, stopThrows: true });
      Object.assign(stub.runtime.statusFile!, {
        confirmsBackgroundMove: vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === FORKED_ID),
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      // The path reached the stop, so an unwritten record is not an early exit.
      expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
      expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: FORKED_ID, cliPath: CLI_PATH });
      expect(updateAgentSessionId).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Resume target check failed'), expect.any(Error));
    });

    // A hook payload the event bridge cut short, or a hand-edited file, can carry
    // anything in its id field. The move check says yes to every id here, so only
    // the id's own shape keeps an odd one from being stopped and persisted.
    it.each([
      ['has spaces', 'a b c'],
      ['is too short', 'abc123'],
      ['is a path', '../escape-0000-1111-2222'],
    ])('never follows a fork hook whose session id %s', async (_shape, oddSessionId) => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(oddSessionId, 'fork', 2)]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter();
      const confirmsBackgroundMove = vi.fn(async () => true);
      Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(STORED_ID);
      expect(confirmsBackgroundMove).not.toHaveBeenCalled();
      expect(stopBackgroundSession).not.toHaveBeenCalled();
      expect(resolveResumableSessionId).not.toHaveBeenCalled();
      expect(updateAgentSessionId).not.toHaveBeenCalled();
    });

    // The expected id differs from both the stored id and the odd one, so
    // neither a dropped check nor a fall back to the stored id can pass by
    // accident.
    it('keeps the background id when the adapter resolves a resumable id that is not id-shaped', async () => {
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const { stub, resolveResumableSessionId } = backgroundAdapter({ resumable: '../x y' });
      Object.assign(stub.runtime.statusFile!, {
        confirmsBackgroundMove: vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === FORKED_ID),
      });

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(FORKED_ID);
      expect(resolveResumableSessionId).toHaveBeenCalledTimes(1);
      expect(updateAgentSessionId).toHaveBeenCalledTimes(1);
      expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, FORKED_ID);
    });

    // The status swap and the background check both read the record's hooks. A
    // long session's events file is not read twice for one resume.
    it('reads the events file once when the status swap and the background session both need its hooks', async () => {
      writeStatusFile(JSON.stringify({ session_id: FORKED_ID }));
      writeEventsFile([claudeSessionStartLine(STORED_ID, 'resume', 1), claudeSessionStartLine(FORKED_ID, 'fork', 2)]);
      const { stub, stopBackgroundSession, resolveResumableSessionId } = backgroundAdapter();
      const eventsPath = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID, 'events.jsonl');
      const createReadStream = vi.spyOn(fs, 'createReadStream');

      expect(await reconcile(stub, { cliPath: CLI_PATH })).toBe(FORKED_ID);
      // Both checks ran, so one read is sharing, not a check that never asked.
      expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
      expect(resolveResumableSessionId).toHaveBeenCalledTimes(1);
      expect(createReadStream.mock.calls.filter(([filePath]) => filePath === eventsPath)).toHaveLength(1);
    });

    // tests/fixtures/claude-background-move/session-starts.jsonl is a sanitized
    // live capture: the three SessionStart lines Claude Code 2.1.316 wrote into a
    // task's events.jsonl when its conversation moved into the background
    // daemon. The spawn's own `resume` (206fcc54), the daemon's empty spare
    // (`startup`, 9dfc0083) and the moved conversation (`fork`, 58bd8a86). The
    // file is copied in untouched, so the real parser reads the real bytes.
    describe('against the hooks a live Claude Code 2.1.316 recorded for a /bg move', () => {
      function copyCapturedHooks(): void {
        const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.copyFileSync(CAPTURED_HOOKS, path.join(sessionDir, 'events.jsonl'));
      }

      it('stops the moved conversation when the record is stored on it', async () => {
        copyCapturedHooks();
        const { stub, stopBackgroundSession } = backgroundAdapter();

        expect(await reconcile(stub, { storedAgentSessionId: LIVE_MOVED_ID, cliPath: CLI_PATH })).toBe(LIVE_MOVED_ID);
        expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
        expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: LIVE_MOVED_ID, cliPath: CLI_PATH });
        expect(stopBackgroundSession).not.toHaveBeenCalledWith({ agentSessionId: LIVE_SPARE_ID, cliPath: CLI_PATH });
      });

      it('follows a record stored on the conversation the move left to the moved one, never the spare', async () => {
        copyCapturedHooks();
        const { stub, stopBackgroundSession } = backgroundAdapter();
        const confirmsBackgroundMove = vi.fn(async ({ toAgentSessionId }: { toAgentSessionId: string }) => toAgentSessionId === LIVE_MOVED_ID);
        Object.assign(stub.runtime.statusFile!, { confirmsBackgroundMove });

        expect(await reconcile(stub, { storedAgentSessionId: LIVE_RESUMED_ID, cliPath: CLI_PATH })).toBe(LIVE_MOVED_ID);
        expect(confirmsBackgroundMove).toHaveBeenCalledTimes(1);
        expect(confirmsBackgroundMove).toHaveBeenCalledWith({
          cwd: path.join(projectPath, 'worktree'),
          fromAgentSessionId: LIVE_RESUMED_ID,
          toAgentSessionId: LIVE_MOVED_ID,
          cliTarget: null,
        });
        expect(updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, LIVE_MOVED_ID);
        expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
        expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: LIVE_MOVED_ID, cliPath: CLI_PATH });
        expect(stopBackgroundSession).not.toHaveBeenCalledWith({ agentSessionId: LIVE_SPARE_ID, cliPath: CLI_PATH });
      });
    });
  });
});
