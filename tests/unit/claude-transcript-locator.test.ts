/**
 * Where a Claude conversation's transcript is, wherever Claude wrote it
 * (`src/main/agent/adapters/claude/transcript-locator.ts`).
 *
 * Claude files a conversation under the slug of the folder it STARTED in, and a
 * `--resume` from another folder keeps appending there. Measured on Claude Code
 * 2.1.312: four task agents started in the project root were resumed with their
 * worktree as cwd, and every later turn landed in the root-slug files. Every
 * Kangentic read built the path from the cwd, so the turn end read no reply, the
 * submit check never confirmed, and the workflow stalled.
 *
 * The first block pins the locator's order and its cache. The second drives the
 * real Claude adapter through the reads that failed: the turn end's reply, the
 * auto_command check, and `get_transcript`'s parse.
 *
 * Every case runs against a temp home (`os.homedir` spied), so the real
 * `~/.claude` never decides one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearClaudeTranscriptLocatorCacheForTests,
  findClaudeTranscriptFile,
  peekClaudeTranscriptFile,
  resolveClaudeTranscriptFile,
} from '../../src/main/agent/adapters/claude/transcript-locator';
import { claudeProjectSlug, locateClaudeTranscriptFile } from '../../src/main/agent/adapters/claude/transcript-parser';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { readFinalReply } from '../../src/main/agent/message-trail-read';
import { claudeTranscriptLines } from './helpers/claude-transcript-fixture';

const AGENT_SESSION_ID = 'eeb45f96-13b4-4780-a79d-6cd3a3094dcb';
const OTHER_SESSION_ID = '23985a96-1fe5-4964-bf04-65eaf7a76b20';
const FILE_NAME = `${AGENT_SESSION_ID}.jsonl`;

let workDir: string;
let tempHome: string;
let projectRoot: string;
let worktree: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-transcript-locator-'));
  tempHome = path.join(workDir, 'home');
  fs.mkdirSync(tempHome, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
  projectRoot = path.join(workDir, 'project');
  worktree = path.join(projectRoot, '.kangentic', 'worktrees', '918');
});

afterEach(() => {
  vi.restoreAllMocks();
  clearClaudeTranscriptLocatorCacheForTests();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function projectsRoot(): string {
  return path.join(tempHome, '.claude', 'projects');
}

/** The transcript a session started in `folder` writes. */
function transcriptUnder(folder: string, agentSessionId = AGENT_SESSION_ID): string {
  return path.join(projectsRoot(), claudeProjectSlug(folder), `${agentSessionId}.jsonl`);
}

function writeFile(filePath: string, body = '{"type":"user"}\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

/** Counts the readdirs of the projects folder, which only the full scan makes. */
function countProjectScans(): () => number {
  const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
  let scans = 0;
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
    if (path.resolve(String(args[0])) === path.resolve(projectsRoot())) scans += 1;
    return realReaddir(...args);
  }) as unknown as typeof fs.promises.readdir);
  return () => scans;
}

describe('findClaudeTranscriptFile - where it looks', () => {
  it('finds the file at the cwd path for a conversation that started there', async () => {
    const filePath = transcriptUnder(worktree);
    writeFile(filePath);
    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(filePath);
  });

  it('finds a conversation started in the project root from its worktree, without listing the projects folder', async () => {
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile);
    // Many sibling worktrees: each one's slug shares a longer prefix with this
    // worktree's than the root's does, so a search ordered by shared prefix
    // would reach the root last.
    for (let index = 0; index < 40; index++) {
      writeFile(transcriptUnder(path.join(projectRoot, '.kangentic', 'worktrees', String(900 + index)), OTHER_SESSION_ID));
    }
    const scans = countProjectScans();

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(rootFile);
    expect(scans()).toBe(0);
  });

  it('finds a conversation started in an unrelated folder by listing the projects folder', async () => {
    const elsewhere = transcriptUnder(path.join(workDir, 'somewhere', 'else'));
    writeFile(elsewhere);
    writeFile(transcriptUnder(path.join(workDir, 'another'), OTHER_SESSION_ID));
    const scans = countProjectScans();

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(elsewhere);
    expect(scans()).toBe(1);
  });

  it('returns null, and resolve returns the cwd path, when the conversation is nowhere', async () => {
    writeFile(transcriptUnder(projectRoot, OTHER_SESSION_ID));
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };
    await expect(findClaudeTranscriptFile(query)).resolves.toBeNull();
    await expect(resolveClaudeTranscriptFile(query)).resolves.toBe(locateClaudeTranscriptFile(AGENT_SESSION_ID, worktree));
  });
});

