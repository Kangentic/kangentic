import {
  parseCapabilityRequestPayload,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type DiffFileContentWire,
  type DiffFileListWire,
} from '@kangentic/protocol';
import type { DiffWatcher } from '../../git/diff-watcher';
import { DiffService } from '../../git/diff-service';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import type { IpcContext } from '../../ipc/ipc-context';
import type { BridgeSession } from '../session/bridge-session';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import { sendEvent } from './send-event';
import { toWireJson } from './wire-mappers';

// Cache DiffService instances per directory so the merge-base cache persists
// across calls, mirroring src/main/ipc/handlers/git-diff.ts's own cache.
// Stale post-relocation entries are harmless (same rationale as that file).
const serviceCache = new Map<string, DiffService>();

function getOrCreateService(gitDirectory: string): DiffService {
  const existing = serviceCache.get(gitDirectory);
  if (existing) return existing;
  const service = new DiffService(gitDirectory);
  serviceCache.set(gitDirectory, service);
  return service;
}

function subscriptionKeyFor(taskId: string): string {
  return `diff:${taskId}`;
}

export async function handleReadDiff(
  request: CapabilityRequestMessage,
  session: BridgeSession,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
  diffWatcher: DiffWatcher,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('read-diff', request.payload);
  const subscriptionKey = subscriptionKeyFor(payload.taskId);

  if (payload.action === 'unsubscribe') {
    subscriptions.remove(subscriptionKey);
    return { type: 'capability-response', requestId: request.requestId, ok: true };
  }

  const project = context.projectRepo.getById(payload.projectId);
  if (!project) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such project: ${payload.projectId}` };
  }
  const repos = getProjectRepos(context, payload.projectId);
  const task = repos.tasks.getById(payload.taskId);
  if (!task) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such task: ${payload.taskId}` };
  }

  const worktreePath = task.worktree_path ?? undefined;
  const baseBranch = task.base_branch ?? 'main';
  const gitDirectory = worktreePath ?? project.path;
  const service = getOrCreateService(gitDirectory);

  if (payload.filePath) {
    // The wire contract does not carry the file's diff status (added/modified/deleted/...),
    // which getFileContent requires - resolve it from the current file list first.
    const fileList = await service.getDiffFiles({ worktreePath, projectPath: project.path, baseBranch, scope: payload.scope });
    const entry = fileList.files.find((file) => file.path === payload.filePath);
    if (!entry) {
      return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such file in the diff: ${payload.filePath}` };
    }
    const content = await service.getFileContent({
      worktreePath,
      projectPath: project.path,
      baseBranch,
      filePath: payload.filePath,
      status: entry.status,
      oldPath: entry.oldPath,
      scope: payload.scope,
    });
    // GitFileContentResult is a structurally exact mirror of DiffFileContentWire.
    const contentPayload: DiffFileContentWire = content;
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(contentPayload) };
  }

  // GitDiffFilesResult is a structurally exact mirror of DiffFileListWire.
  const fileList: DiffFileListWire = await service.getDiffFiles({ worktreePath, projectPath: project.path, baseBranch, scope: payload.scope });

  const watchPath = gitDirectory;
  // Use the per-subscriber teardown DiffWatcher.subscribe returns, NOT
  // unsubscribe(watchPath): the watcher multiplexes callbacks per path, so a
  // blanket unsubscribe(watchPath) would kill a co-located subscription (a
  // second device, or another worktree-less task in the same repo) too.
  const unsubscribeDiff = diffWatcher.subscribe(watchPath, () => {
    sendEvent(session, { kind: 'diff', taskId: payload.taskId, payload: null });
  });
  subscriptions.set(subscriptionKey, unsubscribeDiff);

  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(fileList) };
}
