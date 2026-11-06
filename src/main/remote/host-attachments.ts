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
 *
 * Both callers hold the task's lock, which has no timeout, and every other operation on the task waits behind it. So
 * the whole copy has a budget, and what is left when it runs out is a failure like any other, noted in the prompt.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { agentPathsForProjectPath } from './host-paths';
import { HOST_NOT_AVAILABLE, hostAccessFor, hostFileSizes, writeHostBytes } from './host-transfer';

/** Room for a 50 MB attachment at a few hundred milliseconds a chunk, and no longer than a person waits on a move. */
const COPY_BUDGET_MS = 120_000;
/** Each chunk is one round trip, so files side by side pay the link's latency once. */
const COPY_CONCURRENCY = 3;

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

/**
 * Copy what the host does not hold yet. Nothing to do for a project on this computer, or a task with no attachments.
 * `signal` is the caller's, so a superseding move does not wait out the budget.
 */
export async function copyAttachmentsToHost(
  projectPath: string | null | undefined,
  localPaths: readonly string[],
  signal?: AbortSignal,
  budgetMs: number = COPY_BUDGET_MS,
): Promise<AttachmentCopyFailure[]> {
  if (!projectPath || localPaths.length === 0) return [];
  const paths = agentPathsForProjectPath(projectPath);
  if (!paths.hostId) return [];
  const hostPaths = localPaths.map((localPath) => paths.toAgent(localPath));
  const access = hostAccessFor(paths.hostId);
  if (!access) return hostPaths.map((hostPath) => ({ hostPath, reason: HOST_NOT_AVAILABLE }));

  let sizesOnHost: Array<number | null>;
  try {
    sizesOnHost = await hostFileSizes(access, hostPaths);
  } catch (error) {
    return hostPaths.map((hostPath) => ({ hostPath, reason: reasonOf(error) }));
  }

  const stop = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(signal ? [signal] : [])]);
  const failures = await mapWithConcurrency(localPaths, COPY_CONCURRENCY, async (localPath, index): Promise<AttachmentCopyFailure | null> => {
    const hostPath = hostPaths[index];
    try {
      if (sizesOnHost[index] !== null && sizesOnHost[index] === await localSize(localPath)) return null;
      await writeHostBytes(access, hostPath, await fs.readFile(localPath), stop);
      return null;
    } catch (error) {
      return { hostPath, reason: reasonOf(error) };
    }
  });
  return failures.filter((failure) => failure !== null);
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

/** A prompt's variables once the task's attachments are on the host: `vars` itself unless one did not get there. */
export async function withAttachmentsOnHost<Vars extends { attachments?: string }>(
  projectPath: string | null | undefined,
  localPaths: readonly string[],
  vars: Vars,
  signal?: AbortSignal,
): Promise<Vars> {
  const failures = await copyAttachmentsToHost(projectPath, localPaths, signal);
  if (failures.length === 0) return vars;
  return { ...vars, attachments: withFailedAttachmentsNoted(vars.attachments ?? '', failures) };
}
