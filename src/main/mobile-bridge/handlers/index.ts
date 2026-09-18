import type { DiffWatcher } from '../../git/diff-watcher';
import type { IpcContext } from '../../ipc/ipc-context';
import type { CapabilityRouter } from '../capability-router';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import type { PushRegistrationStore } from '../push/push-registration-store';
import { handleReadStream } from './read-stream';
import { handleReadBoard } from './read-board';
import { handleReadDiff } from './read-diff';
import { handleSendUserMessage } from './send-user-message';
import { handleMoveTask } from './move-task';
import { handleInteractiveTerminal } from './interactive-terminal';
import { handleAnswerPermissionPrompt } from './answer-permission-prompt';
import { handleBoardTool } from './board-tool';
import { handleRegisterPush } from './register-push';
import { handleStartSession } from './start-session';

export interface CapabilityHandlerDeps {
  context: IpcContext;
  /** Bridge-owned, never `context.diffWatcher` - that instance is shared with the renderer's git-diff panel and is single-watch-per-path, so a bridge teardown would kill the renderer's live watch (and vice versa). */
  diffWatcher: DiffWatcher;
  getSubscriptions: (deviceId: string) => SubscriptionRegistry;
  /** Bridge-owned push registration sidecar; register-push writes it, the push notifier reads it. */
  pushRegistrations: PushRegistrationStore;
}

/**
 * Registers every Phase 2 capability verb's handler on the router, once,
 * at MobileBridgeService.attachContext() - never per-session. Deny-by-default
 * authorization already happened in CapabilityRouter.dispatch() before a
 * handler here ever runs; these only implement behavior.
 */
export function registerCapabilityHandlers(router: CapabilityRouter, deps: CapabilityHandlerDeps): void {
  router.register('read-stream', (request, session) =>
    handleReadStream(request, session, deps.context, deps.getSubscriptions(session.deviceId)));
  router.register('read-board', (request, session) =>
    handleReadBoard(request, session, deps.context, deps.getSubscriptions(session.deviceId)));
  router.register('read-diff', (request, session) =>
    handleReadDiff(request, session, deps.context, deps.getSubscriptions(session.deviceId), deps.diffWatcher));
  router.register('send-user-message', (request) => handleSendUserMessage(request, deps.context));
  router.register('move-task', (request) => handleMoveTask(request, deps.context));
  router.register('interactive-terminal', (request, session) =>
    handleInteractiveTerminal(request, deps.context, deps.getSubscriptions(session.deviceId)));
  router.register('answer-permission-prompt', (request) => handleAnswerPermissionPrompt(request, deps.context));
  router.register('board-tool-read', (request) => handleBoardTool(request, deps.context));
  router.register('board-tool-write', (request) => handleBoardTool(request, deps.context));
  router.register('register-push', (request, session) => handleRegisterPush(request, session, deps.pushRegistrations));
  router.register('start-session', (request) => handleStartSession(request, deps.context));
}
