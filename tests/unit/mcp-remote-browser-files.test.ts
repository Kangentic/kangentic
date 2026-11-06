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
  droppedFileName,
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
/** Files the fake host reports as past the read script's cap, by the size it names. */
let reportedSizes: Map<string, number>;

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
  const reportedSize = reportedSizes.get(hostPath);
  if (reportedSize !== undefined) return answer(`KG:size:${reportedSize}\nKG:toobig\n`);
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
  reportedSizes = new Map();
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

  it('refuses a file past the drop cap, naming the cap', async () => {
    hostFiles.set('/home/dev/proj/huge.bin', Buffer.from([1]));
    reportedSizes.set('/home/dev/proj/huge.bin', 60 * 1024 * 1024);

    const fetched = await fetchFilesFromHost(['/home/dev/proj/huge.bin'], captures, shell);

    expect(fetched?.localPaths).toEqual([]);
    expect(fetched?.failures).toHaveLength(1);
    expect(fetched?.failures[0]).toContain('past the 50MB');
  });

  it('lands a host name that holds a backslash directly inside its own drop folder', async () => {
    const hostPath = '/home/dev/proj/a\\..\\..\\evil.png';
    hostFiles.set(hostPath, Buffer.from([9, 8, 7]));

    const fetched = await fetchFilesFromHost([hostPath], captures, shell);

    expect(fetched?.failures).toEqual([]);
    const [localPath] = (fetched as { localPaths: string[] }).localPaths;
    // drop-<id>/<index>/<one file name>, and nothing above or beside it was written.
    expect(path.relative(captures, localPath).split(path.sep)).toEqual([expect.stringMatching(/^drop-[0-9a-f]{6}$/), '0', expect.not.stringMatching(/[\\/:]/)]);
    expect(fs.readFileSync(localPath)).toEqual(Buffer.from([9, 8, 7]));
    expect(fs.readdirSync(captures)).toHaveLength(1);
    expect(fs.existsSync(path.join(scratch, 'evil.png'))).toBe(false);
  });

  it('is told the host is not available when there is no access to it', async () => {
    setHostAccessLookup(() => null);

    const fetched = await fetchFilesFromHost(['/home/dev/proj/a.png'], captures, shell);

    expect(fetched?.localPaths).toEqual([]);
    expect(fetched?.failures).toHaveLength(1);
    expect(fetched?.failures[0]).toContain('/home/dev/proj/a.png');
    expect(fetched?.failures[0]).toContain('host is not available');
  });
});

describe('a capture for a host that is not available', () => {
  it('rejects, and names why, rather than giving the agent a path that names nothing', async () => {
    setHostAccessLookup(() => null);

    await expect(saveScreenshotToFile(captures, 'screenshot', shot, toHost)).rejects.toThrow(/host is not available/);
  });
});

describe('the prune of dropped files', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function folderAged(name: string, ageMs: number): string {
    const folder = path.join(captures, name);
    fs.mkdirSync(path.join(folder, '0'), { recursive: true });
    fs.writeFileSync(path.join(folder, '0', 'kept.png'), 'x');
    const when = new Date(Date.now() - ageMs);
    // Set last: writing into the folder above would move its mtime.
    fs.utimesSync(folder, when, when);
    return folder;
  }

  it('removes a drop folder over a day old on the next fetch, and keeps a fresh one and a folder that is no drop', async () => {
    const old = folderAged('drop-aaaaaa', 2 * DAY_MS);
    const fresh = folderAged('drop-bbbbbb', 60 * 1000);
    const notADrop = folderAged('screenshots-old', 2 * DAY_MS);
    hostFiles.set('/home/dev/proj/a.png', Buffer.from([1]));

    const fetched = await fetchFilesFromHost(['/home/dev/proj/a.png'], captures, shell);

    expect(fetched?.failures).toEqual([]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(notADrop)).toBe(true);
  });
});

describe('droppedFileName', () => {
  const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

  it.each([
    '/h/a\\..\\..\\evil.bat',
    '/h/a:b.png',
    '/h/..',
    '/h/.',
    '/h/',
    '/h/name. ',
    '/h/CON',
    '/h/nul.txt',
    '/h/com1',
    '/h/a\u0001b\u007f.txt',
    '/h/My file (1).png',
  ])('makes %j one safe name that stays inside a Windows folder', (hostPath) => {
    const name = droppedFileName(hostPath);

    expect(name).not.toMatch(/[\\/:]/);
    expect(name).not.toBe('');
    expect(name).not.toMatch(/[. ]$/);
    expect(name).not.toMatch(WINDOWS_DEVICE);
    const folder = 'C:\\d\\0';
    const joined = path.win32.join(folder, name);
    expect(path.win32.dirname(joined)).toBe(folder);
  });

  it('gives a name nothing could be made of the placeholder `file`', () => {
    for (const hostPath of ['/h/..', '/h/.', '/h/', '/h/. . ']) expect(droppedFileName(hostPath)).toBe('file');
  });

  it('leaves the characters that do no harm, and cuts what only decorates the end', () => {
    expect(droppedFileName('/h/My file (1).png')).toBe('My file (1).png');
    expect(droppedFileName('/h/name. ')).toBe('name');
  });

  it('turns a backslash and a colon into something that is not a separator or a stream', () => {
    expect(droppedFileName('/h/a:b.png')).not.toContain(':');
    expect(droppedFileName('/h/a\\..\\..\\evil.bat').endsWith('evil.bat')).toBe(true);
  });
});
