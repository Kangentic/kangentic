/**
 * A Goose conversation on a host reaching this computer (#913, task 1004): the export the adapter names, and that
 * a copy of it reads as a local conversation does. The export is a capture of a real Goose 1.57.0 on Linux
 * (`docs/audits/ssh-transcript-exports-audit.md`), with the prompt text and extension lists trimmed.
 *
 * What a user loses if it breaks: a Goose session on a host with an empty viewer, no search hits and no token
 * count, or a local Goose whose readers changed under it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GooseAdapter } from '../../src/main/agent/adapters/goose';
import { parseGooseExport } from '../../src/main/agent/adapters/goose/export-reader';
import { remoteExportPath, toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

const EXPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'goose-1.57.0-session-export.json'), 'utf8');
const SESSION_NAME = '11111111-2222-4333-8444-555555555555';

let scratch: string;
let shellFolder: string;
let place: SshCliPlace;
const adapter = new GooseAdapter();

const copyPath = (): string => remoteExportPath(place, 'goose', SESSION_NAME);

function arrive(content: string): void {
  fs.mkdirSync(path.dirname(copyPath()), { recursive: true });
  fs.writeFileSync(copyPath(), content);
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-goose-transcript-'));
  shellFolder = path.join(scratch, 'shell');
  fs.mkdirSync(shellFolder, { recursive: true });
  place = { kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome: path.join(scratch, 'mirror'), roots: [{ local: shellFolder, host: '/home/dev/project' }], linuxCliPath: 'goose' };
});

afterEach(() => {
  setParseWindowBytesForTests();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the export a Goose session on a host names', () => {
  it('asks Goose for this session by the name Kangentic gave it, in the folder it ran in', async () => {
    await expect(adapter.remoteTranscriptSnapshot({ agentSessionId: SESSION_NAME, cwd: shellFolder, cliTarget: toStoredCliTarget(place)! })).resolves.toEqual({
      file: 'goose',
      args: ['session', 'export', '--name', SESSION_NAME, '--format', 'json'],
      cwd: '/home/dev/project',
      localPath: copyPath(),
    });
  });

  // The name goes on a command line and into a file name in the mirror: a path climbing out of it, or an option, is no name.
  it.each(['../../x', '--help', '-n', '; rm -rf ~', ''])('names nothing for %j, which is no plain session name', async (agentSessionId) => {
    await expect(adapter.remoteTranscriptSnapshot({ agentSessionId, cwd: shellFolder, cliTarget: toStoredCliTarget(place)! })).resolves.toBeNull();
  });

  it('names nothing for a Goose that does not run on a host', async () => {
    await expect(adapter.remoteTranscriptSnapshot({ agentSessionId: SESSION_NAME, cwd: shellFolder, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } })).resolves.toBeNull();
  });
});

describe('a real Goose export', () => {
  it('becomes the rows the database reader takes, in order', () => {
    const exported = parseGooseExport(EXPORT);

    expect(exported?.model).toBe('stub-model');
    expect(exported?.rows.map((row) => row.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant', 'user', 'user', 'assistant']);
    expect(exported?.rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(exported?.rows[0].created_timestamp).toBeGreaterThan(1_000_000_000);
  });

  it('reads nothing into what is not an export', () => {
    expect(parseGooseExport('not json')).toBeNull();
    expect(parseGooseExport('{"id":"20261105_1"}')).toBeNull();
    expect(parseGooseExport('[]')).toBeNull();
  });
});

describe('a real Goose export arrived in the mirror', () => {
  beforeEach(() => arrive(EXPORT));

  it('is found, so the staleness check has a file of the conversation\'s own', async () => {
    await expect(adapter.locateSessionHistoryFile(SESSION_NAME, shellFolder, place)).resolves.toBe(copyPath());
  });

  it('shows the prompts, the tool it ran and the answers, and not what Goose keeps from the user', async () => {
    const parsed = await adapter.parseTranscript(SESSION_NAME, shellFolder, place);
    const text = JSON.stringify(parsed.entries);

    expect(parsed.sourcePath).toBe(copyPath());
    expect(text).toContain('say hello');
    expect(text).toContain('again');
    expect(text).toContain('echo probe-tool-output');
    expect(text).toContain('probe-tool-output');
    expect(text).toContain('Stub reply from the probe model.');
    expect(text).not.toContain('turn-context');
    const assistant = parsed.entries.find((entry) => entry.kind === 'assistant');
    expect(assistant).toMatchObject({ model: 'stub-model' });
  });

  it('feeds the token ledger from the lifetime totals, across a resume', async () => {
    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_NAME, place })).resolves.toEqual({ inputTokens: 3702, outputTokens: 168 });
  });

  it('counts the tool call and its result', async () => {
    const counts = await adapter.transcriptToolCounts({ agentSessionId: SESSION_NAME, place });
    const tokens = await adapter.transcriptToolResultTokens({ agentSessionId: SESSION_NAME, place });

    expect(counts).toMatchObject({ toolCallCount: 1, toolBreakdown: [{ toolName: 'shell', callCount: 1 }] });
    expect(tokens?.shell).toBeGreaterThan(0);
  });

  it('keeps tool reads to the run they are asked about', async () => {
    await expect(adapter.transcriptToolCounts({ agentSessionId: SESSION_NAME, place, sinceMs: Number.MAX_SAFE_INTEGER })).resolves.toBeNull();
  });

  it('bounds a long conversation to its newest entries, behind the notice', async () => {
    setParseWindowBytesForTests(400);

    const parsed = await adapter.parseTranscript(SESSION_NAME, shellFolder, place);

    expect(parsed.entries[0].kind).toBe('system');
    expect(JSON.stringify(parsed.entries)).not.toContain('say hello');
    expect(JSON.stringify(parsed.entries.at(-1))).toContain('Stub reply from the probe model.');
  });

  it('falls back to the latest turn\'s tokens when the export has no totals, as the database reader does', async () => {
    const document = JSON.parse(EXPORT) as Record<string, unknown>;
    delete document.accumulated_usage;
    arrive(JSON.stringify(document));

    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_NAME, place })).resolves.toEqual({ inputTokens: 1234, outputTokens: 56 });
  });
});

describe('a session on a host with no copy here yet', () => {
  it('reads as nothing yet, and nothing throws', async () => {
    await expect(adapter.locateSessionHistoryFile(SESSION_NAME, shellFolder, place)).resolves.toBeNull();
    await expect(adapter.parseTranscript(SESSION_NAME, shellFolder, place)).resolves.toEqual({ entries: [], sourcePath: null });
    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_NAME, place })).resolves.toBeNull();
    await expect(adapter.transcriptToolCounts({ agentSessionId: SESSION_NAME, place })).resolves.toBeNull();
    await expect(adapter.transcriptToolResultTokens({ agentSessionId: SESSION_NAME, place })).resolves.toBeNull();
  });
});

describe('a Goose that is not on a host', () => {
  it('still has no file of its own, since its database is shared', async () => {
    await expect(adapter.locateSessionHistoryFile(SESSION_NAME, shellFolder)).resolves.toBeNull();
  });
});
