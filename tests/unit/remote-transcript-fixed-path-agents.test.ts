/**
 * The conversation files of Qwen Code, Grok Build and Antigravity on a host reaching this computer (#913).
 * Each of the three keeps its transcript at a path that follows from the session id and the folder, so the
 * adapter names it and the tail copies it into this computer's mirror of the host's home, as for Claude Code.
 *
 * What a user loses if it breaks: a session on a host whose conversation viewer, search index or token ledger
 * stays empty for good, or a copy filed under a slug of this computer's folder that never matches the file the
 * CLI writes on the host.
 *
 * The expected host paths are written out from each CLI's own layout (not computed from the code under test),
 * so a wrong slug fails here instead of being copied.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QwenAdapter } from '../../src/main/agent/adapters/qwen-code';
import { GrokAdapter } from '../../src/main/agent/adapters/grok';
import { AntigravityAdapter } from '../../src/main/agent/adapters/antigravity';
import { parseQwenTranscript } from '../../src/main/agent/adapters/qwen-code/transcript-parser';
import { parseGrokTranscript } from '../../src/main/agent/adapters/grok/transcript-parser';
import { locateGrokUpdatesFile } from '../../src/main/agent/adapters/grok/session-paths';
import { parseAntigravityTranscriptFile } from '../../src/main/agent/adapters/antigravity/transcript-parser';
import { mirrorPathToHost, toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { remoteTranscriptSource } from '../../src/main/remote/remote-session-relay';

const SESSION_ID = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
const HOST_PROJECT = '/home/dev/api';

let scratch: string;
let shellFolder: string;
let mirror: string;

function placeAt(hostProject = HOST_PROJECT): SshCliPlace {
  return { kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome: mirror, roots: [{ local: shellFolder, host: hostProject }] };
}

/** A task's worktree stand-in under the shell folder, which the roots map to the worktree on the host. */
const standInFolder = (): string => path.join(shellFolder, '.kangentic', 'worktrees', '7');

function arrive(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const hostPathsOf = (files: readonly string[], place: SshCliPlace): Array<string | null> => files.map((file) => mirrorPathToHost(file, place));

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-fixed-path-transcripts-'));
  shellFolder = path.join(scratch, 'shell');
  mirror = path.join(scratch, 'mirror');
  fs.mkdirSync(shellFolder, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('Qwen Code', () => {
  const adapter = new QwenAdapter();
  const filesFor = (place: SshCliPlace, cwd = shellFolder): readonly string[] => adapter.remoteTranscriptFiles({
    agentSessionId: SESSION_ID,
    cwd,
    cliTarget: toStoredCliTarget(place)!,
  });

  it('names the one chat file, in the mirror, filed under the slug of the folder on the HOST', () => {
    const place = placeAt();
    const files = filesFor(place);

    expect(files).toHaveLength(1);
    expect(path.relative(mirror, files[0]).startsWith('..')).toBe(false);
    expect(hostPathsOf(files, place)).toEqual([`/home/dev/.qwen/projects/-home-dev-api/chats/${SESSION_ID}.jsonl`]);
    expect(fs.existsSync(files[0])).toBe(false);
  });

  it('files a task worktree under the slug of its folder on the host', () => {
    const place = placeAt();

    expect(hostPathsOf(filesFor(place, standInFolder()), place)).toEqual([
      `/home/dev/.qwen/projects/-home-dev-api--kangentic-worktrees-7/chats/${SESSION_ID}.jsonl`,
    ]);
  });

  it('declares nothing for a Qwen that does not run on a host', () => {
    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } })).toEqual([]);
  });

  it('shows a real conversation once it has arrived, to the reader that opens a local one', async () => {
    const place = placeAt();
    const [file] = filesFor(place);
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place)).resolves.toBeNull();

    arrive(file, fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'qwen-real-session.jsonl'), 'utf8'));

    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place)).resolves.toBe(file);
    expect((await parseQwenTranscript(SESSION_ID, file)).length).toBeGreaterThan(0);
  });
});

