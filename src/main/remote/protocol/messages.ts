/**
 * What the link and the helper say to each other (#913), carried as the JSON body of a
 * sequenced frame (`frame-codec.ts`, `resume-endpoint.ts`). It is the pty host's own
 * vocabulary (`pty/host/protocol.ts`) with the two things a remote host adds:
 *
 * - A PTY id on the wire is the link's id for it, never the helper's. The helper maps it
 *   (`helper-server.ts`), so a link that restarts and counts from 1 again cannot route an old
 *   exit to a new handle.
 * - `snapshot` and `rebind`, which let a link that lost frames to a drop, or came back after
 *   a restart, rebuild what it missed from what the helper holds now.
 *
 * Terminal text never travels as JSON. A port message's `data` moves into the frame's raw
 * part (`splitPortMessage`), so output is not escaped on the way.
 */

import type { PtyHostCommand, PtyHostError, PtyHostEvent, PtyHostMethod, PtyHostRequestMap } from '../../pty/host/protocol';
import type { FromPtyHostPortMessage, ToPtyHostPortMessage } from '../../../shared/pty-port-protocol';

/** One PTY the helper holds, as the link needs it to rebuild its own state. */
export interface HelperSessionRecord {
  sessionId: string;
  taskId: string | null;
  projectId: string;
  pid: number;
  alive: boolean;
  /** Null while the PTY runs. */
  exitCode: number | null;
  /** The link's id for it while one is bound, else null. */
  wirePtyId: number | null;
  inAltScreen: boolean;
}

export interface HelperSnapshot {
  /** Counts up each time a connection is accepted as the owner. */
  ownerEpoch: number;
  daemonPid: number;
  daemonStartedAt: string;
  sessions: HelperSessionRecord[];
}

/** Requests only the helper answers, beside the pty host's own. */
export interface HelperRequestMap {
  /** Bind the link's id to a session the helper already holds. */
  rebind: { params: { sessionId: string; ptyId: number }; result: { ok: boolean } };
  snapshot: { params: Record<string, never>; result: HelperSnapshot };
}

export type HelperMethod = keyof HelperRequestMap;
export type RemoteMethod = PtyHostMethod | HelperMethod;

export type RemoteRequestParams<M extends RemoteMethod> = M extends HelperMethod
  ? HelperRequestMap[M]['params']
  : M extends PtyHostMethod
    ? PtyHostRequestMap[M]['params']
    : never;

export type RemoteRequestResult<M extends RemoteMethod> = M extends HelperMethod
  ? HelperRequestMap[M]['result']
  : M extends PtyHostMethod
    ? PtyHostRequestMap[M]['result']
    : never;

/** The body of a port message once its text is split out. */
type WithoutData<T> = T extends { data: string } ? Omit<T, 'data'> : T;
export type PortBody = WithoutData<ToPtyHostPortMessage | FromPtyHostPortMessage>;

export type LinkToHelperMessage =
  | { t: 'command'; command: PtyHostCommand }
  | { t: 'request'; id: number; method: RemoteMethod; params: unknown }
  | { t: 'port'; message: PortBody };

export type HelperToLinkMessage =
  | { t: 'event'; event: PtyHostEvent }
  | { t: 'reply'; id: number; ok: true; result: unknown }
  | { t: 'reply'; id: number; ok: false; error: PtyHostError }
  | { t: 'port'; message: PortBody };

/** Move a port message's text into the raw part. */
export function splitPortMessage(message: ToPtyHostPortMessage | FromPtyHostPortMessage): { body: PortBody; raw: Buffer | undefined } {
  if ('data' in message) {
    const { data, ...body } = message;
    return { body: body as PortBody, raw: Buffer.from(data, 'utf8') };
  }
  return { body: message as PortBody, raw: undefined };
}

/** The reverse of `splitPortMessage`. */
export function joinPortMessage<Message extends ToPtyHostPortMessage | FromPtyHostPortMessage>(body: PortBody, raw: Buffer): Message {
  const type = (body as { type?: string }).type;
  if (type === 'write' || type === 'data' || type === 'scrollback') {
    return { ...body, data: raw.toString('utf8') } as unknown as Message;
  }
  return body as unknown as Message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A message from the link, or null when it is not one. A frame of an unknown kind is ignored, never thrown. */
export function parseLinkMessage(json: unknown): LinkToHelperMessage | null {
  if (!isRecord(json)) return null;
  if (json.t === 'command' && isRecord(json.command) && typeof json.command.type === 'string') return json as unknown as LinkToHelperMessage;
  if (json.t === 'request' && typeof json.id === 'number' && typeof json.method === 'string') return json as unknown as LinkToHelperMessage;
  if (json.t === 'port' && isRecord(json.message)) return json as unknown as LinkToHelperMessage;
  return null;
}

/** A message from the helper, or null when it is not one. */
export function parseHelperMessage(json: unknown): HelperToLinkMessage | null {
  if (!isRecord(json)) return null;
  if (json.t === 'event' && isRecord(json.event) && typeof json.event.type === 'string') return json as unknown as HelperToLinkMessage;
  if (json.t === 'reply' && typeof json.id === 'number' && typeof json.ok === 'boolean') return json as unknown as HelperToLinkMessage;
  if (json.t === 'port' && isRecord(json.message)) return json as unknown as HelperToLinkMessage;
  return null;
}
