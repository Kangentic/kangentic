import { EventEmitter } from 'node:events';

export type BoardChange = 'task-created' | 'task-updated' | 'task-deleted' | 'swimlane-updated' | 'backlog-changed';

export interface BoardChangedEvent {
  projectId: string;
  change: BoardChange;
  ids: string[];
}

/**
 * A single main-process-internal event stream for every board mutation,
 * whatever caused it: an agent tool call, a session lifecycle edge, or a plain
 * desktop drag. It consolidates the ad-hoc `IPC.*_BY_AGENT` renderer pushes
 * (fired from `buildCommandContextForProject`'s callbacks in
 * mcp-project-context.ts, plus the PR-linking push in pr-linking.ts) into
 * one place a bridge session can subscribe to and filter by projectId,
 * instead of listening to each ad-hoc channel individually.
 *
 * A task move is the exception to the "fed right next to a renderer push"
 * shape below: `handleTaskMove` owns that fan-out for all four of its callers
 * and emits here itself, keyed on the origin it was given. That is also why
 * this bus hears a plain RENDERER-origin drag, which no `*_BY_AGENT` channel
 * ever carries - the subscribers here (paired phones, the Agent Monitor) are
 * external to whoever moved the card, so they need it just the same.
 *
 * A PR-link reconcile reaches this bus as a plain `task-updated`, even though
 * its renderer push is the quiet `TASK_PR_LINK_CHANGED`: toast-worthiness is a
 * renderer concern, and a subscriber here still needs to know the row moved.
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
