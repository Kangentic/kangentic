/**
 * Guard against resuming a conversation the agent never persisted.
 *
 * Reproduced on a real board in seconds: drag a task out of Done (the recovery
 * move spawns command-free, so the agent boots idle with nothing to do), drag it
 * back before typing, then drag it out again. Kangentic pre-specifies
 * `--session-id` and persists it AT SPAWN TIME, so the never-used id looks
 * resumable forever. Every later entry into an auto-spawn column issued
 * `--resume <id>`, the CLI answered "No conversation found with session ID", and
 * the user landed on a bare shell with the record still reading `running`.
 *
 * The status fixtures below are trimmed from the real captured file of that
 * session (Claude Code 2.1.233): `current_usage: null`, zero totals, and a
 * `transcript_path` naming a file the CLI never wrote.
 *
 * The predicate has to stay narrower than the `canResumeSession` guard that was
 * built and deliberately reverted in #255, whose false misses silently
 * destroyed real conversations. These tests pin the three properties that keep
 * it narrow: the path comes from the agent's own report, a conversation with
 * turns is NEVER downgraded, and absence of evidence always degrades to today's
 * resume behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isResumeConversationAbsent } from '../../src/main/transition-engine/resume-conversation-guard';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

const RECORD_ID = '6fc5d715-77ca-47d6-9c50-8f27ad05e4a7';
const AGENT_SESSION_ID = '935a5611-0f79-4f34-a5ea-62f2a4bd7894';

let projectPath: string;
let transcriptPath: string;

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-resume-guard-'));
  transcriptPath = path.join(projectPath, 'history', `${AGENT_SESSION_ID}.jsonl`);
});

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true });
});

/** An adapter shaped like Claude's: a status pipeline that parses real status JSON. */
function adapterWithStatusPipeline(): AgentAdapter {
  return {
    runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } },
  } as unknown as AgentAdapter;
}

/** Codex, Aider, and friends: no status file, so nothing to probe. */
function adapterWithoutStatusPipeline(): AgentAdapter {
  return { runtime: {} } as unknown as AgentAdapter;
}

function writeStatusFile(options: {
  includeTranscriptPath?: boolean;
  usedPercentage?: number | null;
  currentUsage?: Record<string, number> | null;
  totalCostUsd?: number;
  raw?: string;
}): void {
  const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  const contents = options.raw ?? JSON.stringify({
    session_id: AGENT_SESSION_ID,
    ...(options.includeTranscriptPath === false ? {} : { transcript_path: transcriptPath }),
    model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
    cost: { total_cost_usd: options.totalCostUsd ?? 0, total_duration_ms: 1388, total_api_duration_ms: 0 },
    context_window: {
      total_input_tokens: options.currentUsage ? 4200 : 0,
      total_output_tokens: 0,
      context_window_size: 200000,
      current_usage: options.currentUsage ?? null,
      used_percentage: options.usedPercentage ?? null,
    },
  });
  fs.writeFileSync(path.join(sessionDir, 'status.json'), contents, 'utf8');
}

describe('isResumeConversationAbsent - downgrades only a provably empty conversation', () => {
  it('reports absent when the agent recorded no turns and never wrote the transcript it named', async () => {
    // The exact reported state: booted, zero turns, transcript path named but no file.
    writeStatusFile({});
    expect(fs.existsSync(transcriptPath)).toBe(false);

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(true);
  });

  it('resumes when the named transcript exists, even with no turns recorded yet', async () => {
    writeStatusFile({});
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '{"type":"user"}\n', 'utf8');

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });
});

describe('isResumeConversationAbsent - falls back to the SessionStart hook', () => {
  // The status line only runs once the TUI is up, so a CLI killed in its first
  // second leaves none and used to blind the whole lineage. The SessionStart
  // hook fires far earlier and carries the same `transcript_path`. Lines below
  // are the real captured shape: the payload is a JSON STRING under hookContext.
  function writeEventsFile(lines: string[]): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  }

  const sessionStartLine = () => JSON.stringify({
    ts: 1786997736868,
    type: 'session_start',
    hookContext: JSON.stringify({
      session_id: AGENT_SESSION_ID,
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }),
  });

  it('reports absent from a start/end-only events file with no transcript on disk', () => {
    writeEventsFile([sessionStartLine(), JSON.stringify({ ts: 1786997738763, type: 'session_end' })]);

    return expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(true);
  });

  it('resumes when the events file shows any real turn', async () => {
    // Anything beyond the two lifecycle markers counts as a turn, so a prompt,
    // a tool call, or an idle all keep today's behavior.
    for (const turnEvent of ['user_prompt', 'tool_start', 'idle']) {
      writeEventsFile([sessionStartLine(), JSON.stringify({ ts: 1786997737000, type: turnEvent })]);
      await expect(isResumeConversationAbsent({
        adapter: adapterWithStatusPipeline(),
        recordIds: [RECORD_ID],
        projectPath,
      })).resolves.toBe(false);
    }
  });

  it('resumes when the events file carries no SessionStart payload (the mocked-CLI shape)', async () => {
    // mock-claude writes activity events with no session_start hook payload.
    writeEventsFile([JSON.stringify({ ts: 1786997737000, type: 'session_start' })]);
    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });

  it('prefers the status line when both reports exist', async () => {
    // Status says the conversation had turns; the events file alone would have
    // said otherwise. The richer report wins and the conversation is kept.
    writeEventsFile([sessionStartLine(), JSON.stringify({ ts: 1786997738763, type: 'session_end' })]);
    writeStatusFile({ currentUsage: { input_tokens: 4200, output_tokens: 130, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });

  it('tolerates a torn final line', async () => {
    writeEventsFile([sessionStartLine(), '{"ts":1786997738763,"type":"sess']);
    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(true);
  });
});

describe('isResumeConversationAbsent - heals an already-poisoned lineage', () => {
  // A failed resume is self-perpetuating: the CLI dies before its status line
  // runs, so THAT record has no status file, and the next spawn retires it and
  // finds no evidence either. The observed board had three records sharing one
  // agent_session_id, and only the first (the original empty session) carried a
  // status report. Probing the retiring record alone leaves such a task stuck
  // forever, which is why the guard walks the whole conversation.
  const DEAD_RESUME_RECORD_ID = '2fec0dab-99d2-407a-8782-2a748dfc935e';

  it('finds the proof on an older record when the retiring one wrote no status file', async () => {
    writeStatusFile({});
    // The newest record's session dir exists but holds no status.json, exactly
    // as the failed resumes left it.
    fs.mkdirSync(path.join(projectPath, '.kangentic', 'sessions', DEAD_RESUME_RECORD_ID), { recursive: true });

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [DEAD_RESUME_RECORD_ID, RECORD_ID],
      projectPath,
    })).resolves.toBe(true);
  });

  it('still resumes when no record in the lineage has a status file', async () => {
    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [DEAD_RESUME_RECORD_ID, RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });
});

