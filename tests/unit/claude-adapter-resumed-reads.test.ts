/**
 * How the real Claude adapter's readers find a conversation Claude kept writing
 * under the folder it STARTED in, while the session's cwd is a worktree, and how
 * they honor the transcript path an agent reported
 * (`src/main/agent/adapters/claude/transcript-locator.ts`).
 *
 * Claude files a conversation at `<home>/.claude/projects/<slug(folder)>/<id>.jsonl`
 * and a `--resume` from another folder keeps appending there. Measured on Claude
 * Code 2.1.312: task agents started in the project root were resumed in
 * `<root>/.kangentic/worktrees/<n>`, and every later turn landed in the
 * root-slug file. A path built from the cwd names a file that does not exist.
 * `claude-transcript-locator.test.ts` pins the locator and a few readers; this
 * file pins the rest of the adapter's readers against the same layout:
 *
 *  - the run-level reads (`transcriptUsage`, `transcriptToolCounts`), which have
 *    their own reported-path rule (`resolveRunTranscriptPath`): the reported file
 *    wins whatever id it names, since a live `/clear` fork moves the report to
 *    the new file before the session row's id follows;
 *  - the slash-command verifier;
 *  - `ClaudeSessionHistoryParser.locate`, the live-telemetry reader's attach;
 *  - the subagent readers;
 *  - the background-shell and rejected-prompt drains, which are synchronous and
 *    so only peek: the first call starts the find, a later call has the answer.
 *
 * Every case runs against a temp home (`os.homedir` spied), so the real
 * `~/.claude` never decides one, and every write is under `os.tmpdir()`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearClaudeTranscriptLocatorCacheForTests,
  findClaudeTranscriptFile,
} from '../../src/main/agent/adapters/claude/transcript-locator';
import {
  claudeProjectSlug,
  resetToolCallCursorsForTests,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { ClaudeSessionHistoryParser } from '../../src/main/agent/adapters/claude/session-history-parser';
import {
  reportTerminatedBackgroundShells,
  resetBackgroundShellTranscriptCursorsForTests,
} from '../../src/main/agent/adapters/claude/background-shell-transcript';
import { reportRejectedPromptTools } from '../../src/main/agent/adapters/claude/permission-rejection-transcript';
import type { SubmissionContext } from '../../src/shared/types';
import { claudeTranscriptLines } from './helpers/claude-transcript-fixture';

const AGENT_SESSION_ID = 'eeb45f96-13b4-4780-a79d-6cd3a3094dcb';
/** The id a live `/clear` fork moves the conversation to. */
const FORK_SESSION_ID = '23985a96-1fe5-4964-bf04-65eaf7a76b20';

let workDir: string;
let tempHome: string;
let projectRoot: string;
let worktree: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-resumed-reads-'));
  tempHome = path.join(workDir, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  projectRoot = path.join(workDir, 'project');
  worktree = path.join(projectRoot, '.kangentic', 'worktrees', '918');
});

