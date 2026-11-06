/**
 * The conversation files of Codex, Gemini, Copilot, Aider and Droid on a host reaching this computer (#913).
 * None of the five can use the plain case: Codex and Gemini put a timestamp in the name, so the host searches
 * for the file; Copilot and Aider keep it in the session or working folder, outside the host's home; and Droid
 * has an id only because its hooks file now goes to the host.
 *
 * What a user loses if it breaks: a session on a host whose viewer, search index or token ledger stays empty for
 * good, a copy landing where the agent's own readers never look, a locator that reads a copy as absent, or a
 * host-supplied id that climbs out of the folder its copy belongs in.
 *
 * The expected host paths are written out from each CLI's own layout (not computed from the code under test),
 * so a wrong slug fails here instead of being copied. The conversations are real captures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';
import { CodexAdapter } from '../../src/main/agent/adapters/codex';
import { CopilotAdapter } from '../../src/main/agent/adapters/copilot/copilot-adapter';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';
import { mirrorPathToHost, rootPathToHost, toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { FileTail, type FileChunkEvent } from '../../src/main/remote/helper/file-tail';
import { remoteTranscriptSource } from '../../src/main/remote/remote-session-relay';
import type { RemoteTranscriptSearch } from '../../src/shared/types';

const SESSION_ID = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
const SHORT_ID = '3f2a9c1e';
const HOST_PROJECT = '/home/dev/api';
const FIXTURES = path.join(__dirname, '..', 'fixtures');

let scratch: string;
let shellFolder: string;
let mirror: string;

function placeAt(): SshCliPlace {
  return { kind: 'ssh', hostId: 'host-a', home: '/home/dev', shellName: 'bash', localHome: mirror, roots: [{ local: shellFolder, host: HOST_PROJECT }] };
}

const stored = () => toStoredCliTarget(placeAt())!;
const standInFolder = (): string => path.join(shellFolder, '.kangentic', 'worktrees', '7');
const sessionFolder = (record = 'record-1'): string => path.join(shellFolder, '.kangentic', 'sessions', record);

function arrive(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const fixture = (...segments: string[]): string => fs.readFileSync(path.join(FIXTURES, ...segments), 'utf8');

/** The one search an adapter declared. */
function onlySearch(files: readonly unknown[]): RemoteTranscriptSearch {
  expect(files).toHaveLength(1);
  return files[0] as RemoteTranscriptSearch;
}

