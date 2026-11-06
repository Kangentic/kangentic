/**
 * How a tool's attachments are read: a file here as it is added, one at a time, and a host's files fetched first
 * under a budget for the call. The host's reader is stubbed so a test of a 200MB limit allocates nothing.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPreparedAttachments,
  fetchHostAttachments,
  localAttachments,
  type PreparedAttachments,
} from '../../src/main/agent/commands/attachment-input';
import type { CommandContext } from '../../src/main/agent/commands/types';
import { readFileAsAttachment, type ReadFileResult } from '../../src/main/db/repositories/attachment-utils';
import { agentPathsForProject } from '../../src/main/remote/host-paths';
import { readHostBytes, type HostAccess } from '../../src/main/remote/host-transfer';

vi.mock('../../src/main/remote/host-transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/remote/host-transfer')>()),
  readHostBytes: vi.fn(),
}));

const MEGABYTE = 1024 * 1024;
const HOST_PROJECT = '/home/dev/proj';

function fileResult(filename: string): ReadFileResult {
  return { filename, base64Data: '', mediaType: 'text/plain', sizeBytes: 0 };
}

describe('a file on this computer', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-input-'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('is not read when the list is made, so a call holds one file at a time', () => {
    // Files that are not there: a list that read them would throw or fail them here.
    const prepared = localAttachments([{ filePath: path.join(scratch, 'a.txt') }, { filePath: path.join(scratch, 'b.txt') }]);

    expect(prepared.failures).toEqual([]);
    expect(prepared.ready.map((entry) => entry.filePath)).toEqual([path.join(scratch, 'a.txt'), path.join(scratch, 'b.txt')]);
  });

  it('is read when it is added, and a file there when the list was made but gone by then is a failure', () => {
    const present = path.join(scratch, 'present.txt');
    fs.writeFileSync(present, 'hello');
    const prepared = localAttachments([{ filePath: present, filename: 'renamed.txt' }, { filePath: path.join(scratch, 'gone.txt') }]);
    const added: ReadFileResult[] = [];

    const outcome = addPreparedAttachments(prepared, (file) => added.push(file), 'test');

    expect(outcome.added).toBe(1);
    expect(added[0]).toMatchObject({ filename: 'renamed.txt', mediaType: 'text/plain', sizeBytes: 5, base64Data: Buffer.from('hello').toString('base64') });
    expect(outcome.failures.map((failure) => failure.filePath)).toEqual([path.join(scratch, 'gone.txt')]);
  });
});

describe('adding what is ready', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads each file once, in order, just before it is added', () => {
    const events: string[] = [];
    const prepared: PreparedAttachments = {
      ready: ['one', 'two', 'three'].map((name) => ({
        filePath: `/x/${name}`,
        read: () => { events.push(`read ${name}`); return fileResult(name); },
      })),
      failures: [],
    };

    const outcome = addPreparedAttachments(prepared, (file) => { events.push(`add ${file.filename}`); }, 'test');

    expect(events).toEqual(['read one', 'add one', 'read two', 'add two', 'read three', 'add three']);
    expect(outcome).toEqual({ added: 3, failures: [] });
  });

  it('turns a read that throws into a failure with its reason, and still adds the rest', () => {
    const added: string[] = [];
    const prepared: PreparedAttachments = {
      ready: [
        { filePath: '/x/first', read: () => fileResult('first') },
        { filePath: '/x/broken', read: () => { throw new Error('disk went away'); } },
        { filePath: '/x/last', read: () => fileResult('last') },
      ],
      failures: [{ filePath: '/x/earlier', reason: 'no such file on the host' }],
    };

    const outcome = addPreparedAttachments(prepared, (file) => { added.push(file.filename); }, 'test');

    expect(added).toEqual(['first', 'last']);
    expect(outcome.added).toBe(2);
    expect(outcome.failures).toEqual([
      { filePath: '/x/earlier', reason: 'no such file on the host' },
      { filePath: '/x/broken', reason: 'disk went away' },
    ]);
  });

  it('turns a refusal by the store into a failure too', () => {
    const prepared: PreparedAttachments = { ready: [{ filePath: '/x/a', read: () => fileResult('a') }], failures: [] };

    const outcome = addPreparedAttachments(prepared, () => { throw new Error('store is full'); }, 'test');

    expect(outcome).toEqual({ added: 0, failures: [{ filePath: '/x/a', reason: 'store is full' }] });
  });
});

describe('the files a call holds from a host', () => {
  const paths = agentPathsForProject({ path: path.join(os.tmpdir(), 'attachment-input-shell'), remote: { hostId: 'host-1', path: HOST_PROJECT } });
  const access = { hostId: 'host-1' } as unknown as HostAccess;
  const context = { agentPaths: () => paths, hostAccess: () => access } as unknown as CommandContext;

  /** Stands in for a file of `size` bytes without allocating them: the code reads only `length` until it adds the row. */
  function ofSize(size: number): { kind: 'bytes'; bytes: Buffer } {
    return { kind: 'bytes', bytes: { length: size } as unknown as Buffer };
  }

  afterEach(() => {
    vi.mocked(readHostBytes).mockReset();
  });

  it('fail past 200MB together, naming the limit, and the files before the limit are kept', async () => {
    vi.mocked(readHostBytes).mockResolvedValue(ofSize(50 * MEGABYTE));
    const requests = Array.from({ length: 5 }, (_unused, index) => ({ filePath: `${HOST_PROJECT}/big-${index}.bin` }));

    const prepared = await fetchHostAttachments(requests, context);

    expect(prepared?.ready.map((entry) => entry.filePath)).toEqual(requests.slice(0, 4).map((request) => request.filePath));
    expect(prepared?.failures).toHaveLength(1);
    expect(prepared?.failures[0].filePath).toBe(requests[4].filePath);
    expect(prepared?.failures[0].reason).toContain('200MB');
  });

  it('count only what was kept: a file refused as too large does not use the budget up', async () => {
    vi.mocked(readHostBytes)
      .mockResolvedValueOnce({ kind: 'too-large', size: 80 * MEGABYTE })
      .mockResolvedValueOnce(ofSize(50 * MEGABYTE))
      .mockResolvedValueOnce(ofSize(50 * MEGABYTE))
      .mockResolvedValueOnce(ofSize(50 * MEGABYTE))
      .mockResolvedValueOnce(ofSize(50 * MEGABYTE));

    const prepared = await fetchHostAttachments(Array.from({ length: 5 }, (_unused, index) => ({ filePath: `/x/${index}` })), context);

    expect(prepared?.ready).toHaveLength(4);
    expect(prepared?.failures).toHaveLength(1);
    expect(prepared?.failures[0].reason).toContain('File too large');
  });

  it('are not fetched at all for a project on this computer', () => {
    expect(fetchHostAttachments([{ filePath: '/x/a' }], { getProjectPath: () => '/local' } as unknown as CommandContext)).toBeNull();
    expect(readHostBytes).not.toHaveBeenCalled();
  });
});

// A file name that holds a backslash can exist only where the file system allows it. Windows reads it as a separator.
describe.runIf(process.platform !== 'win32')('a POSIX file name that holds a backslash', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-utils-'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('keeps its whole name as the attachment\'s', () => {
    const file = path.join(scratch, 'we\\ird name.png');
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));

    const read = readFileAsAttachment(file);

    expect(read.filename).toBe('we\\ird name.png');
    expect(read.mediaType).toBe('image/png');
    expect(read.sizeBytes).toBe(3);
  });
});
