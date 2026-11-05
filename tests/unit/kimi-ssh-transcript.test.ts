/**
 * A Kimi Code conversation on a host reaching this computer (#913, task 1004): which files the adapter names,
 * and that what lands in the mirror reads as a local conversation does. The wire and the index are captures of
 * a real Kimi Code 2.5.1 on Linux (`docs/audits/ssh-transcript-exports-audit.md`).
 *
 * What a user loses if it breaks: a Kimi session on a host with an empty viewer and no token count, or a
 * transcript that never starts copying because its path was only looked for on this computer's disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KimiAdapter } from '../../src/main/agent/adapters/kimi';
import { toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { getCachedTranscript } from '../../src/main/agent/transcript-cache';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const wireFixture = fs.readFileSync(path.join(FIXTURES, 'kimi-2.5.1-wire.jsonl'), 'utf8');
const indexFixture = fs.readFileSync(path.join(FIXTURES, 'kimi-2.5.1-session-index.jsonl'), 'utf8');

/** The two sessions of the captured index, the second being the one whose wire was captured. */
const indexLines = indexFixture.trim().split('\n').map((line) => JSON.parse(line) as { sessionId: string; sessionDir: string; workDir: string });
const SESSION = indexLines[1];
const OTHER_SESSION = indexLines[0];

let scratch: string;
let shellFolder: string;
let mirror: string;
const adapter = new KimiAdapter();

function placeAt(hostProject = SESSION.workDir): SshCliPlace {
  return { kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome: mirror, roots: [{ local: shellFolder, host: hostProject }] };
}

const mirrorPath = (...segments: string[]): string => path.join(mirror, ...segments);
const mirroredIndex = (): string => mirrorPath('.kimi-code', 'session_index.jsonl');
const relativeSession = (): string[] => SESSION.sessionDir.slice('/home/dev/'.length).split('/');
const mirroredWire = (): string => mirrorPath(...relativeSession(), 'agents', 'main', 'wire.jsonl');

function arrive(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const filesFor = (place: SshCliPlace): readonly string[] => adapter.remoteTranscriptFiles({ agentSessionId: SESSION.sessionId, cliTarget: toStoredCliTarget(place)! });

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-transcript-'));
  shellFolder = path.join(scratch, 'shell');
  mirror = path.join(scratch, 'mirror');
  fs.mkdirSync(shellFolder, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the files a Kimi session on a host names', () => {
  it('names the index from the start, in the mirror, with the folder the CLI sees', () => {
    const place = placeAt();

    const index = adapter.remoteTranscriptIndex({ cwd: shellFolder, cliTarget: toStoredCliTarget(place)! });

    expect(index?.path).toBe(mirroredIndex());
    expect(index?.folder).toBe(SESSION.workDir);
  });

  it('names no wire before the index says where it is', () => {
    expect(filesFor(placeAt())).toEqual([]);
  });

  it('names the wire from the mirrored index while the wire itself has not arrived', () => {
    arrive(mirroredIndex(), indexFixture);

    expect(filesFor(placeAt())).toEqual([mirroredWire()]);
    expect(fs.existsSync(mirroredWire())).toBe(false);
  });

  it('keeps the wire in the mirror when the project is the host\'s home itself', () => {
    arrive(mirroredIndex(), indexFixture);

    expect(filesFor(placeAt('/home/dev'))).toEqual([mirroredWire()]);
  });

  it('declares nothing for a Kimi that does not run on a host', () => {
    const wsl = { kind: 'wsl', distro: 'Ubuntu' } as const;

    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION.sessionId, cliTarget: wsl })).toEqual([]);
    expect(adapter.remoteTranscriptIndex({ cwd: shellFolder, cliTarget: wsl })).toBeNull();
  });
});

describe('finding a fresh session in new lines of the index', () => {
  const sessionIdsIn = (text: string, folder = SESSION.workDir): readonly string[] => {
    const place = placeAt(folder);
    return adapter.remoteTranscriptIndex({ cwd: shellFolder, cliTarget: toStoredCliTarget(place)! })?.sessionIdsIn(text) ?? [];
  };

  it('finds only the session in this folder, in a real index', () => {
    expect(sessionIdsIn(indexFixture)).toEqual([SESSION.sessionId]);
    expect(sessionIdsIn(indexFixture, OTHER_SESSION.workDir)).toEqual([OTHER_SESSION.sessionId]);
  });

  it('skips a torn last line, so a chunk ending inside a line names nothing yet', () => {
    expect(sessionIdsIn(indexFixture.slice(0, -40).split('\n').slice(1).join('\n'))).toEqual([]);
  });

  it('leaves out a session a later line deleted', () => {
    const deleted = `${JSON.stringify({ sessionId: SESSION.sessionId, deleted: true })}\n`;

    expect(sessionIdsIn(indexFixture + deleted)).toEqual([]);
  });
});

describe('the conversation viewer, through its cache', () => {
  it('shows the conversation once it arrives, after an open that found none', async () => {
    const read = () => getCachedTranscript('kimi', SESSION.sessionId, () => adapter.parseTranscript(SESSION.sessionId, shellFolder, placeAt()));
    await expect(read()).resolves.toMatchObject({ entries: [], sourcePath: null });

    arrive(mirroredIndex(), indexFixture);
    arrive(mirroredWire(), wireFixture);

    expect(JSON.stringify((await read()).entries)).toContain('Stub reply from the probe model.');
  });
});

describe('a real conversation arrived in the mirror', () => {
  beforeEach(() => {
    arrive(mirroredIndex(), indexFixture);
    arrive(mirroredWire(), wireFixture);
  });

  it('is found by the reader that opens a local one', async () => {
    await expect(adapter.locateSessionHistoryFile(SESSION.sessionId, shellFolder, placeAt())).resolves.toBe(mirroredWire());
  });

  it('shows the user\'s prompt, the tool it ran and the answer, for the viewer and the search index', async () => {
    const place = placeAt();

    const parsed = await adapter.parseTranscript(SESSION.sessionId, shellFolder, place);
    const text = JSON.stringify(parsed.entries);

    expect(text).toContain('say hello');
    expect(text).toContain('echo probe-tool-output');
    expect(text).toContain('Stub reply from the probe model.');
  });

  it('walks in windows, as the index does', async () => {
    const window = await adapter.parseTranscriptWindow(SESSION.sessionId, shellFolder, 0, 1024 * 1024, new Set<string>(), placeAt());

    expect(window.sourcePath).toBe(mirroredWire());
    expect(window.entries.length).toBeGreaterThan(0);
  });

  it('feeds the token ledger', async () => {
    const usage = await adapter.transcriptUsage({ agentSessionId: SESSION.sessionId, place: placeAt() } as never);

    // The capture holds a turn with a tool call and a resumed turn: three model calls at 1,234 in and 56 out.
    expect(usage).toEqual({ inputTokens: 3702, outputTokens: 168 });
  });

  it('counts the tool call', async () => {
    const counts = await adapter.transcriptToolCounts({ agentSessionId: SESSION.sessionId, place: placeAt() } as never);

    expect(counts?.toolCallCount).toBe(1);
  });
});