async function expectNoWait(find: () => Promise<string | null>, expected: string | null): Promise<void> {
  const startedAt = Date.now();
  await expect(find()).resolves.toBe(expected);
  expect(Date.now() - startedAt).toBeLessThan(5000);
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-agents-'));
  shellFolder = path.join(scratch, 'shell');
  mirror = path.join(scratch, 'mirror');
  fs.mkdirSync(shellFolder, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('Codex', () => {
  const adapter = new CodexAdapter();
  const declared = (agentSessionId = SESSION_ID): RemoteTranscriptSearch => onlySearch(adapter.remoteTranscriptFiles({ agentSessionId, cliTarget: stored() }));

  it('searches the whole sessions tree on the host, because a resume stays in the folder of the day it began', () => {
    const search = declared();

    expect(mirrorPathToHost(search.directory, placeAt())).toBe('/home/dev/.codex/sessions');
    expect(search.depth).toBe(3);
  });

  it('matches the file Codex writes, and not another session\'s or a compressed one', () => {
    const pattern = new RegExp(declared().fileName);

    expect(pattern.test(`rollout-2026-11-06T09-14-22-${SESSION_ID}.jsonl`)).toBe(true);
    expect(pattern.test('rollout-2026-11-06T09-14-22-aaaaaaaa-7b64-4d2a-9c11-0a1b2c3d4e5f.jsonl')).toBe(false);
    expect(pattern.test(`rollout-2026-11-06T09-14-22-${SESSION_ID}.jsonl.zst`)).toBe(false);
  });

  it('keeps one copy for a conversation, so a resume on a later day does not start a second', () => {
    expect(declared().localPath).toBe(declared().localPath);
    expect(path.relative(mirror, declared().localPath).startsWith('..')).toBe(false);
  });

  it('is named when the id arrives after the start, and declares nothing for a Codex not on a host', () => {
    const source = remoteTranscriptSource(adapter, shellFolder, stored(), sessionFolder());

    expect(onlySearch(source.files(SESSION_ID))).toEqual(declared());
    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } })).toEqual([]);
  });

  it('refuses an id that is no plain name: it comes from a hook on the host and would become a path here', () => {
    expect(adapter.remoteTranscriptFiles({ agentSessionId: '../../../evil', cliTarget: stored() })).toEqual([]);
  });

  it('shows a real conversation and its tokens once the copy has arrived, to the readers that open a local one', async () => {
    const place = placeAt();
    await expectNoWait(() => adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place), null);

    arrive(declared().localPath, `${fixture('codex-real-rollout.jsonl')}${fixture('codex-0.163.0-rollout-shape.jsonl')}`);

    await expectNoWait(() => adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place), declared().localPath);
    const parsed = await adapter.parseTranscript(SESSION_ID, shellFolder, place);
    expect(parsed.sourcePath).toBe(declared().localPath);
    expect(parsed.entries.length).toBeGreaterThan(0);
    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_ID, place })).resolves.not.toBeNull();
  });
});