describe('findClaudeTranscriptFile - the path Claude reported', () => {
  it('wins over a same-id file at the cwd path and over a search hit', async () => {
    // A stale copy where the cwd maps (an older Claude's failed resume left one),
    // and the real file Claude reported writing under the folder it started in.
    const staleAtCwd = transcriptUnder(worktree);
    writeFile(staleAtCwd, '{"stale":true}\n');
    const reported = transcriptUnder(projectRoot);
    writeFile(reported);

    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath: reported }))
      .resolves.toBe(reported);
    // Control: without the report, the cwd's copy is what a read would open.
    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree })).resolves.toBe(staleAtCwd);
  });

  it('is ignored when it names another conversation (a row from before a /clear fork)', async () => {
    const otherConversation = transcriptUnder(projectRoot, OTHER_SESSION_ID);
    writeFile(otherConversation);
    const own = transcriptUnder(worktree);
    writeFile(own);
    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath: otherConversation }))
      .resolves.toBe(own);
  });

  it('is ignored when it is relative or its file is gone (a project relocation leaves it stale)', async () => {
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile);
    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath: FILE_NAME }))
      .resolves.toBe(rootFile);
    const gone = path.join(workDir, 'old-home', '.claude', 'projects', '-old', FILE_NAME);
    await expect(findClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath: gone }))
      .resolves.toBe(rootFile);
  });
});

describe('findClaudeTranscriptFile - the cache', () => {
  it('drops a found file that was deleted and searches again', async () => {
    const first = transcriptUnder(path.join(workDir, 'first'));
    writeFile(first);
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(first);

    fs.rmSync(first);
    const second = transcriptUnder(path.join(workDir, 'second'));
    writeFile(second);
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(second);
  });

  it('does not list the projects folder again for 30 s after it found nothing', async () => {
    writeFile(transcriptUnder(path.join(workDir, 'unrelated'), OTHER_SESSION_ID));
    let now = Date.UTC(2026, 9, 27, 20, 0, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const scans = countProjectScans();
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    await expect(findClaudeTranscriptFile(query)).resolves.toBeNull();
    expect(scans()).toBe(1);

    const elsewhere = transcriptUnder(path.join(workDir, 'somewhere'));
    writeFile(elsewhere);
    now += 29_000;
    await expect(findClaudeTranscriptFile(query)).resolves.toBeNull();
    expect(scans()).toBe(1);

    now += 2_000;
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(elsewhere);
    expect(scans()).toBe(2);
  });

  it('still checks the cwd path while a miss is remembered, so a fresh session file is found at once', async () => {
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };
    await expect(findClaudeTranscriptFile(query)).resolves.toBeNull();
    const fresh = transcriptUnder(worktree);
    writeFile(fresh);
    await expect(findClaudeTranscriptFile(query)).resolves.toBe(fresh);
  });
});

