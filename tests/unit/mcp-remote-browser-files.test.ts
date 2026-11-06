/**
 * Files that cross between the Browser pane, on this computer, and an agent on a host. `saveToFile` used to write a
 * Windows path and tell the host agent to read it back, and `browser_drop_files` read this computer's disk for a
 * path the agent meant on the host. The bytes go through the real transfer, against a fake host that speaks its lines.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliverCapture,
  deliverLocally,
  fetchFilesFromHost,
  saveScreenshotToFile,
  writeBrowserCaptureFile,
} from '../../src/main/agent/mcp-http/browser-capture-file';
import { screenshotToolResult } from '../../src/main/agent/mcp-http/tool-result';
import type { InlineScreenshotResponse } from '../../src/main/browser/cdp/screenshot';
import { setRemoteProjectLookup } from '../../src/main/remote/host-paths';
import { setHostAccessLookup, type HostAccess } from '../../src/main/remote/host-transfer';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

const HOST_PROJECT = '/home/dev/proj';

let scratch: string;
let shell: string;
let captures: string;
let hostFiles: Map<string, Buffer>;
let removed: string[];
let linkDown: boolean;

function answer(stdout: string): HostCommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

async function fakeHost(request: HostCommandRequest): Promise<HostCommandResult> {
  if (linkDown) throw new Error('the link is down');
  const args = request.args.slice(3);
  if (request.stdin !== undefined || args[2] === 'finish' || args[2] === 'abort') {
    const [hostPath, , step] = args;
    if (step === 'first') hostFiles.set(hostPath, Buffer.from(request.stdin ?? '', 'base64'));
    if (step === 'more') hostFiles.set(hostPath, Buffer.concat([hostFiles.get(hostPath) as Buffer, Buffer.from(request.stdin ?? '', 'base64')]));
    return answer('KG:ok\n');
  }
  const [hostPath, offset, length] = args;
  const file = hostFiles.get(hostPath);
  if (!file) return answer('KG:missing\n');
  return answer(`KG:size:${file.length}\nKG:out:${file.subarray(Number(offset), Number(offset) + Number(length)).toString('base64')}\n`);
}

const access: HostAccess = {
  hostId: 'host-1',
  runCommand: fakeHost,
  pathPresence: vi.fn(),
  removeFiles: async (paths) => { removed.push(...paths); return { removed: paths.length }; },
  listeningPorts: vi.fn(),
};

const shot: InlineScreenshotResponse = {
  mode: 'inline',
  base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]).toString('base64'),
  format: 'png',
  byteLength: 6,
  width: 10,
  height: 10,
} as unknown as InlineScreenshotResponse;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-browser-'));
  shell = path.join(scratch, 'shell');
  captures = path.join(shell, '.kangentic', 'worktrees', '12', '.kangentic', 'captures', 'session-1');
  hostFiles = new Map();
  removed = [];
  linkDown = false;
  setRemoteProjectLookup((projectPath) => (projectPath === shell ? { hostId: 'host-1', path: HOST_PROJECT } : null));
  setHostAccessLookup(() => access);
});

afterEach(() => {
  setRemoteProjectLookup(null);
  setHostAccessLookup(null);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const toHost = (saved: Parameters<typeof deliverLocally>[0]) => deliverCapture(saved, shell);

describe('saveToFile on a remote project', () => {
  it('puts a screenshot on the host, and returns the path the agent can open', async () => {
    const saved = await saveScreenshotToFile(captures, 'screenshot', shot, toHost);

    expect(saved.filePath.startsWith(`${HOST_PROJECT}/.kangentic/worktrees/12/.kangentic/captures/session-1/screenshot-`)).toBe(true);
    expect(hostFiles.get(saved.filePath)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
    expect(saved.location).toBe('host');
    expect(saved.localFilePath?.startsWith(captures)).toBe(true);
    expect(saved.fileUri.startsWith(`file://${HOST_PROJECT}/`)).toBe(true);
  });

  it('tells the agent the host path to read, in the text and the link', async () => {
    const saved = await saveScreenshotToFile(captures, 'screenshot', shot, toHost);

    const result = screenshotToolResult({ ok: true, data: saved });

    expect(JSON.stringify(result.content)).toContain(saved.filePath);
    expect(result.structuredContent).toMatchObject({ filePath: saved.filePath, location: 'host', localFilePath: saved.localFilePath });
    const link = result.content[0] as { type: string; uri: string; description: string };
    expect(link.uri).toBe(saved.fileUri);
    expect(link.description).toContain(saved.filePath);
  });

  it('carries a capture past one frame whole', async () => {
    const large = Buffer.alloc(500 * 1024, 7);

    const delivered = await toHost(await writeBrowserCaptureFile(captures, 'dom', 'html', large));

    expect(hostFiles.get(delivered.filePath)?.equals(large)).toBe(true);
  });

  it('fails the save when the file cannot reach the host, and never names a path the agent cannot open', async () => {
    linkDown = true;

    await expect(saveScreenshotToFile(captures, 'screenshot', shot, toHost)).rejects.toThrow('the link is down');
  });

  it('prunes the host\'s folder with this one', async () => {
    fs.mkdirSync(captures, { recursive: true });
    const old = path.join(captures, 'screenshot-old.png');
    fs.writeFileSync(old, 'x');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);

    await toHost(await writeBrowserCaptureFile(captures, 'screenshot', 'png', Buffer.from([1])));

    expect(removed).toEqual([`${HOST_PROJECT}/.kangentic/worktrees/12/.kangentic/captures/session-1/screenshot-old.png`]);
  });

  it('leaves a capture here for a project on this computer, with nothing asked of a host', async () => {
    setHostAccessLookup(() => { throw new Error('asked'); });
    const local = path.join(scratch, 'local-project');
    const saved = await writeBrowserCaptureFile(path.join(local, '.kangentic', 'captures'), 'eval', 'txt', 'value');

    const delivered = await deliverCapture(saved, local);

    expect(delivered).toEqual({ filePath: saved.filePath, fileUri: saved.fileUri, bytes: saved.bytes, location: 'local' });
  });
});

describe('browser_drop_files on a remote project', () => {
  it('brings each file to this computer, under its own name, so the pane can drop it', async () => {
    hostFiles.set('/home/dev/proj/a.png', Buffer.from([1, 2, 3]));
    hostFiles.set('/home/dev/proj/sub/a.png', Buffer.from([4]));

    const fetched = await fetchFilesFromHost(['/home/dev/proj/a.png', '/home/dev/proj/sub/a.png'], captures, shell);

    expect(fetched?.failures).toEqual([]);
    expect(fetched?.localPaths.map((localPath) => path.basename(localPath))).toEqual(['a.png', 'a.png']);
    expect(fs.readFileSync((fetched as { localPaths: string[] }).localPaths[0])).toEqual(Buffer.from([1, 2, 3]));
    expect(fs.readFileSync((fetched as { localPaths: string[] }).localPaths[1])).toEqual(Buffer.from([4]));
  });

  it('names what could not be fetched', async () => {
    const fetched = await fetchFilesFromHost(['/home/dev/proj/gone.png'], captures, shell);

    expect(fetched?.failures[0]).toContain('/home/dev/proj/gone.png: no such file on the host');
  });

  it('never reads this computer\'s disk for a project on a host', async () => {
    const twin = path.join(scratch, 'twin.png');
    fs.writeFileSync(twin, 'local');

    const fetched = await fetchFilesFromHost([twin], captures, shell);

    expect(fetched?.localPaths).toEqual([]);
    expect(fetched?.failures).toHaveLength(1);
  });

  it('asks nothing for a project on this computer', async () => {
    expect(await fetchFilesFromHost(['/any/file.png'], captures, path.join(scratch, 'local-project'))).toBeNull();
  });
});
