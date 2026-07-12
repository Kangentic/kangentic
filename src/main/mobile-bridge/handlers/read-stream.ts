import {
  parseCapabilityRequestPayload,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type JsonValue,
  type ReadStreamResponsePayload,
} from '@kangentic/protocol';
import type { ActivityReason, ActivityState, SessionEvent, SessionUsage } from '../../../shared/types';
import { getProjectDb } from '../../db/database';
import { resolveTaskTranscript } from '../../agent/transcript-service';
import type { IpcContext } from '../../ipc/ipc-context';
import type { BridgeSession } from '../session/bridge-session';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import { sendEvent } from './send-event';
import { buildPermissionPromptId } from './permission-prompt-id';

/** Coalesce raw PTY output before pushing, so a burst of small onData chunks does not become a flood of tiny frames. */
const TERMINAL_COALESCE_MS = 50;

function subscriptionKeyFor(sessionId: string): string {
  return `stream:${sessionId}`;
}

function subscribeReadStream(
  sessionId: string,
  taskId: string,
  session: BridgeSession,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
): void {
  const db = getProjectDb(context.sessionManager.getSessionProjectId(sessionId) ?? '');
  let lastKnownRevision = -1;
  let pendingTerminalChunks: string[] = [];
  let terminalFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushTerminal = (): void => {
    terminalFlushTimer = null;
    if (pendingTerminalChunks.length === 0) return;
    const data = pendingTerminalChunks.join('');
    pendingTerminalChunks = [];
    sendEvent(session, { kind: 'terminal', sessionId, taskId, payload: { data } });
  };

  const pushTranscriptIfChanged = async (): Promise<void> => {
    try {
      const resolved = await resolveTaskTranscript(db, sessionId);
      if (!resolved || resolved.revision === lastKnownRevision) return;
      lastKnownRevision = resolved.revision;
      sendEvent(session, { kind: 'transcript', sessionId, taskId, payload: resolved.entries as unknown as JsonValue });
    } catch {
      // Best-effort; a transcript-read failure should not tear down the subscription.
    }
  };

  const onDataTap = (tappedSessionId: string, data: string): void => {
    if (tappedSessionId !== sessionId) return;
    pendingTerminalChunks.push(data);
    if (!terminalFlushTimer) terminalFlushTimer = setTimeout(flushTerminal, TERMINAL_COALESCE_MS);
  };
  const onActivity = (activitySessionId: string, state: ActivityState, reason: ActivityReason): void => {
    if (activitySessionId !== sessionId) return;
    sendEvent(session, {
      kind: 'activity',
      sessionId,
      taskId,
      payload: { type: 'activity', state: state as unknown as JsonValue, reason: reason as unknown as JsonValue },
    });
  };
  const onUsage = (usageSessionId: string, usage: SessionUsage): void => {
    if (usageSessionId !== sessionId) return;
    sendEvent(session, { kind: 'activity', sessionId, taskId, payload: { type: 'usage', usage: usage as unknown as JsonValue } });
  };
  const onSessionEvent = (eventSessionId: string, event: SessionEvent): void => {
    if (eventSessionId !== sessionId) return;
    sendEvent(session, { kind: 'activity', sessionId, taskId, payload: { type: 'event', event: event as unknown as JsonValue } });
    void pushTranscriptIfChanged();
  };

  // When the session exits, tear our own subscription down: nothing else
  // removes these listeners until the device disconnects, so without this a
  // long-lived phone connection would leak four listeners per session it ever
  // streamed onto the singleton SessionManager.
  const onExit = (exitedSessionId: string): void => {
    if (exitedSessionId !== sessionId) return;
    flushTerminal(); // push any last coalesced output before we stop listening
    subscriptions.remove(subscriptionKeyFor(sessionId));
  };

  context.sessionManager.on('data-tap', onDataTap);
  context.sessionManager.on('activity', onActivity);
  context.sessionManager.on('usage', onUsage);
  context.sessionManager.on('event', onSessionEvent);
  context.sessionManager.on('exit', onExit);

  subscriptions.set(subscriptionKeyFor(sessionId), () => {
    context.sessionManager.off('data-tap', onDataTap);
    context.sessionManager.off('activity', onActivity);
    context.sessionManager.off('usage', onUsage);
    context.sessionManager.off('event', onSessionEvent);
    context.sessionManager.off('exit', onExit);
    if (terminalFlushTimer) clearTimeout(terminalFlushTimer);
  });
}

export async function handleReadStream(
  request: CapabilityRequestMessage,
  session: BridgeSession,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('read-stream', request.payload);
  const subscriptionKey = subscriptionKeyFor(payload.sessionId);

  if (payload.action === 'unsubscribe') {
    subscriptions.remove(subscriptionKey);
    return { type: 'capability-response', requestId: request.requestId, ok: true };
  }

  const liveSession = context.sessionManager.getSession(payload.sessionId);
  if (!liveSession) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${payload.sessionId}` };
  }

  const scrollback = await context.sessionManager.getScrollback(payload.sessionId);
  const activityState = context.sessionManager.getActivityCache()[payload.sessionId] ?? null;
  const activityReason = context.sessionManager.getActivityReason(payload.sessionId);
  const usage = context.sessionManager.getUsageCache()[payload.sessionId] ?? null;
  const statsSnapshot = context.sessionManager.getActivityStatsSnapshot(payload.sessionId);
  const awaitedPromptId = statsSnapshot?.permissionPending && statsSnapshot.permissionAwaitedToolId
    ? buildPermissionPromptId(payload.sessionId, statsSnapshot.permissionAwaitedToolId)
    : null;

  const responsePayload: ReadStreamResponsePayload = {
    scrollback,
    activity: { state: activityState, reason: activityReason } as unknown as JsonValue,
    usage: usage as unknown as JsonValue,
    awaitedPromptId,
  };

  subscribeReadStream(payload.sessionId, liveSession.taskId, session, context, subscriptions);

  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}
