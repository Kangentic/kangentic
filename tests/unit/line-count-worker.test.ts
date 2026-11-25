/**
 * The line-count worker's message boundary. The worker runs in its own process
 * with its own descriptor table, so a count that opens every file at once fills
 * that table the same way main's did. It also cannot report: a failure that is
 * not a missing file has to come back as a fixed code, or nobody hears of it.
 * The worker needs Electron's `process.parentPort`, so a fake one stands in.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import { LINE_COUNT_CONCURRENCY } from '../../src/main/git/line-count/count-lines';
import type { LineCountEntry } from '../../src/main/git/line-count/line-count-worker';

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

/** Resolves on a later turn of the event loop, the way a real file call does. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
    let openHandles = 0;
    let peakOpenHandles = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation((async () => {
      openHandles += 1;
      peakOpenHandles = Math.max(peakOpenHandles, openHandles);
      await nextTurn();
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          await nextTurn();
          content.copy(buffer, offset, position, position + length);
          return { bytesRead: length, buffer };
        },
        close: async () => {
          await nextTurn();
          openHandles -= 1;
        },
      };
    }) as never);
    const paths = mockPaths(200);

    send({ type: 'count', id: 1, paths });
    const entries = await resultOf(1);

    expect(entries).toHaveLength(200);
    expect(entries[0]).toEqual({ path: paths[0], insertions: 2, binary: false });
    expect(entries[199]).toEqual({ path: paths[199], insertions: 2, binary: false });
    // Above 1, so a count that went serial does not pass as bounded.
    expect(peakOpenHandles).toBeGreaterThan(1);
    expect(peakOpenHandles).toBeLessThanOrEqual(LINE_COUNT_CONCURRENCY);
    expect(openHandles).toBe(0);
  });

  it('relays a full descriptor table to main once, by a fixed code, and still answers the batch', async () => {
    const paths = mockPaths(3);
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 12 } as never);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (filePath) => {
      throw fileError('EMFILE', 'open', String(filePath));
    });

    send({ type: 'count', id: 2, paths });
    const entries = await resultOf(2);
    send({ type: 'count', id: 3, paths });
    await resultOf(3);

    expect(entries).toEqual(paths.map((filePath) => ({ path: filePath, insertions: 0, binary: false })));
    // Six files failed across two batches. Main latches too, but a relay per file
    // would be one message for each of 150,000 files.
    expect(posted('handledError')).toEqual([
      { type: 'handledError', code: 'count_file', errorName: 'Error', errorCode: 'EMFILE', syscall: 'open' },
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
      { type: 'handledError', code: 'count_file', errorName: 'Error', errorCode: 'EACCES', syscall: 'open' },
    ]);
  });

  it('counts a file deleted since git status as no lines and relays nothing', async () => {
    const paths = mockPaths(2);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (filePath) => {
      throw fileError('ENOENT', 'stat', String(filePath));
    });

    send({ type: 'count', id: 5, paths });
    const entries = await resultOf(5);

    expect(entries).toEqual(paths.map((filePath) => ({ path: filePath, insertions: 0, binary: false })));
    expect(posted('handledError')).toEqual([]);
  });
});
