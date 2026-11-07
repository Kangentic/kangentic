/**
 * The copy worker: one Electron utilityProcess per folder or glob copy, so
 * walking and copying a large folder stays off the main event loop, and an
 * abort is a kill that reaches only that copy (`worktree-copy-client.ts`).
 *
 * Bundled by esbuild as its own entry (`.vite/build/worktree-copy-worker.js`).
 */

import { copyEntries, type CopyEntriesRequest, type CopyEntriesResult } from './copy-entries';
import { WorktreeCopyLimitError } from '../worktree-errors';

interface CopyMessage {
  type: 'copy';
  request: CopyEntriesRequest;
}

export type WorktreeCopyAnswer =
  | { type: 'result'; result: CopyEntriesResult }
  | { type: 'failed'; message: string; overLimit: boolean };

const parentPort = process.parentPort;

function post(answer: WorktreeCopyAnswer): void {
  parentPort.postMessage(answer);
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  const message = event.data as CopyMessage;
  // Defensive parse boundary, as in line-count-worker.ts.
  if (typeof message !== 'object' || message === null || message.type !== 'copy') return;
  copyEntries(message.request)
    .then((result) => post({ type: 'result', result }))
    .catch((error: unknown) => post({
      type: 'failed',
      message: error instanceof Error ? error.message : String(error),
      overLimit: error instanceof WorktreeCopyLimitError,
    }));
});
