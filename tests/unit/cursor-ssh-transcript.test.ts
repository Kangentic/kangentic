/**
 * A Cursor conversation on a host reaching this computer (#913): which file the adapter names,
 * and that what lands in the mirror reads as a local conversation does. The JSONL is the record
 * shape a local cursor-agent transcript showed (`tests/fixtures/cursor-agent-transcript.jsonl`).
 *
 * What a user loses if it breaks: a Cursor session on a host with an empty viewer, or a
 * transcript that never starts copying because its path was only looked for on this computer's disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CursorAdapter } from '../../src/main/agent/adapters/cursor';
import { mirrorPathToHost, toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { getCachedTranscript } from '../../src/main/agent/transcript-cache';

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cursor-agent-transcript.jsonl'), 'utf8');
const SESSION_ID = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
const HOST_PROJECT = '/home/dev/api';

let scratch: string;
let shellFolder: string;
let mirror: string;
const adapter = new CursorAdapter();

function placeAt(hostProject = HOST_PROJECT): SshCliPlace {
  return { kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome: mirror, roots: [{ local: shellFolder, host: hostProject }] };
}

const mirroredTranscript = (): string => path.join(
  mirror, '.cursor', 'projects', 'home-dev-api', 'agent-transcripts', SESSION_ID, `${SESSION_ID}.jsonl`,
);

function arrive(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const filesFor = (place: SshCliPlace): readonly string[] => adapter.remoteTranscriptFiles({
  agentSessionId: SESSION_ID,
  cwd: shellFolder,
  cliTarget: toStoredCliTarget(place)!,
});

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-cursor-transcript-'));
  shellFolder = path.join(scratch, 'shell');
  mirror = path.join(scratch, 'mirror');
  fs.mkdirSync(shellFolder, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the file a Cursor session on a host names', () => {
  it('is the one file Cursor appends to, in the mirror, filed under the slug of the folder on the HOST', () => {
    const place = placeAt();
    const files = filesFor(place);

    expect(files).toEqual([mirroredTranscript()]);
    expect(mirrorPathToHost(files[0], place)).toBe(
      `/home/dev/.cursor/projects/home-dev-api/agent-transcripts/${SESSION_ID}/${SESSION_ID}.jsonl`,
    );
  });

  it('names the file before it has arrived, so the tail can start as soon as Cursor writes it', () => {
    expect(filesFor(placeAt())).toEqual([mirroredTranscript()]);
    expect(fs.existsSync(mirroredTranscript())).toBe(false);
  });

  it('keeps the file in the mirror when the project is the host\'s home itself', () => {
    const place = placeAt('/home/dev');
    const files = filesFor(place);

    expect(files).toEqual([path.join(
      mirror, '.cursor', 'projects', 'home-dev', 'agent-transcripts', SESSION_ID, `${SESSION_ID}.jsonl`,
    )]);
    expect(mirrorPathToHost(files[0], place)).toBe(
      `/home/dev/.cursor/projects/home-dev/agent-transcripts/${SESSION_ID}/${SESSION_ID}.jsonl`,
    );
  });

  it('declares nothing for a Cursor that does not run on a host', () => {
    const wsl = { kind: 'wsl', distro: 'Ubuntu' } as const;

    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: wsl })).toEqual([]);
  });
});

describe('the conversation viewer, through its cache', () => {
  it('shows the conversation once it arrives, after an open that found none', async () => {
    const place = placeAt();
    const read = () => getCachedTranscript('cursor_agent', SESSION_ID, () => adapter.parseTranscript(SESSION_ID, shellFolder, place));
    await expect(read()).resolves.toMatchObject({ entries: [], sourcePath: null });

    arrive(mirroredTranscript(), FIXTURE);

    expect(JSON.stringify((await read()).entries)).toContain('The search found no task matching release checklist.');
  });
});

describe('a real conversation arrived in the mirror', () => {
  beforeEach(() => {
    arrive(mirroredTranscript(), FIXTURE);
  });

  it('is found by the reader that opens a local one', async () => {
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, placeAt())).resolves.toBe(mirroredTranscript());
  });

  it('shows the user\'s prompt, the tool it ran and the answer, for the viewer and the search index', async () => {
    const parsed = await adapter.parseTranscript(SESSION_ID, shellFolder, placeAt());
    const text = JSON.stringify(parsed.entries);

    expect(parsed.sourcePath).toBe(mirroredTranscript());
    expect(text).toContain('Call the kangentic_search tool once');
    expect(text).toContain('CallDynamicTool');
    expect(text).toContain('The search found no task matching release checklist.');
  });
});
