/**
 * A remote task's attachments, on the host where its agent reads them (#913).
 *
 * An attachment is stored on this computer, under the project's shell folder. An agent's prompt names it, and on a host
 * that name is the same place under the project's folder there, so the file is copied to that place before the agent
 * is told about it. `.kangentic/` is excluded from git on the host, so the copies never show as changes.
 *
 * A file the host already holds at the same size is left: attachments are written once and never edited. One that
 * cannot be copied keeps the spawn going, because an agent with a note is better than a task that will not start
 * over a screenshot. The note goes where the prompt lists the attachments, so the agent reads it beside them.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { agentPathsForProjectPath } from './host-paths';
import { hostAccessFor, hostFileSizes, writeHostBytes } from './host-transfer';

export interface AttachmentCopyFailure {
  /** The path the agent is told. */
  hostPath: string;
  reason: string;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function localSize(localPath: string): Promise<number | null> {
  return (await fs.stat(localPath).catch(() => null))?.size ?? null;
}

/** Copy what the host does not hold yet. Nothing to do for a project on this computer, or a task with no attachments. */
export async function copyAttachmentsToHost(projectPath: string | null | undefined, localPaths: readonly string[]): Promise<AttachmentCopyFailure[]> {
  if (!projectPath || localPaths.length === 0) return [];
  const paths = agentPathsForProjectPath(projectPath);
  if (paths.location === 'local' || !paths.hostId) return [];
  const hostPaths = localPaths.map((localPath) => paths.toAgent(localPath));
  const access = hostAccessFor(paths.hostId);
  if (!access) return hostPaths.map((hostPath) => ({ hostPath, reason: 'this project\'s host is not available' }));

  let sizesOnHost: Array<number | null>;
  try {
    sizesOnHost = await hostFileSizes(access, hostPaths);
  } catch (error) {
    return hostPaths.map((hostPath) => ({ hostPath, reason: reasonOf(error) }));
  }

  const failures: AttachmentCopyFailure[] = [];
  for (const [index, localPath] of localPaths.entries()) {
    const hostPath = hostPaths[index];
    try {
      if (sizesOnHost[index] !== null && sizesOnHost[index] === await localSize(localPath)) continue;
      await writeHostBytes(access, hostPath, await fs.readFile(localPath));
    } catch (error) {
      failures.push({ hostPath, reason: reasonOf(error) });
    }
  }
  return failures;
}

/**
 * The `{{attachments}}` text with what did not reach the host taken out of its list and named instead, so a prompt
 * never hands the agent a path that names nothing. The text unchanged when everything arrived.
 */
export function withFailedAttachmentsNoted(attachmentsText: string, failures: readonly AttachmentCopyFailure[]): string {
  if (failures.length === 0) return attachmentsText;
  const failed = new Set(failures.map((failure) => failure.hostPath));
  const arrived = attachmentsText.split('\n').filter((line) => line && !failed.has(line));
  const notes = failures.map((failure) => `(Not copied to this host, so not readable here: ${path.posix.basename(failure.hostPath)}. ${failure.reason})`);
  return `\n${[...arrived, ...notes].join('\n')}`;
}
