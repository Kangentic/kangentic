/**
 * Where Kangentic finds a task's artifacts on its own (#1056), wired to the
 * one write path (`linkArtifacts`). Three sources, in order of how sure they
 * are:
 *
 * 1. **A publish.** A tool an adapter's hooks mark as publishing answered
 *    with links (`SessionEvent.urls`). The agent made it for this task, so a
 *    recognised link is added as the agent's, documents included.
 * 2. **The agent's messages.** Links the agent wrote in its own prose, read
 *    with the message trail in the retrieval worker. Designs, diagrams and
 *    generated apps only.
 * 3. **The terminal**, only for an agent with no transcript reader, at a turn
 *    end: the links in what the session printed. Same platforms as 2.
 *
 * A task description is the fourth source and lives in `TaskRepository`, in
 * the write that sets the description.
 *
 * No agent is named here: the publish tools are the adapter's hook spec, and
 * "has no transcript reader" is a capability read off the adapter.
 */

import { exposeHyperlinkTargets } from '../../shared/ansi-strip';
import { artifactPlatformOf, findArtifactLinks } from '../../shared/artifact-platforms';
import type { TaskArtifactInput, TaskArtifactSource } from '../../shared/types';
import { agentRegistry } from '../agent/agent-registry';
import type { MessageTrailTracker } from '../agent/message-trail-tracker';
import type { IpcContext } from '../ipc/ipc-context';
import type { TurnEndedPayload } from '../pty/session-manager';
import { linkArtifacts } from './artifact-linking';

/** What `SessionManager` emits on `'artifact-links'`: a publish tool's links and title. */
export interface PublishedArtifactLinks {
  urls: string[];
  title: string | null;
  source: TaskArtifactSource;
}

/** How much of a session's output a turn-end scan reads: the newest part, where a turn's links are. */
const TERMINAL_SCAN_TAIL_CHARS = 256 * 1024;

/**
 * The artifacts a publish produced: the recognised links among those its
 * result carried, never a tracker's. The title names the link only when the
 * publish produced exactly one, since a title cannot say which of several.
 */
export function publishedArtifacts(published: Pick<PublishedArtifactLinks, 'urls' | 'title'>): TaskArtifactInput[] {
  const recognised = published.urls.filter((url) => {
    const platform = artifactPlatformOf(url);
    return platform !== null && platform.detection !== 'manual';
  });
  const name = recognised.length === 1 ? published.title : null;
  return recognised.map((url) => ({ url, name }));
}

export function registerArtifactDetection(context: IpcContext, messageTrailTracker: MessageTrailTracker): void {
  const guarded = (label: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      console.error(`[artifacts] ${label} failed:`, error);
    }
  };

  context.sessionManager.on('artifact-links', (sessionId: string, published: PublishedArtifactLinks) => {
    guarded('linking a published artifact', () => {
      linkArtifacts(context, { sessionId, artifacts: publishedArtifacts(published), source: published.source });
    });
  });

  messageTrailTracker.on('artifact-links', (sessionId: string, links: string[], projectId: string) => {
    guarded('linking an artifact from a message', () => {
      linkArtifacts(context, { sessionId, projectId, artifacts: links.map((url) => ({ url })), source: 'detected' });
    });
  });

  context.sessionManager.on('turn-ended', (payload: TurnEndedPayload) => {
    const session = context.sessionManager.getSession(payload.sessionId);
    if (!session || session.transient) return;
    const agentName = context.sessionManager.getSessionAgentName(payload.sessionId);
    const adapter = agentName ? agentRegistry.get(agentName) : undefined;
    // An agent whose transcript can be read is covered by its messages, the
    // cleaner source: a terminal also shows what the user pasted and what a
    // tool printed.
    if (!adapter || adapter.parseTranscript || adapter.parseTranscriptWindow) return;
    void context.sessionManager.getRawScrollback(payload.sessionId).then((scrollback) => {
      guarded('linking an artifact from the terminal', () => {
        // The targets go in first: an OSC 8 link's address is not in its text.
        const text = exposeHyperlinkTargets(scrollback.slice(-TERMINAL_SCAN_TAIL_CHARS));
        const links = findArtifactLinks(text, { documents: false });
        linkArtifacts(context, {
          taskId: payload.taskId,
          projectId: payload.projectId,
          artifacts: links.map((url) => ({ url })),
          source: 'detected',
        });
      });
    }, () => { /* the session's output is gone: nothing to scan */ });
  });
}
