import { EventEmitter } from 'node:events';

export type BoardChange = 'task-created' | 'task-updated' | 'task-deleted' | 'swimlane-updated' | 'backlog-changed';

export interface BoardChangedEvent {
  projectId: string;
  change: BoardChange;
  ids: string[];
}

/**
 * A single main-process-internal event stream for every agent-driven board
 * mutation, consolidating the ad-hoc `IPC.*_BY_AGENT` renderer pushes
 * (fired from `buildCommandContextForProject`'s six callbacks in
 * mcp-project-context.ts, plus the PR-linking push in pr-linking.ts) into
 * one place a bridge session can subscribe to and filter by projectId,
 * instead of listening to each ad-hoc channel individually.
 *
 * This is purely additive: it is fed alongside the existing renderer
 * `sendToRenderer(...)` calls, never replacing them, so the renderer's
 * `useAgentDrivenInvalidation` path is entirely unaffected. Not an IPC
 * channel - `IpcContext.boardEvents` is a plain Node EventEmitter consumed
 * only by other main-process code (the mobile bridge's read-board handler),
 * so the ipc-7-layer-parity rule does not apply here.
 */
export class BoardEventBus extends EventEmitter {
  emitBoardChanged(event: BoardChangedEvent): void {
    this.emit('board-changed', event);
  }

  onBoardChanged(listener: (event: BoardChangedEvent) => void): () => void {
    this.on('board-changed', listener);
    return () => this.off('board-changed', listener);
  }
}
