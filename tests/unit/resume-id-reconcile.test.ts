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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reconcileResumeAgentSessionId } from '../../src/main/transition-engine/resume-id-reconcile';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { SessionUsage } from '../../src/shared/types';

const RECORD_ID = 'record-1111-2222-3333-444444444444';
const STORED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FORKED_ID = 'ffffffff-1111-2222-3333-444444444444';

interface AdapterStub {
  runtime: { statusFile: { parseStatus: (raw: string) => SessionUsage | null } | undefined };
  locateSessionHistoryFile: ReturnType<typeof vi.fn>;
}

function makeAdapter(options: {
  parseStatus?: (raw: string) => SessionUsage | null;
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
      statusFile: options.hasStatusFile === false ? undefined : { parseStatus },
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
});