describe('Grok Build', () => {
  const adapter = new GrokAdapter();
  const filesFor = (place: SshCliPlace, cwd = shellFolder): readonly string[] => adapter.remoteTranscriptFiles({
    agentSessionId: SESSION_ID,
    cwd,
    cliTarget: toStoredCliTarget(place)!,
  });
  const CHAT_LINES = [
    JSON.stringify({ type: 'user', content: 'Add a retry to the upload step.' }),
    JSON.stringify({ type: 'assistant', content: 'The upload step now retries three times.' }),
  ].join('\n');
  const UPDATE_LINE = JSON.stringify({ params: { update: { sessionUpdate: 'turn_completed', usage: { inputTokens: 1200, outputTokens: 340 } } } });

  it('names both files, the chat history the viewer reads and the updates the ledger reads, filed under the key of the HOST folder', () => {
    const place = placeAt();
    const files = filesFor(place);

    expect(files.every((file) => !path.relative(mirror, file).startsWith('..'))).toBe(true);
    expect(hostPathsOf(files, place)).toEqual([
      `/home/dev/.grok/sessions/%2Fhome%2Fdev%2Fapi/${SESSION_ID}/chat_history.jsonl`,
      `/home/dev/.grok/sessions/%2Fhome%2Fdev%2Fapi/${SESSION_ID}/updates.jsonl`,
    ]);
  });

  it('files a task worktree under the key of its folder on the host', () => {
    const place = placeAt();

    expect(hostPathsOf(filesFor(place, standInFolder()), place)[0]).toBe(
      `/home/dev/.grok/sessions/${encodeURIComponent('/home/dev/api/.kangentic/worktrees/7')}/${SESSION_ID}/chat_history.jsonl`,
    );
  });

  it('declares nothing for a Grok that does not run on a host', () => {
    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } })).toEqual([]);
  });

  it('shows the conversation and its token totals once the two files have arrived', async () => {
    const place = placeAt();
    const [chatHistory, updates] = filesFor(place);
    await expect(parseGrokTranscript(SESSION_ID, shellFolder, place)).resolves.toMatchObject({ entries: [], sourcePath: null });
    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd: shellFolder, place })).resolves.toBeNull();

    arrive(chatHistory, `${CHAT_LINES}\n`);
    arrive(updates, `${UPDATE_LINE}\n`);

    const parsed = await parseGrokTranscript(SESSION_ID, shellFolder, place);
    expect(parsed.sourcePath).toBe(chatHistory);
    expect(JSON.stringify(parsed.entries)).toContain('The upload step now retries three times.');
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place)).resolves.toBe(chatHistory);
    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd: shellFolder, place })).resolves.toMatchObject({ inputTokens: 1200, outputTokens: 340 });
  });

  it('leaves the live telemetry reader off for a host, which would poll a minute for a file that has not landed', async () => {
    const startedAt = Date.now();

    await expect(locateGrokUpdatesFile({ agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: toStoredCliTarget(placeAt()) })).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe('Antigravity CLI', () => {
  const adapter = new AntigravityAdapter();
  const filesFor = (place: SshCliPlace): readonly string[] => adapter.remoteTranscriptFiles({
    agentSessionId: SESSION_ID,
    cliTarget: toStoredCliTarget(place)!,
  });
  const STEP = JSON.stringify({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-08-16T16:09:01Z',
    content: '<USER_REQUEST>\nCreate a file named probe.txt containing exactly: ok\n</USER_REQUEST>',
  });

  it('names the one transcript under the conversation\'s brain folder, in the mirror, whatever the working folder', () => {
    const place = placeAt();
    const files = filesFor(place);

    expect(path.relative(mirror, files[0]).startsWith('..')).toBe(false);
    expect(hostPathsOf(files, place)).toEqual([`/home/dev/.gemini/antigravity-cli/brain/${SESSION_ID}/.system_generated/logs/transcript.jsonl`]);
    expect(hostPathsOf(filesFor(placeAt('/srv/elsewhere')), placeAt('/srv/elsewhere'))).toEqual(hostPathsOf(files, place));
  });

  it('declares nothing for an agy that does not run on a host', () => {
    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } })).toEqual([]);
  });

  it('is named when the id arrives after the start, which is how a new conversation learns it', () => {
    const place = placeAt();
    const source = remoteTranscriptSource(adapter, shellFolder, toStoredCliTarget(place)!, path.join(shellFolder, '.kangentic', 'sessions', 'record'));

    expect(source.files(SESSION_ID)).toEqual(filesFor(place));
  });

  it('shows the conversation once it has arrived, to the reader that opens a local one', async () => {
    const place = placeAt();
    const [file] = filesFor(place);
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place)).resolves.toBeNull();

    arrive(file, `${STEP}\n`);

    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place)).resolves.toBe(file);
    const parsed = await parseAntigravityTranscriptFile(file, SESSION_ID);
    expect(JSON.stringify(parsed.entries)).toContain('Create a file named probe.txt containing exactly: ok');
  });
});
