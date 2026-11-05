/**
 * An OpenCode conversation on a host reaching this computer (#913, task 1004): the export the adapter names, and
 * that a copy of it reads as a local conversation does, for both majors. The exports are captures of real
 * OpenCode 1.19.5 and 2.2.5 runs on Linux (`docs/audits/ssh-transcript-exports-audit.md`).
 *
 * What a user loses if it breaks: an OpenCode session on a host with an empty viewer, no search hits and no
 * token count, or an export run with the other major's flags, which fails and copies nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';
import { forgetDistroOpenCodeVersions, isSessionId } from '../../src/main/agent/adapters/opencode/distro-sessions';
import { readTrail } from '../../src/main/agent/message-trail-read';
import { getCachedTranscript } from '../../src/main/agent/transcript-cache';
import { remoteExportPath, toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import type { RemoteProgramRunner } from '../../src/shared/types';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
const V1_EXPORT = fixture('opencode-1.19.5-export.json');
const V2_EXPORT = fixture('opencode-2.2.5-export.json');
const SESSION_ID = 'ses_e52b59ffaffeB3C231sC6dAi9T';

let scratch: string;
let shellFolder: string;
let place: SshCliPlace;
const adapter = new OpenCodeAdapter();

const copyPath = (): string => remoteExportPath(place, 'opencode', SESSION_ID);

function arrive(content: string): void {
  fs.mkdirSync(path.dirname(copyPath()), { recursive: true });
  fs.writeFileSync(copyPath(), content);
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-opencode-transcript-'));
  shellFolder = path.join(scratch, 'shell');
  fs.mkdirSync(shellFolder, { recursive: true });
  place = { kind: 'ssh', hostId: `host-${path.basename(scratch)}`, home: '/home/dev', shellName: 'bash', localHome: path.join(scratch, 'mirror'), roots: [{ local: shellFolder, host: '/home/dev/project' }], linuxCliPath: 'opencode' };
});

afterEach(() => {
  forgetDistroOpenCodeVersions();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const askingVersion = (version: string): RemoteProgramRunner => async () => ({ code: 0, stdout: `${version}\n` });

describe('the export an OpenCode session on a host names', () => {
  const named = (agentSessionId: string, runProgram: RemoteProgramRunner) => adapter.remoteTranscriptSnapshot({
    agentSessionId, cwd: shellFolder, cliTarget: toStoredCliTarget(place)!, runProgram,
  });

  it('uses OpenCode 1\'s flags on a host running 1, from the session\'s own folder', async () => {
    await expect(named(SESSION_ID, askingVersion('1.19.5'))).resolves.toEqual({
      file: 'opencode', args: ['export', SESSION_ID, '--pure'], cwd: '/home/dev/project', localPath: copyPath(),
    });
  });

  it('uses OpenCode 2\'s flags on a host running 2', async () => {
    const snapshot = await named(SESSION_ID, askingVersion('opencode v2.2.5'));

    expect(snapshot?.args).toEqual(['session', 'export', SESSION_ID, '--standalone']);
  });

  it('names nothing while the major cannot be read, and asks again next time', async () => {
    await expect(named(SESSION_ID, async () => ({ code: 127, stdout: '' }))).resolves.toBeNull();

    await expect(named(SESSION_ID, askingVersion('1.19.5'))).resolves.not.toBeNull();
  });

  it('refuses an id that is not an id, since it goes on a command line', async () => {
    await expect(named('; rm -rf ~', askingVersion('1.19.5'))).resolves.toBeNull();
    // A leading dash would be read by `opencode export` as an option, not an id.
    await expect(named('--help', askingVersion('1.19.5'))).resolves.toBeNull();
    await expect(named('../../x', askingVersion('1.19.5'))).resolves.toBeNull();
  });

  // The adapter's own path check refuses these first, so this pins the second guard the id passes on its way to a command line.
  it('does not take an id that starts with a dash as a session id', () => {
    expect(isSessionId('--help')).toBe(false);
    expect(isSessionId('-s')).toBe(false);
    expect(isSessionId('ses_1a2B-3c')).toBe(true);
  });

  it('copies into the mirror, where a mirror path maps back to the host', () => {
    expect(copyPath()).toBe(path.join(scratch, 'mirror', '.kangentic', 'transcripts', 'opencode', `${SESSION_ID}.json`));
  });
});

describe.each([
  { major: 'OpenCode 1', content: V1_EXPORT },
  { major: 'OpenCode 2', content: V2_EXPORT },
])('a real $major export arrived in the mirror', ({ content }) => {
  beforeEach(() => arrive(content));

  it('is found, so the staleness check and the archive have a file of the conversation\'s own', async () => {
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place)).resolves.toBe(copyPath());
  });

  it('shows the prompt, the tool it ran and the answer', async () => {
    const parsed = await adapter.parseTranscript(SESSION_ID, shellFolder, place);
    const text = JSON.stringify(parsed.entries);

    expect(parsed.sourcePath).toBe(copyPath());
    expect(text).toContain('say hello');
    expect(text).toContain('echo probe-tool-output');
    expect(text).toContain('Stub reply from the probe model.');
  });

  it('is one window for the search index, or the index would hold nothing', async () => {
    const window = await adapter.parseTranscriptWindow(SESSION_ID, shellFolder, 0, 1024 * 1024, new Set<string>(), place);

    expect(window.entries.length).toBeGreaterThan(0);
    expect(window.totalBytes).toBeGreaterThan(0);
    expect(window).toMatchObject({ sourcePath: copyPath(), nextByteOffset: window.totalBytes, firstByteOffset: 0, endByte: window.totalBytes });

    const next = await adapter.parseTranscriptWindow(SESSION_ID, shellFolder, window.totalBytes, 1024 * 1024, new Set<string>(), place);
    expect(next.entries).toEqual([]);
  });

  it('feeds the token ledger from the whole file', async () => {
    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_ID, place })).resolves.toEqual({ inputTokens: 2468, outputTokens: 112 });
  });

  it('counts the tool call and estimates its result', async () => {
    const counts = await adapter.transcriptToolCounts({ agentSessionId: SESSION_ID, place });

    expect(counts?.toolCallCount).toBe(1);
    expect(counts?.toolBreakdown[0]?.callCount).toBe(1);
    const tokens = await adapter.transcriptToolResultTokens({ agentSessionId: SESSION_ID, place });
    expect(Object.values(tokens ?? {})).toHaveLength(1);
    expect(Object.values(tokens ?? {})[0]).toBeGreaterThan(0);
  });

  it('keeps tool reads to the run they are asked about', async () => {
    const counts = await adapter.transcriptToolCounts({ agentSessionId: SESSION_ID, place, sinceMs: Number.MAX_SAFE_INTEGER });

    expect(counts).toBeNull();
  });
});

describe('the card\'s message trail, which reads on from where it stopped', () => {
  const facts = () => ({ sessionType: 'opencode', agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: toStoredCliTarget(place) });

  it('reads the conversation once, and nothing again from the cursor it left', async () => {
    arrive(V1_EXPORT);

    const first = await readTrail(adapter, facts(), null);
    expect(first.previews.length).toBeGreaterThan(0);

    const second = await readTrail(adapter, facts(), first.cursor);
    expect(second.previews).toEqual([]);
  });

  it('reads on past a cursor into a longer export, and only what came after it', async () => {
    arrive(V1_EXPORT);
    const first = await readTrail(adapter, facts(), null);

    const document = JSON.parse(V1_EXPORT) as { messages: Array<{ info: { id: string; time: { created: number } }; parts: Array<{ id?: string; text?: string; type: string }> }> };
    const last = document.messages[document.messages.length - 1];
    const later = JSON.parse(JSON.stringify(last)) as typeof last;
    later.info.id = 'msg_later';
    later.info.time.created += 1000;
    later.parts = later.parts.filter((part) => part.type === 'text').map((part) => ({ ...part, text: 'A later answer.' }));
    document.messages.push(later);
    arrive(JSON.stringify(document, null, 2));

    const second = await readTrail(adapter, facts(), first.cursor);
    const text = JSON.stringify(second.previews);

    expect(text).toContain('A later answer.');
    expect(text).not.toContain('Stub reply from the probe model.');
  });
});

describe('the conversation viewer, through its cache', () => {
  const read = () => getCachedTranscript('opencode', SESSION_ID, () => adapter.parseTranscript(SESSION_ID, shellFolder, place));

  it('shows the conversation once it arrives, after an open that found none, and a replaced export after that', async () => {
    await expect(read()).resolves.toMatchObject({ entries: [], sourcePath: null });

    arrive(V1_EXPORT);
    const arrived = await read();
    expect(JSON.stringify(arrived.entries)).toContain('Stub reply from the probe model.');

    const document = JSON.parse(V1_EXPORT) as { messages: Array<{ parts: Array<{ text?: string }> }> };
    document.messages.at(-1)?.parts.filter((part) => part.text).forEach((part) => { part.text = 'A newer answer than the last export held.'; });
    arrive(JSON.stringify(document));

    expect(JSON.stringify((await read()).entries)).toContain('A newer answer than the last export held.');
  });
});

describe('a session on a host with no copy here yet', () => {
  it('reads as nothing yet, and nothing throws', async () => {
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place)).resolves.toBeNull();
    await expect(adapter.parseTranscript(SESSION_ID, shellFolder, place)).resolves.toEqual({ entries: [], sourcePath: null });
    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_ID, place })).resolves.toBeNull();
    await expect(adapter.transcriptToolCounts({ agentSessionId: SESSION_ID, place })).resolves.toBeNull();
    const window = await adapter.parseTranscriptWindow(SESSION_ID, shellFolder, 0, 1024, new Set<string>(), place);
    expect(window.entries).toEqual([]);
  });

  it('reads a copy that is not an export as nothing, not as a failure', async () => {
    arrive('this is not json');

    await expect(adapter.parseTranscript(SESSION_ID, shellFolder, place)).resolves.toEqual({ entries: [], sourcePath: null });
  });
});