describe('Gemini', () => {
  const adapter = new GeminiAdapter();
  const declared = (cwd = shellFolder): RemoteTranscriptSearch => onlySearch(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd, cliTarget: stored() }));

  it('searches every project folder under tmp, because the folder is the CLI\'s slug and the cwd only predicts it', () => {
    expect(mirrorPathToHost(declared(standInFolder()).directory, placeAt())).toBe('/home/dev/.gemini/tmp');
  });

  it('is found by the real tail under a slug that is not the folder\'s name, and not in a subagent\'s folder', async () => {
    // A worktree's folder is a number, so another project's worktree 7 took the slug and this one is `7-1`.
    const search = declared(standInFolder());
    const hostTmp = path.join(scratch, 'host-gemini-tmp');
    const chat = path.join(hostTmp, '7-1', 'chats', `session-2026-11-06T09-14-${SHORT_ID}.jsonl`);
    arrive(path.join(hostTmp, '7', 'chats', 'session-2026-11-06T09-14-aaaaaaaa.jsonl'), 'another project\n');
    arrive(path.join(hostTmp, '7-1', 'chats', SESSION_ID, 'nested', `session-2026-11-06T09-14-${SHORT_ID}.jsonl`), 'a subagent\n');
    arrive(chat, 'this session\n');
    const chunks: FileChunkEvent[] = [];
    const tail = new FileTail({ emit: (event) => chunks.push(event), intervalMs: 10 });

    tail.watch('s1', [], [{ key: 'chat', directory: hostTmp, depth: search.depth, fileName: search.fileName }]);
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    tail.dispose();

    expect(Buffer.from(chunks[0].data, 'base64').toString('utf8')).toBe('this session\n');
  });

  it('matches the chat Gemini writes, and refuses the legacy file it rewrites whole in place', () => {
    const pattern = new RegExp(declared().fileName);

    expect(pattern.test(`session-2026-11-06T09-14-${SHORT_ID}.jsonl`)).toBe(true);
    expect(pattern.test(`session-2026-11-06T09-14-1-${SHORT_ID}.jsonl`)).toBe(true);
    expect(pattern.test(`session-2026-11-06T09-14-${SHORT_ID}.json`)).toBe(false);
    expect(pattern.test(`session-2026-11-06T09-14-${SHORT_ID}.jsonl.unreadable-1762420000000`)).toBe(false);
  });

  it('puts the copy where the readers look for the session\'s folder, whatever slug the host chose', async () => {
    const place = placeAt();
    const cwd = standInFolder();
    await expectNoWait(() => adapter.locateSessionHistoryFile(SESSION_ID, cwd, place), null);

    arrive(declared(cwd).localPath, fixture('gemini-real-session.jsonl'));

    await expectNoWait(() => adapter.locateSessionHistoryFile(SESSION_ID, cwd, place), declared(cwd).localPath);
    const parsed = await adapter.parseTranscript(SESSION_ID, cwd, place);
    expect(parsed.sourcePath).toBe(declared(cwd).localPath);
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it('reads the ledger from the copy when the path the CLI reported names no file here', async () => {
    const place = placeAt();
    arrive(declared().localPath, fixture('gemini-real-session.jsonl'));
    const reported = `/home/dev/.gemini/tmp/api-1/chats/session-2026-11-06T09-14-${SHORT_ID}.jsonl`;

    await expect(adapter.transcriptUsage({ transcriptPath: reported, agentSessionId: SESSION_ID, cwd: shellFolder, place })).resolves.not.toBeNull();
  });

  it('declares nothing for a Gemini not on a host, and refuses an id that is no plain name', () => {
    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } })).toEqual([]);
    expect(adapter.remoteTranscriptFiles({ agentSessionId: '../evil', cwd: shellFolder, cliTarget: stored() })).toEqual([]);
  });

  it('leaves the live telemetry reader off for a host, which would poll for 30 s', async () => {
    const reader = adapter.runtime.sessionHistory;
    const startedAt = Date.now();

    await expect(reader?.locate({ agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: stored() })).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

describe('Copilot', () => {
  const adapter = new CopilotAdapter();
  const declared = (record = 'record-1'): string => adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cliTarget: stored(), sessionDirectory: sessionFolder(record) })[0];

  it('names the event log in the session\'s own config home, the same place on both computers', () => {
    expect(rootPathToHost(declared(), placeAt())).toBe(`${HOST_PROJECT}/.kangentic/sessions/record-1/copilot-config/session-state/${SESSION_ID}/events.jsonl`);
    expect(mirrorPathToHost(declared(), placeAt())).toBeNull();
  });

  it('declares nothing for a Copilot not on a host, and refuses an id that names no folder', () => {
    const local = { agentSessionId: SESSION_ID, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } as const, sessionDirectory: sessionFolder() };

    expect(adapter.remoteTranscriptFiles(local)).toEqual([]);
    expect(adapter.remoteTranscriptFiles({ ...local, cliTarget: stored(), agentSessionId: '../evil' })).toEqual([]);
  });

  it('shows a real event log and its tool calls once the copy has arrived, from a task\'s worktree too', async () => {
    const place = placeAt();
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, standInFolder(), place)).resolves.toBeNull();

    arrive(declared(), fixture('copilot-events', 'copilot-1.0.88-tool-success-events.jsonl'));

    await expect(adapter.locateSessionHistoryFile(SESSION_ID, standInFolder(), place)).resolves.toBe(declared());
    const parsed = await adapter.parseTranscript(SESSION_ID, standInFolder(), place);
    expect(parsed.sourcePath).toBe(declared());
    expect(parsed.entries.length).toBeGreaterThan(0);
    await expect(adapter.transcriptToolCounts({ agentSessionId: SESSION_ID, cwd: standInFolder(), place })).resolves.not.toBeNull();
  });

  describe('the folder a resume needs', () => {
    const seedFor = (record: string) => adapter.remoteResumeSeed({ agentSessionId: SESSION_ID, cliTarget: stored(), sessionDirectory: sessionFolder(record) });

    it('is the earlier record\'s, read from its copy, and the target is the new config home', () => {
      arrive(declared('record-1'), 'one line\n');

      expect(seedFor('record-2')).toEqual({
        source: path.dirname(declared('record-1')),
        target: path.dirname(declared('record-2')),
      });
    });

    it('takes the newest record, so a second resume carries what the first added', () => {
      arrive(declared('record-1'), 'older\n');
      arrive(declared('record-2'), 'newer\n');
      fs.utimesSync(declared('record-1'), new Date(1_000_000), new Date(1_000_000));

      expect(seedFor('record-3')?.source).toBe(path.dirname(declared('record-2')));
    });

    it('is nothing for a new conversation, which no record holds', () => {
      expect(seedFor('record-1')).toBeNull();
    });

    it('never names the session\'s own folder as its source', () => {
      arrive(declared('record-1'), 'one line\n');

      expect(seedFor('record-1')).toBeNull();
    });

    it('is nothing for a Copilot not on a host, which seeds on this computer', () => {
      expect(adapter.remoteResumeSeed({ agentSessionId: SESSION_ID, cliTarget: { kind: 'wsl', distro: 'Ubuntu' }, sessionDirectory: sessionFolder() })).toBeNull();
    });
  });
});

