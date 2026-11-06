/**
 * A file an agent attaches by path, for `create_task`, `update_task` and the two backlog handlers.
 *
 * The path names a file where the agent runs. For a remote project that is the host, so the file is fetched from there:
 * reading this disk finds nothing, or on macOS and Linux a different file at the same path. A file that cannot be
 * attached is reported to the agent in the tool's message. It used to reach only this computer's console, so an
 * agent read a success and carried on without the screenshot it thought it had filed.
 *
 * A local file is read as it is added, so one call holds one file at a time and a project here stays synchronous. A
 * host's files are fetched before anything is written, so they sit in memory until the row exists, under a budget for
 * the call.
 */

import {
  attachmentFromBytes,
  attachmentTooLargeMessage,
  MAX_ATTACHMENT_BYTES,
  readFileAsAttachment,
  type ReadFileResult,
} from '../../db/repositories/attachment-utils';
import { agentPathsOf } from '../../remote/host-paths';
import { HOST_NOT_AVAILABLE, readHostBytes } from '../../remote/host-transfer';
import type { CommandContext, CommandResponse } from './types';

/** What one call may hold from a host. The schema caps neither the list nor the mobile bridge's path around it. */
const MAX_HELD_HOST_BYTES = 200 * 1024 * 1024;

export interface AttachmentRequest {
  filePath: string;
  filename?: string;
}

export interface AttachmentFailure {
  filePath: string;
  reason: string;
}

export interface PreparedAttachments {
  ready: Array<{ filePath: string; read: () => ReadFileResult }>;
  failures: AttachmentFailure[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Each file on this computer, read when it is added. */
export function localAttachments(requests: readonly AttachmentRequest[]): PreparedAttachments {
  return {
    ready: requests.map((request) => ({ filePath: request.filePath, read: () => readFileAsAttachment(request.filePath, request.filename) })),
    failures: [],
  };
}

/** Fetch each file from a remote project's host, or null for a project on this computer, whose files are read here. */
export function fetchHostAttachments(requests: readonly AttachmentRequest[] | null | undefined, context: CommandContext): Promise<PreparedAttachments> | null {
  if (!requests || requests.length === 0) return null;
  const paths = agentPathsOf(context);
  if (!paths.hostId) return null;
  return (async () => {
    const access = context.hostAccess?.() ?? null;
    const prepared: PreparedAttachments = { ready: [], failures: [] };
    let heldBytes = 0;
    for (const request of requests) {
      if (!access) {
        prepared.failures.push({ filePath: request.filePath, reason: HOST_NOT_AVAILABLE });
        continue;
      }
      try {
        const read = await readHostBytes(access, paths.toAgent(request.filePath), MAX_ATTACHMENT_BYTES);
        if (read.kind === 'too-large') prepared.failures.push({ filePath: request.filePath, reason: attachmentTooLargeMessage(read.size) });
        else if (read.kind === 'missing') prepared.failures.push({ filePath: request.filePath, reason: 'no such file on the host' });
        else if (heldBytes + read.bytes.length > MAX_HELD_HOST_BYTES) {
          prepared.failures.push({ filePath: request.filePath, reason: `one call attaches at most ${MAX_HELD_HOST_BYTES / 1024 / 1024}MB from a host` });
        } else {
          heldBytes += read.bytes.length;
          prepared.ready.push({ filePath: request.filePath, read: () => attachmentFromBytes(read.bytes, request.filePath, request.filename) });
        }
      } catch (error) {
        prepared.failures.push({ filePath: request.filePath, reason: reasonOf(error) });
      }
    }
    return prepared;
  })();
}

/** Run `apply` with a host's files fetched first. A project here stays synchronous, as its callers read it. */
export function withHostAttachments(
  attachments: unknown,
  context: CommandContext,
  apply: (hostAttachments: PreparedAttachments | null) => CommandResponse,
): CommandResponse | Promise<CommandResponse> {
  const fromHost = fetchHostAttachments(attachments as AttachmentRequest[] | null | undefined, context);
  return fromHost ? fromHost.then(apply) : apply(null);
}

/** Add what is ready. A file that cannot be read or that the store refuses joins the failures. */
export function addPreparedAttachments(
  prepared: PreparedAttachments,
  add: (file: ReadFileResult) => void,
  logTag: string,
): { added: number; failures: AttachmentFailure[] } {
  const failures = [...prepared.failures];
  let added = 0;
  for (const { filePath, read } of prepared.ready) {
    try {
      add(read());
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
