/**
 * A file an agent attaches by path, for `create_task`, `update_task` and the two backlog handlers.
 *
 * The path names a file where the agent runs. For a remote project that is the host, so the file is fetched from there:
 * reading this disk finds nothing, or on macOS and Linux a different file at the same path. A file that cannot be
 * attached is reported to the agent in the tool's message. It used to reach only this computer's console, so an
 * agent read a success and carried on without the screenshot it thought it had filed.
 *
 * Reading comes apart from adding so a local read stays synchronous for the handlers that are, and a host's read
 * happens before anything is written.
 */

import {
  attachmentFromBytes,
  attachmentTooLargeMessage,
  MAX_ATTACHMENT_BYTES,
  readFileAsAttachment,
  type ReadFileResult,
} from '../../db/repositories/attachment-utils';
import { agentPathsOf } from '../../remote/host-paths';
import { readHostBytes } from '../../remote/host-transfer';
import type { CommandContext } from './types';

export interface AttachmentRequest {
  filePath: string;
  filename?: string;
}

export interface AttachmentFailure {
  filePath: string;
  reason: string;
}

export interface PreparedAttachments {
  ready: Array<{ filePath: string; file: ReadFileResult }>;
  failures: AttachmentFailure[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read each file from this computer. */
export function readLocalAttachments(requests: readonly AttachmentRequest[]): PreparedAttachments {
  const prepared: PreparedAttachments = { ready: [], failures: [] };
  for (const request of requests) {
    try {
      prepared.ready.push({ filePath: request.filePath, file: readFileAsAttachment(request.filePath, request.filename) });
    } catch (error) {
      prepared.failures.push({ filePath: request.filePath, reason: reasonOf(error) });
    }
  }
  return prepared;
}

/** Fetch each file from a remote project's host, or null for a project on this computer, whose files are read here. */
export function fetchHostAttachments(requests: readonly AttachmentRequest[] | null | undefined, context: CommandContext): Promise<PreparedAttachments> | null {
  if (!requests || requests.length === 0) return null;
  const paths = agentPathsOf(context);
  if (paths.location !== 'host') return null;
  return (async () => {
    const access = context.hostAccess?.() ?? null;
    const prepared: PreparedAttachments = { ready: [], failures: [] };
    for (const request of requests) {
      if (!access) {
        prepared.failures.push({ filePath: request.filePath, reason: 'this project\'s host is not available' });
        continue;
      }
      try {
        const read = await readHostBytes(access, paths.toAgent(request.filePath), MAX_ATTACHMENT_BYTES);
        if (read.kind === 'bytes') prepared.ready.push({ filePath: request.filePath, file: attachmentFromBytes(read.bytes, request.filePath, request.filename) });
        else if (read.kind === 'too-large') prepared.failures.push({ filePath: request.filePath, reason: attachmentTooLargeMessage(read.size) });
        else prepared.failures.push({ filePath: request.filePath, reason: 'no such file on the host' });
      } catch (error) {
        prepared.failures.push({ filePath: request.filePath, reason: reasonOf(error) });
      }
    }
    return prepared;
  })();
}

/** Add what is ready. A file the store refuses joins the failures. */
export function addPreparedAttachments(
  prepared: PreparedAttachments,
  add: (file: ReadFileResult) => void,
  logTag: string,
): { added: number; failures: AttachmentFailure[] } {
  const failures = [...prepared.failures];
  let added = 0;
  for (const { filePath, file } of prepared.ready) {
    try {
      add(file);
      added += 1;
    } catch (error) {
      failures.push({ filePath, reason: reasonOf(error) });
    }
  }
  for (const failure of failures) console.error(`[${logTag}] Failed to attach file "${failure.filePath}": ${failure.reason}`);
  return { added, failures };
}

/** What a tool's message says about what did not attach. Empty when everything did. */
export function attachmentFailureNote(failures: readonly AttachmentFailure[]): string {
  if (failures.length === 0) return '';
  const lines = failures.map((failure) => `${failure.filePath}: ${failure.reason}`).join('; ');
  return ` ${failures.length === 1 ? 'One file was' : `${failures.length} files were`} not attached. ${lines}`;
}