describe('Aider', () => {
  const adapter = new AiderAdapter();
  const declared = (cwd = shellFolder): string => adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd, cliTarget: stored() })[0];

  it('names the history in the working folder, on the host and in its stand-in here', () => {
    expect(rootPathToHost(declared(), placeAt())).toBe(`${HOST_PROJECT}/.aider.chat.history.${SESSION_ID}.md`);
    expect(rootPathToHost(declared(standInFolder()), placeAt())).toBe(`${HOST_PROJECT}/.kangentic/worktrees/7/.aider.chat.history.${SESSION_ID}.md`);
  });

  it('declares nothing for an Aider not on a host', () => {
    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } })).toEqual([]);
  });

  it('shows a real conversation and its tokens once the copy has arrived', async () => {
    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder)).resolves.toBeNull();

    arrive(declared(), fixture('aider-chat-history-session.md'));

    await expect(adapter.locateSessionHistoryFile(SESSION_ID, shellFolder)).resolves.toBe(declared());
    expect((await adapter.parseTranscript(SESSION_ID, shellFolder)).entries.length).toBeGreaterThan(0);
    await expect(adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd: shellFolder })).resolves.not.toBeNull();
  });
});

describe('Droid', () => {
  const adapter = new DroidAdapter();
  const declared = (cwd = shellFolder): string => adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd, cliTarget: stored() })[0];

  it('names the conversation\'s JSONL in the mirror, filed under the slug of the folder on the HOST', () => {
    expect(mirrorPathToHost(declared(), placeAt())).toBe(`/home/dev/.factory/sessions/-home-dev-api/${SESSION_ID}.jsonl`);
    expect(mirrorPathToHost(declared(standInFolder()), placeAt())).toBe(`/home/dev/.factory/sessions/-home-dev-api-.kangentic-worktrees-7/${SESSION_ID}.jsonl`);
  });

  it('declares nothing for a Droid not on a host, and refuses an id that is no plain name', () => {
    expect(adapter.remoteTranscriptFiles({ agentSessionId: SESSION_ID, cwd: shellFolder, cliTarget: { kind: 'wsl', distro: 'Ubuntu' } })).toEqual([]);
    expect(adapter.remoteTranscriptFiles({ agentSessionId: '../evil', cwd: shellFolder, cliTarget: stored() })).toEqual([]);
  });

  it('shows a real conversation once the copy has arrived, and a locator that looks once and never waits', async () => {
    const place = placeAt();
    await expectNoWait(() => adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place), null);

    arrive(declared(), fixture('droid-real-session.jsonl'));

    await expectNoWait(() => adapter.locateSessionHistoryFile(SESSION_ID, shellFolder, place), declared());
    expect((await adapter.parseTranscript(SESSION_ID, shellFolder, place)).entries.length).toBeGreaterThan(0);
  });
});