describe('peekClaudeTranscriptFile - the synchronous form', () => {
  it('never lists a folder, and has the found path once the find it started lands', async () => {
    const elsewhere = transcriptUnder(path.join(workDir, 'somewhere'));
    writeFile(elsewhere);
    const readdirSync = vi.spyOn(fs, 'readdirSync');
    const readdir = vi.spyOn(fs.promises, 'readdir');
    const query = { agentSessionId: AGENT_SESSION_ID, cwd: worktree };

    expect(peekClaudeTranscriptFile(query)).toBe(locateClaudeTranscriptFile(AGENT_SESSION_ID, worktree));
    // The peek returned before any listing began: the find it started is still
    // at its first stat.
    expect(readdir).not.toHaveBeenCalled();
    // Wait for a find to land (the peek's may still be running beside this one).
    await findClaudeTranscriptFile(query);
    expect(peekClaudeTranscriptFile(query)).toBe(elsewhere);
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it('takes the reported path and a parent folder hit without a search', () => {
    const reported = transcriptUnder(projectRoot);
    writeFile(reported);
    expect(peekClaudeTranscriptFile({ agentSessionId: AGENT_SESSION_ID, cwd: worktree, reportedPath: reported })).toBe(reported);
  });
});

describe('Claude reads of a conversation resumed from another folder', () => {
  const lines = (cwd: string) => claudeTranscriptLines({ agentSessionId: AGENT_SESSION_ID, cwd });

  /** A turn that began in the root and one resumed in the worktree, both in the root-slug file. */
  function writeResumedConversation(): string {
    const fromRoot = lines(projectRoot);
    const fromWorktree = lines(worktree);
    const rootFile = transcriptUnder(projectRoot);
    writeFile(rootFile, [
      fromRoot.humanPrompt('u-1', 'Start the step.'),
      fromRoot.assistantText('a-1', 'Started in the root.'),
      fromRoot.turnEnd('s-1'),
      fromWorktree.humanPrompt('u-2', 'Run the tests.'),
      fromWorktree.assistantText('a-2', 'On to Merge'),
      fromWorktree.turnEnd('s-2'),
    ].join(''));
    return rootFile;
  }

  it('reads the final reply a turn end judges, from the worktree cwd', async () => {
    writeResumedConversation();
    const reply = await readFinalReply(new ClaudeAdapter(), {
      sessionType: 'claude',
      agentSessionId: AGENT_SESSION_ID,
      cwd: worktree,
      cliTarget: null,
    });
    expect(reply?.text).toBe('On to Merge');
  });

  it('reads the reported file over a stale same-id file at the cwd path', async () => {
    const rootFile = writeResumedConversation();
    const stale = lines(worktree);
    writeFile(transcriptUnder(worktree), [
      stale.humanPrompt('x-1', 'Old prompt.'),
      stale.assistantText('x-2', 'Old reply.'),
    ].join(''));

    const facts = { sessionType: 'claude', agentSessionId: AGENT_SESSION_ID, cwd: worktree, cliTarget: null };
    expect((await readFinalReply(new ClaudeAdapter(), facts))?.text).toBe('Old reply.');
    expect((await readFinalReply(new ClaudeAdapter(), { ...facts, transcriptPath: rootFile }))?.text).toBe('On to Merge');
  });

  it('confirms an auto_command written to the conversation under the root slug', async () => {
    const sentAt = Date.now() - 1000;
    writeFile(transcriptUnder(projectRoot), `${JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      timestamp: new Date(sentAt + 200).toISOString(),
    })}\n`);
    const verifier = new ClaudeAdapter().getSubmissionVerifier('command-injection');
    expect(verifier).not.toBeNull();

    await expect(verifier!({
      type: 'command-injection',
      text: '/model opus',
      agentSessionId: AGENT_SESSION_ID,
      cwd: worktree,
      cliTarget: null,
      sentAt,
      mode: 'command-match',
    })).resolves.toBe(true);
  });

  it('parses the live file for get_transcript rather than reporting it missing', async () => {
    const rootFile = writeResumedConversation();
    const parsed = await new ClaudeAdapter().parseTranscript(AGENT_SESSION_ID, worktree);
    expect(parsed.sourcePath).toBe(rootFile);
    expect(parsed.entries.some((entry) => entry.kind === 'assistant')).toBe(true);
  });
});
