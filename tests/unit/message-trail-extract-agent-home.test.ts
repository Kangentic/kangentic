/**
 * extractTranscript (tests/captures/helpers/message-trail-extract.ts) for a recording made in a WSL
 * distro, the SSH scenes' Claude Code on a Linux host. That Claude writes its history in the
 * distro's home, under a folder named for the Linux path it ran in, so neither this computer's home
 * nor the share path the capture was given finds it. Read from the wrong place, the run has no
 * transcript, and the card's trail and the conversation would ship empty.
 *
 * The distro's home is a temp folder here, and this computer's `os.homedir()` is mocked to another
 * (the seam message-trail-extract-pasted.test.ts uses), so each read can only find what it should.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import { TranscriptMatchError, extractTranscript } from '../captures/helpers/message-trail-extract';

const LINUX_CWD = '/home/someone/redis/.kangentic/worktrees/pin-expire-negative-ttl';
const SHARE_CWD = '\\\\wsl.localhost\\Distro\\home\\someone\\redis\\.kangentic\\worktrees\\pin-expire-negative-ttl';
const PROMPT = 'Add a test to tests/unit/expire.tcl that pins what EXPIRE does when the TTL is negative.';
const CAPTURED_AT = '2026-01-01T00:10:00.000Z';
const DURATION_MS = 5 * 60 * 1000;
const START_MS = Date.parse(CAPTURED_AT) - DURATION_MS;

function claudeHistory(): string {
  return [
    JSON.stringify({ type: 'user', uuid: 'user-1', timestamp: new Date(START_MS + 1000).toISOString(), message: { role: 'user', content: PROMPT } }),
    JSON.stringify({
      type: 'assistant', uuid: 'assistant-1', timestamp: new Date(START_MS + 9000).toISOString(),
      message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'expireGenericCommand deletes the key when the TTL is in the past.' }] },
    }),
  ].join('\n');
}

describe('extractTranscript for a run in a WSL distro', () => {
  let distroHome: string;
  let computerHome: string;

  beforeEach(() => {
    distroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-distro-home-'));
    computerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-computer-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(computerHome);
    const historyFolder = path.join(distroHome, '.claude', 'projects', claudeProjectSlug(LINUX_CWD));
    fs.mkdirSync(historyFolder, { recursive: true });
    fs.writeFileSync(path.join(historyFolder, 'session-1.jsonl'), `${claudeHistory()}\n`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(distroHome, { recursive: true, force: true });
    fs.rmSync(computerHome, { recursive: true, force: true });
  });

  const facts = { agent: 'claude', prompt: PROMPT, capturedAt: CAPTURED_AT, durationMs: DURATION_MS };

  it('reads the history the distro\'s Claude wrote, under the Linux folder it ran in', async () => {
    const transcript = await extractTranscript(facts, SHARE_CWD, { home: distroHome, cwd: LINUX_CWD });
    expect(transcript?.sourcePath).toBe(path.join(distroHome, '.claude', 'projects', claudeProjectSlug(LINUX_CWD), 'session-1.jsonl'));
    expect(transcript?.entries.some((entry) => entry.kind === 'assistant')).toBe(true);
  });

  it('finds nothing in this computer\'s home, which is what a read without the distro\'s would search', async () => {
    await expect(extractTranscript(facts, SHARE_CWD)).rejects.toBeInstanceOf(TranscriptMatchError);
  });

  it('refuses an agent whose history has never been read from a distro, rather than reading another home', async () => {
    await expect(extractTranscript({ ...facts, agent: 'codex' }, SHARE_CWD, { home: distroHome, cwd: LINUX_CWD }))
      .rejects.toThrow(/no transcript reader for a codex run in a WSL distro/);
  });
});