afterEach(() => {
  // Mocks first: a spy on the faked setTimeout must be undone before the real
  // timers are put back.
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearClaudeTranscriptLocatorCacheForTests();
  resetToolCallCursorsForTests();
  resetBackgroundShellTranscriptCursorsForTests();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function projectsRoot(): string {
  return path.join(tempHome, '.claude', 'projects');
}

/** The transcript a conversation that started in `folder` writes. */
function transcriptUnder(folder: string, agentSessionId = AGENT_SESSION_ID): string {
  return path.join(projectsRoot(), claudeProjectSlug(folder), `${agentSessionId}.jsonl`);
}

/** Where Claude puts that conversation's subagent transcripts. */
function subagentsDirectoryUnder(folder: string, agentSessionId = AGENT_SESSION_ID): string {
  return path.join(projectsRoot(), claudeProjectSlug(folder), agentSessionId, 'subagents');
}

function writeFile(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

/** Waits for real I/O to land, in real time, so a hang fails with a message. */
async function untilTrue(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Gave up waiting for ${description}.`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Whether anything has probed `filePath` with an async stat. The locator's
 * search stats the cwd's parent folders' candidate files, so this is how a test
 * sees that a synchronous read started the search ITSELF, before the test asks
 * the locator for anything. Watch before the read being observed.
 */
function watchAsyncStatsOf(filePath: string): () => boolean {
  const statSpy = vi.spyOn(fs.promises, 'stat');
  return () => statSpy.mock.calls.some(([probed]) => path.resolve(String(probed)) === path.resolve(filePath));
}

/** A turn the conversation left behind that none of the reads below look for. */
function plainTurn(agentSessionId: string, cwd: string): string {
  const lines = claudeTranscriptLines({ agentSessionId, cwd });
  return lines.humanPrompt('old-1', 'Old prompt.') + lines.assistantText('old-2', 'Old reply.');
}

// ---------------------------------------------------------------------------
// Run-level reads: transcriptUsage and transcriptToolCounts.
// ---------------------------------------------------------------------------

interface TokenCounts {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

/** What `transcriptUsage` reports for one message's counts: the whole input side, and the output. */
function expectedUsage(tokens: TokenCounts): { inputTokens: number; outputTokens: number } {
  return { inputTokens: tokens.input + tokens.cacheCreation + tokens.cacheRead, outputTokens: tokens.output };
}

/** One assistant message that carries token usage, shaped like the CLI's own. */
function assistantUsageLine(agentSessionId: string, cwd: string, tokens: TokenCounts): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: `usage-${agentSessionId}`,
    sessionId: agentSessionId,
    cwd,
    timestamp: '2026-01-01T00:10:00.000Z',
    message: {
      id: `msg-usage-${agentSessionId}`,
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'Working on it.' }],
      usage: {
        input_tokens: tokens.input,
        cache_creation_input_tokens: tokens.cacheCreation,
        cache_read_input_tokens: tokens.cacheRead,
        output_tokens: tokens.output,
      },
    },
  })}\n`;
}

/**
 * A conversation file whose token totals and one tool call name it: two files
 * that differ in both can never be mistaken for each other by a passing read.
 */
function conversationText(options: { agentSessionId: string; cwd: string; tokens: TokenCounts; toolName: string }): string {
  const lines = claudeTranscriptLines({ agentSessionId: options.agentSessionId, cwd: options.cwd });
  const toolUseId = `toolu_${options.toolName}`;
  return lines.humanPrompt('u-1', 'Do the work.')
    + lines.assistantTool('a-1', toolUseId, options.toolName)
    + lines.toolResult('r-1', toolUseId)
    + assistantUsageLine(options.agentSessionId, options.cwd, options.tokens);
}

const ROOT_TOKENS: TokenCounts = { input: 12, cacheCreation: 300, cacheRead: 4000, output: 90 };
const FORK_TOKENS: TokenCounts = { input: 7, cacheCreation: 50, cacheRead: 900, output: 25 };

describe('ClaudeAdapter.transcriptUsage and transcriptToolCounts', () => {
  const adapter = new ClaudeAdapter();

  function writeRootConversation(): string {
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile, conversationText({
      agentSessionId: AGENT_SESSION_ID, cwd: worktree, tokens: ROOT_TOKENS, toolName: 'Bash',
    }));
    return rootFile;
  }

  it('reads a root-slug conversation from a worktree cwd when no transcript path was reported', async () => {
    writeRootConversation();
    const input = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    await expect(adapter.transcriptUsage(input)).resolves.toEqual(expectedUsage(ROOT_TOKENS));
    const counts = await adapter.transcriptToolCounts(input);
    expect(counts?.toolCallCount).toBe(1);
    expect(counts?.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Bash']);
  });

  it('reads the reported file when that is all it is given, with no session id or cwd', async () => {
    const rootFile = writeRootConversation();

    await expect(adapter.transcriptUsage({ transcriptPath: rootFile })).resolves.toEqual(expectedUsage(ROOT_TOKENS));
    const counts = await adapter.transcriptToolCounts({ transcriptPath: rootFile });
    expect(counts?.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Bash']);
  });

  it('falls back to the locator when the reported file is gone (a relocation left a stale path)', async () => {
    writeRootConversation();
    const gone = path.join(workDir, 'old-home', '.claude', 'projects', '-old', `${AGENT_SESSION_ID}.jsonl`);
    const input = { transcriptPath: gone, agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    await expect(adapter.transcriptUsage(input)).resolves.toEqual(expectedUsage(ROOT_TOKENS));
    const counts = await adapter.transcriptToolCounts(input);
    expect(counts?.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Bash']);
  });

  it('reads the reported file over the old id\'s file when it names a /clear fork\'s new id', async () => {
    // The session row still holds the old id, and that conversation's file is
    // right where the locator would find it. The live report already moved to
    // the fork's file, which is the one the run's totals belong to.
    writeRootConversation();
    const forkFile = transcriptUnder(projectRoot, FORK_SESSION_ID);
    writeFile(forkFile, conversationText({
      agentSessionId: FORK_SESSION_ID, cwd: worktree, tokens: FORK_TOKENS, toolName: 'Read',
    }));
    const input = { transcriptPath: forkFile, agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    await expect(adapter.transcriptUsage(input)).resolves.toEqual(expectedUsage(FORK_TOKENS));
    const counts = await adapter.transcriptToolCounts(input);
    expect(counts?.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Read']);
    // Control: without the report, the same call reads the old conversation.
    const withoutReport = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };
    await expect(adapter.transcriptUsage(withoutReport)).resolves.toEqual(expectedUsage(ROOT_TOKENS));
  });
});

// ---------------------------------------------------------------------------
// The slash-command verifier.
// ---------------------------------------------------------------------------

describe('ClaudeAdapter slash-command verifier', () => {
  const sentAt = Date.now() - 1000;

  function injectionContext(transcriptPath?: string): SubmissionContext {
    return {
      type: 'command-injection',
      text: '/model opus',
      agentSessionId: AGENT_SESSION_ID,
      cwd: worktree,
      cliTarget: null,
      sentAt,
      mode: 'command-match',
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
    };
  }

  it('confirms the command in the reported root-slug file over a stale same-id file at the cwd path', async () => {
    // An older Claude's failed resume left a copy at the worktree's slug that
    // never saw the command. The live conversation has it, under the root slug.
    writeFile(transcriptUnder(worktree), plainTurn(AGENT_SESSION_ID, worktree));
    const realFile = transcriptUnder(projectRoot);
    writeFile(realFile, `${JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      timestamp: new Date(sentAt + 200).toISOString(),
    })}\n`);
    const verifier = new ClaudeAdapter().getSubmissionVerifier('command-injection');
    expect(verifier).not.toBeNull();

    await expect(verifier!(injectionContext(realFile))).resolves.toBe(true);
    // Control: with no reported path the read opens the stale cwd copy.
    await expect(verifier!(injectionContext())).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaudeSessionHistoryParser.locate: the live-telemetry reader's attach.
// ---------------------------------------------------------------------------

describe('ClaudeSessionHistoryParser.locate', () => {
  /**
   * Fakes only the sleep. Real file I/O must keep running, so `setImmediate` and
   * the clock are left alone, and the spy counts the 500 ms sleeps `locate` takes.
   */
  function fakeOnlyTheSleep(): () => number {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    return () => timeoutSpy.mock.calls.filter((call) => call[1] === 500).length;
  }

  it('resolves a root-slug file from a worktree cwd on the first attempt, without a sleep', { timeout: 2000 }, async () => {
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile, plainTurn(AGENT_SESSION_ID, projectRoot));
    const sleeps = fakeOnlyTheSleep();

    // No timer is advanced anywhere: a locate that needed one would never settle.
    await expect(ClaudeSessionHistoryParser.locate({ agentSessionId: AGENT_SESSION_ID, cwd: worktree }))
      .resolves.toBe(rootFile);
    expect(sleeps()).toBe(0);
  });

  it('returns a file that appears at the cwd path after two 500 ms polls', async () => {
    const sleeps = fakeOnlyTheSleep();
    const located = ClaudeSessionHistoryParser.locate({ agentSessionId: AGENT_SESSION_ID, cwd: worktree });

    // Poll one finds nothing and sleeps; so does poll two.
    await untilTrue(() => sleeps() === 1, 'the first poll to miss');
    await vi.advanceTimersByTimeAsync(500);
    await untilTrue(() => sleeps() === 2, 'the second poll to miss');

    const cwdFile = transcriptUnder(worktree);
    writeFile(cwdFile, plainTurn(AGENT_SESSION_ID, worktree));
    await vi.advanceTimersByTimeAsync(500);

    await expect(located).resolves.toBe(cwdFile);
    expect(sleeps()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Subagents.
// ---------------------------------------------------------------------------

/** One subagent turn as the CLI writes it: a sidechain assistant message with usage. */
function subagentTurnLine(messageId: string, tokens: TokenCounts): string {
  return `${JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    uuid: `${messageId}-record`,
    timestamp: '2026-09-01T00:00:00.000Z',
    attributionAgent: 'review-finder',
    message: {
      id: messageId,
      model: 'claude-sonnet-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'Looked at the diff.' }],
      usage: {
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_creation_input_tokens: tokens.cacheCreation,
        cache_read_input_tokens: tokens.cacheRead,
      },
    },
  })}\n`;
}

const SUBAGENT_TOKENS: TokenCounts = { input: 2, cacheCreation: 6392, cacheRead: 9882, output: 253 };

describe('Claude subagent reads of a conversation filed under the root slug', () => {
  const adapter = new ClaudeAdapter();

  /** The root-slug main transcript, plus one subagent transcript and its sidecar beside it. */
  function writeRootConversationWithSubagent(): { rootFile: string; subagentFile: string } {
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile, plainTurn(AGENT_SESSION_ID, projectRoot));
    const subagentFile = path.join(subagentsDirectoryUnder(projectRoot), 'agent-1.jsonl');
    writeFile(subagentFile, subagentTurnLine('msg_01', SUBAGENT_TOKENS));
    writeFile(
      path.join(subagentsDirectoryUnder(projectRoot), 'agent-1.meta.json'),
      JSON.stringify({ agentType: 'review-finder', spawnDepth: 1, toolUseId: 'toolu_01AAA' }),
    );
    return { rootFile, subagentFile };
  }

  it('parses the subagents directory beside the root-slug file from a worktree cwd', async () => {
    writeRootConversationWithSubagent();

    const parsed = await adapter.parseSubagentUsage(AGENT_SESSION_ID, worktree);

    expect(parsed.directoryPresent).toBe(true);
    expect(parsed.complete).toBe(true);
    expect(parsed.sourcePath).toBe(subagentsDirectoryUnder(projectRoot));
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].agentType).toBe('review-finder');
    expect(parsed.turns[0].usage).toEqual({
      inputTokens: SUBAGENT_TOKENS.input,
      outputTokens: SUBAGENT_TOKENS.output,
      cacheCreationInputTokens: SUBAGENT_TOKENS.cacheCreation,
      cacheReadInputTokens: SUBAGENT_TOKENS.cacheRead,
    });
  });

  it('signs the directory once the peek\'s background find has landed, and not before', async () => {
    const { rootFile, subagentFile } = writeRootConversationWithSubagent();
    const probedRootFile = watchAsyncStatsOf(rootFile);

    // The synchronous form never searches: the first look names the cwd's
    // directory, which does not exist, and starts the find.
    expect(adapter.statSubagentTranscripts(AGENT_SESSION_ID, worktree)).toBeNull();
    await untilTrue(probedRootFile, 'the first look\'s find to reach the root slug');

    await findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree });
    const stats = fs.statSync(subagentFile);
    expect(adapter.statSubagentTranscripts(AGENT_SESSION_ID, worktree)).toEqual({
      fileCount: 1,
      totalSize: stats.size,
      maxMtimeMs: stats.mtimeMs,
    });
  });

  it('follows a reported root-slug path past a stale same-id file at the cwd path', async () => {
    // The stale copy is at the worktree's slug with no subagents directory, so
    // the cwd path is present and nothing else would be looked for.
    const { rootFile, subagentFile } = writeRootConversationWithSubagent();
    writeFile(transcriptUnder(worktree), plainTurn(AGENT_SESSION_ID, worktree));

    // Control: without the report, the stale copy decides, and has no subagents.
    const withoutReport = await adapter.parseSubagentUsage(AGENT_SESSION_ID, worktree);
    expect(withoutReport.directoryPresent).toBe(false);
    expect(adapter.statSubagentTranscripts(AGENT_SESSION_ID, worktree)).toBeNull();

    const withReport = await adapter.parseSubagentUsage(AGENT_SESSION_ID, worktree, null, rootFile);
    expect(withReport.directoryPresent).toBe(true);
    expect(withReport.turns).toHaveLength(1);
    // The reported path answers the first synchronous look, with no find landed.
    const stats = fs.statSync(subagentFile);
    expect(adapter.statSubagentTranscripts(AGENT_SESSION_ID, worktree, null, rootFile)).toEqual({
      fileCount: 1,
      totalSize: stats.size,
      maxMtimeMs: stats.mtimeMs,
    });
  });
});

// ---------------------------------------------------------------------------
// The synchronous drains: background shells and rejected permission prompts.
// ---------------------------------------------------------------------------

const SHELL_ID = 'bvqiw3a6s';
const TOOL_USE_ID = 'toolu_01AnwL9uExampleToolId';

/** Claude's `<task-notification>` for a finished background shell, as one JSONL record. */
function shellFinishedLine(shellId: string): string {
  const content =
    `<task-notification>\n<task-id>${shellId}</task-id>\n`
    + '<command>npx vitest run tests/unit/hmr-resync.test.ts</command>\n'
    + '<status>completed</status>\n</task-notification>';
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    sessionId: AGENT_SESSION_ID,
    uuid: '11e75685-8e19-4522-9a07-af0ebe89727e',
    timestamp: '2026-07-10T20:12:32.046Z',
  })}\n`;
}

/** The synthetic `tool_result` Claude appends when the user denies a permission prompt. */
function promptDeniedLine(toolUseId: string, timestamp: string): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: 'd4e5f6a7-8b9c-4d0e-1f2a-3b4c5d6e7f80',
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: true,
          content:
            "The user doesn't want to proceed with this tool use. The tool use was rejected "
            + '(eg. if it was a file edit, the new_string was NOT written to the file). '
            + 'STOP what you are doing and wait for the user to tell you how to proceed.',
        },
      ],
    },
  })}\n`;
}

describe('reportTerminatedBackgroundShells for a conversation filed under the root slug', () => {
  function reportShells(transcriptPath?: string): string[] {
    return reportTerminatedBackgroundShells({
      cwd: worktree,
      agentSessionId: AGENT_SESSION_ID,
      shellIds: [SHELL_ID],
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
    });
  }

  it('drains the finished shell from the reported file past a stale same-id file at the cwd path', () => {
    writeFile(transcriptUnder(worktree), plainTurn(AGENT_SESSION_ID, worktree));
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile, plainTurn(AGENT_SESSION_ID, projectRoot));

    // The first call anchors the cursor at the end of the file it reads.
    expect(reportShells(rootFile)).toEqual([]);
    fs.appendFileSync(rootFile, shellFinishedLine(SHELL_ID));
    expect(reportShells(rootFile)).toEqual([SHELL_ID]);
  });

  it('drains it with no reported path once the first call\'s background find has landed', async () => {
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile, plainTurn(AGENT_SESSION_ID, projectRoot));
    const probedRootFile = watchAsyncStatsOf(rootFile);

    // Call one reads the cwd path, which is not there, and starts the find.
    expect(reportShells()).toEqual([]);
    await untilTrue(probedRootFile, 'the first call\'s find to reach the root slug');
    await findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree });
    // Call two is the first on the root-slug file: it anchors at its end.
    expect(reportShells()).toEqual([]);
    fs.appendFileSync(rootFile, shellFinishedLine(SHELL_ID));
    expect(reportShells()).toEqual([SHELL_ID]);
  });
});

describe('reportRejectedPromptTools for a conversation filed under the root slug', () => {
  const deniedAt = '2026-07-10T20:12:32.046Z';
  const sinceMs = Date.parse('2026-07-10T20:12:00.000Z');

  function reportRejected(transcriptPath?: string): string[] {
    return reportRejectedPromptTools({
      cwd: worktree,
      agentSessionId: AGENT_SESSION_ID,
      toolIds: [TOOL_USE_ID],
      sinceMs,
      ...(transcriptPath === undefined ? {} : { transcriptPath }),
    });
  }

  it('finds the denial in the reported file past a stale same-id file at the cwd path', () => {
    writeFile(transcriptUnder(worktree), plainTurn(AGENT_SESSION_ID, worktree));
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile, plainTurn(AGENT_SESSION_ID, projectRoot) + promptDeniedLine(TOOL_USE_ID, deniedAt));

    expect(reportRejected(rootFile)).toEqual([TOOL_USE_ID]);
  });

  it('finds it with no reported path once the first call\'s background find has landed', async () => {
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile, plainTurn(AGENT_SESSION_ID, projectRoot) + promptDeniedLine(TOOL_USE_ID, deniedAt));
    const probedRootFile = watchAsyncStatsOf(rootFile);

    // Call one reads the cwd path, which is not there, and starts the find.
    expect(reportRejected()).toEqual([]);
    await untilTrue(probedRootFile, 'the first call\'s find to reach the root slug');
    await findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree });
    expect(reportRejected()).toEqual([TOOL_USE_ID]);
  });
});
