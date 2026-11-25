/**
 * The line-count worker's message boundary. The worker runs in its own process
 * with its own descriptor table, so a count that opens every file at once fills
 * that table the same way main's did. It also cannot report: a failure that is
 * not a missing file has to come back as its class, errno and syscall, or nobody hears of it.
 * The worker needs Electron's `process.parentPort`, so a fake one stands in.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import { LINE_COUNT_CONCURRENCY } from '../../src/main/git/line-count/count-lines';
import type { LineCountEntry } from '../../src/main/git/line-count/line-count-worker';
import { nextEventLoopTurn, trackOpenFileHandles } from './helpers/file-call-trackers';

interface FakeParentPort {
  on: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

type PostedMessage = Record<string, unknown>;

const processWithPort = process as unknown as { parentPort?: FakeParentPort };
const originalParentPort = processWithPort.parentPort;
const parentPort: FakeParentPort = { on: vi.fn(), postMessage: vi.fn() };

// Taken right after the import: the config may clear mock calls between tests.
let messageHandler: ((event: { data: unknown }) => void) | undefined;

function send(data: unknown): void {
  expect(messageHandler, 'the worker must listen for messages on the parent port').toBeDefined();
  messageHandler?.({ data });
}

function posted(type: string): PostedMessage[] {
  return parentPort.postMessage.mock.calls
    .map(([message]) => message as PostedMessage)
    .filter((message) => message.type === type);
}

/** The entries the worker answered request `requestId` with, once it has. */
async function resultOf(requestId: number): Promise<LineCountEntry[]> {
  // A poll for the answer, with room for a loaded CI runner: the count takes event-loop turns.
  await vi.waitFor(() => {
    expect(posted('result').some((message) => message.id === requestId)).toBe(true);
  }, { timeout: 10_000 });
  return posted('result').find((message) => message.id === requestId)?.entries as LineCountEntry[];
}

function fileError(code: string, syscall: string, filePath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: could not ${syscall} '${filePath}'`), { code, syscall });
}

function mockPaths(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `/mock/untracked/file-${index}.txt`);
}

beforeAll(async () => {
  processWithPort.parentPort = parentPort;
  await import('../../src/main/git/line-count/line-count-worker');
  messageHandler = parentPort.on.mock.calls.find(([eventName]) => eventName === 'message')?.[1] as
    ((event: { data: unknown }) => void) | undefined;
});

afterAll(() => {
  processWithPort.parentPort = originalParentPort;
});

beforeEach(() => {
  parentPort.postMessage.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the line-count worker', () => {
  it('holds at most LINE_COUNT_CONCURRENCY files open while it counts a batch', async () => {
    const content = Buffer.from('line1\nline2\n');
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: content.length } as never);
    const handles = trackOpenFileHandles(content);
    vi.spyOn(fs.promises, 'open').mockImplementation(handles.open as never);
    const paths = mockPaths(200);

    send({ type: 'count', id: 1, paths });
    const entries = await resultOf(1);

    expect(entries).toHaveLength(200);
    expect(entries[0]).toStrictEqual({ insertions: 2, binary: false });
    expect(entries[199]).toStrictEqual({ insertions: 2, binary: false });
    // Above 1, so a count that went serial does not pass as bounded.
    expect(handles.peakOpenHandles).toBeGreaterThan(1);
    expect(handles.peakOpenHandles).toBeLessThanOrEqual(LINE_COUNT_CONCURRENCY);
    expect(handles.openHandles).toBe(0);
  });

  it('answers in the order of the request, each file with its own count, when later files finish first', async () => {
    // A reply in completion order would hand a file another file's lines on the
    // Changes panel, since main matches counts to paths by index.
    const paths = mockPaths(6);
    const lineCounts = [1, 2, 3, 4, 5, 6];
    const indexOf = (filePath: unknown): number => paths.indexOf(String(filePath));
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (filePath: unknown) => (
      { size: 'x\n'.repeat(lineCounts[indexOf(filePath)]).length }
    )) as never);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (filePath: unknown) => {
      const fileIndex = indexOf(filePath);
      const content = Buffer.from('x\n'.repeat(lineCounts[fileIndex]));
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          // The first file waits the most turns and the last the fewest.
          for (let turn = 0; turn < (paths.length - fileIndex) * 3; turn += 1) await nextEventLoopTurn();
          content.copy(buffer, offset, position, position + length);
          return { bytesRead: length, buffer };
        },
        close: async () => undefined,
      };
    }) as never);

    send({ type: 'count', id: 6, paths });
    const entries = await resultOf(6);

    // toStrictEqual also pins that an entry carries no path.
    expect(entries).toStrictEqual(lineCounts.map((insertions) => ({ insertions, binary: false })));
  });

  it('relays a full descriptor table to main once, by its class, errno and syscall, and still answers the batch', async () => {
    const paths = mockPaths(3);
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 12 } as never);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (filePath) => {
      throw fileError('EMFILE', 'open', String(filePath));
    });

    send({ type: 'count', id: 2, paths });
    const entries = await resultOf(2);
    send({ type: 'count', id: 3, paths });
    await resultOf(3);

    expect(entries).toEqual(paths.map(() => ({ insertions: 0, binary: false })));
    // Six files failed across two batches. Main latches too, but a relay per file
    // would be one message for each of 150,000 files.
    expect(posted('handledError')).toEqual([
      { type: 'handledError', errorName: 'Error', errorCode: 'EMFILE', syscall: 'open' },
    ]);
  });

  it('relays each errno of its own', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 12 } as never);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (filePath) => {
      throw fileError('EACCES', 'open', String(filePath));
    });

    send({ type: 'count', id: 4, paths: mockPaths(2) });
    await resultOf(4);

    expect(posted('handledError')).toEqual([
      { type: 'handledError', errorName: 'Error', errorCode: 'EACCES', syscall: 'open' },
    ]);
  });

  it('relays a failure that has no errno and no syscall as its class alone, with no empty keys', async () => {
    // main reads the relay field by field, so a key present with an undefined
    // value would be a different message from one that is absent. The class
    // and errno pair here (Error with no code) is one no other test relays,
    // since the worker's dedup lasts the whole run of this file.
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 12 } as never);
    vi.spyOn(fs.promises, 'open').mockImplementation(async () => {
      throw new Error('the disk went away');
    });

    send({ type: 'count', id: 7, paths: mockPaths(2) });
    await resultOf(7);

    expect(posted('handledError')).toStrictEqual([{ type: 'handledError', errorName: 'Error' }]);
  });

  it('counts a file deleted since git status as no lines and relays nothing', async () => {
    const paths = mockPaths(2);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (filePath) => {
      throw fileError('ENOENT', 'stat', String(filePath));
    });

    send({ type: 'count', id: 5, paths });
    const entries = await resultOf(5);

    expect(entries).toEqual(paths.map(() => ({ insertions: 0, binary: false })));
    expect(posted('handledError')).toEqual([]);
  });
});