describe('isResumeConversationAbsent - never discards a conversation that had turns', () => {
  // This is the #255 failure mode. A session with turns keeps today's resume
  // behavior no matter what the file check would say, because its transcript
  // may simply have moved (a worktree rename migrates the per-cwd history, so
  // an older status report can name a stale path).
  it('resumes when token usage was recorded, even though the named transcript is missing', async () => {
    writeStatusFile({ currentUsage: { input_tokens: 4200, output_tokens: 130, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    expect(fs.existsSync(transcriptPath)).toBe(false);

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });

  it('resumes when cost was recorded but current_usage has already been cleared', async () => {
    writeStatusFile({ totalCostUsd: 0.42 });

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });

  it('resumes when only used_percentage survives (no current_usage block)', async () => {
    // parseStatus estimates usedTokens from used_percentage when current_usage
    // is absent, which is the shape of a very early status update mid-turn.
    writeStatusFile({ usedPercentage: 12 });

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });
});

describe('isResumeConversationAbsent - absence of evidence is never evidence', () => {
  it('resumes when no status file was ever written (the mocked-CLI path)', async () => {
    // mock-claude writes no status.json. This is exactly the case that broke
    // ten session-resume E2E specs when #255 gated on a computed path instead.
    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });

  it('resumes when the adapter has no status pipeline at all', async () => {
    writeStatusFile({});

    await expect(isResumeConversationAbsent({
      adapter: adapterWithoutStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });

  it('resumes when the status file is malformed', async () => {
    writeStatusFile({ raw: 'not json {' });

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });

  it('resumes when the status report carries no transcript path', async () => {
    writeStatusFile({ includeTranscriptPath: false });

    await expect(isResumeConversationAbsent({
      adapter: adapterWithStatusPipeline(),
      recordIds: [RECORD_ID],
      projectPath,
    })).resolves.toBe(false);
  });

  it('resumes when the record id or project path is unknown', async () => {
    const adapter = adapterWithStatusPipeline();
    await expect(isResumeConversationAbsent({ adapter, recordIds: [null], projectPath })).resolves.toBe(false);
    await expect(isResumeConversationAbsent({ adapter, recordIds: [RECORD_ID], projectPath: null })).resolves.toBe(false);
  });
});

describe('both spawn chokepoints apply the downgrade', () => {
  // The board path (transition-engine) is where the reported bug fired; startup
  // recovery reaches the same dead --resume after a crash. A guard on only one
  // of them is the drift this check exists to stop.
  const repoRoot = path.resolve(__dirname, '../..');

  it.each([
    ['src/main/transition-engine/transition-engine.ts'],
    ['src/main/transition-engine/session-startup/prepare-spawn.ts'],
  ])('%s calls isResumeConversationAbsent', (relativePath) => {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    expect(source).toContain('isResumeConversationAbsent(');
  });

  it('the board path re-resolves the intent instead of clearing a flag', () => {
    // A `let canResume` that the guard flips to false is NOT enough, and asserting
    // only that the `let` exists cannot tell the difference: the declaration alone
    // satisfies it, so deleting the downgrade passed. Worse, flipping the flag
    // leaves `intent.prompt` on the RESUME branch's value (`resumePrompt`,
    // undefined for an ordinary task spawn), so the fresh spawn it produces comes
    // up with no task prompt - itself a zero-turn conversation, which is exactly
    // what this guard downgrades. Only re-running the resolver forceFresh takes
    // the fresh branch's interpolated promptTemplate with it.
    const source = fs.readFileSync(
      path.join(repoRoot, 'src/main/transition-engine/transition-engine.ts'), 'utf8',
    );
    expect(source).toMatch(/resolveSpawnIntent\(\{ \.\.\.spawnIntentOptions, forceFresh: true \}\)/);
    // And the decision is then READ from the re-resolved intent, not a stale flag.
    expect(source).toMatch(/const canResume = intent\.mode === 'resume'/);
  });

  it('startup recovery is structurally promptless, so it only needs the flag', () => {
    // prepare-spawn.ts passes `prompt: undefined` unconditionally - a recovered
    // session never carries one - so there is no fresh-branch prompt for a
    // downgrade to lose there. If that ever changes, this file's board-path
    // re-resolve has to be mirrored into it.
    const source = fs.readFileSync(
      path.join(repoRoot, 'src/main/transition-engine/session-startup/prepare-spawn.ts'), 'utf8',
    );
    expect(source).toMatch(/prompt: undefined/);
  });
});
