/**
 * The copy worker's message boundary. A user loses the reason a start failed if
 * an over-limit answer comes back as a plain failure: the client turns
 * `overLimit` back into the settings mistake that stays out of crash reports.
 * The worker needs Electron's `process.parentPort`, so a fake one stands in.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const { mockCopyEntries } = vi.hoisted(() => ({ mockCopyEntries: vi.fn() }));

vi.mock('../../src/main/git/worktree-copy/copy-entries', () => ({ copyEntries: mockCopyEntries }));

import { WorktreeCopyLimitError } from '../../src/main/git/worktree-errors';

interface FakeParentPort {
  on: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

const REQUEST = { projectPath: '/project', worktreePath: '/worktree', entries: ['data'], linkedFolders: [] };
const RESULT = { copied: 2, unchanged: 0, skippedLinks: 0 };

const processWithPort = process as unknown as { parentPort?: FakeParentPort };
const originalParentPort = processWithPort.parentPort;
const parentPort: FakeParentPort = { on: vi.fn(), postMessage: vi.fn() };

// Taken right after the import: the config may clear mock calls between tests.
let messageHandler: ((event: { data: unknown }) => void) | undefined;

function send(data: unknown): void {
  expect(messageHandler, 'the worker must listen for messages on the parent port').toBeDefined();
  messageHandler?.({ data });
}

/** Lets the worker's promise chain settle, and the answer it posts land. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

beforeAll(async () => {
  processWithPort.parentPort = parentPort;
  await import('../../src/main/git/worktree-copy/worktree-copy-worker');
  messageHandler = parentPort.on.mock.calls.find(([eventName]) => eventName === 'message')?.[1] as
    ((event: { data: unknown }) => void) | undefined;
});

afterAll(() => {
  processWithPort.parentPort = originalParentPort;
});

beforeEach(() => {
  parentPort.postMessage.mockClear();
  mockCopyEntries.mockReset();
});

describe('the copy worker', () => {
  it('answers a copy with its result', async () => {
    mockCopyEntries.mockResolvedValue(RESULT);
    send({ type: 'copy', request: REQUEST });
    await settle();
    expect(mockCopyEntries).toHaveBeenCalledWith(REQUEST);
    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: 'result', result: RESULT });
  });

  it('marks a limit failure overLimit, so the client can type it again', async () => {
    mockCopyEntries.mockRejectedValue(new WorktreeCopyLimitError('data has over 20,000 files'));
    send({ type: 'copy', request: REQUEST });
    await settle();
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'failed',
      message: 'data has over 20,000 files',
      overLimit: true,
    });
  });

  it('marks any other failure as not over a limit', async () => {
    mockCopyEntries.mockRejectedValue(new Error('EBUSY: locked'));
    send({ type: 'copy', request: REQUEST });
    await settle();
    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: 'failed', message: 'EBUSY: locked', overLimit: false });
  });

  it('answers a thrown non-error with its text', async () => {
    mockCopyEntries.mockRejectedValue('plain text');
    send({ type: 'copy', request: REQUEST });
    await settle();
    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: 'failed', message: 'plain text', overLimit: false });
  });

  it.each([
    ['a message of another type', { type: 'other', request: REQUEST }],
    ['a message with no type', { request: REQUEST }],
    ['null', null],
    ['a string', 'copy'],
  ])('posts nothing and copies nothing for %s', async (_label, data) => {
    send(data);
    await settle();
    expect(mockCopyEntries).not.toHaveBeenCalled();
    expect(parentPort.postMessage).not.toHaveBeenCalled();
  });
});
