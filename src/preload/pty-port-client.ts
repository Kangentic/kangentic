/**
 * The renderer's end of its direct port to the pty host, held in the preload
 * (a port cannot cross `contextBridge`). `sessions.write`, `onData`, `ackData`
 * and `getScrollback` keep their `ElectronAPI` shape and run over it, so a
 * keystroke and its echo never wait on main's event loop: a git start, a
 * database write or a burst of IPC on main froze every terminal's typing
 * before (task #900).
 *
 * - Writes and acks made before the first port arrives are kept, in order, and
 *   sent once it does. A port replaced after a pty host restart takes the next
 *   ones; what was sent on the dead one went with that host, as its PTYs did.
 * - `getScrollback` asks main (`invokeScrollback`, behind any resize this
 *   renderer sent first) and resolves on the port's answer, which arrives after
 *   the output the host flushed before its sample. Nothing is queued or timed
 *   between the port's message and the resolve, so the caller's continuation
 *   runs before the next port message: the order `useTerminal`'s held-byte drop
 *   relies on. Main answers with the data itself only when the host held no
 *   port for this renderer.
 *
 * Web APIs only: the preload is sandboxed (`preload-web-apis-only.test.ts`).
 */

import type { FromPtyHostPortMessage, ScrollbackInvokeResult, ToPtyHostPortMessage } from '../shared/pty-port-protocol';

/** The part of a DOM `MessagePort` the client uses. */
export interface PtyPortEndpoint {
  postMessage(message: ToPtyHostPortMessage): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

export type SessionDataListener = (sessionId: string, data: string) => void;

interface PendingScrollback {
  resolve(data: string): void;
  reject(error: Error): void;
}

function isHostMessage(value: unknown): value is FromPtyHostPortMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'data') return typeof message.sessionId === 'string' && typeof message.data === 'string';
  if (message.type === 'scrollback') return typeof message.requestId === 'number' && typeof message.data === 'string';
  if (message.type === 'scrollbackFailed') return typeof message.requestId === 'number' && typeof message.message === 'string';
  return false;
}

export class PtyPortClient {
  private port: PtyPortEndpoint | null = null;
  private readonly handleMessage = (event: { data: unknown }): void => this.onMessage(event.data);
  /** Writes and acks made before the first port, sent in order once it arrives. */
  private readonly unsent: ToPtyHostPortMessage[] = [];
  private readonly listeners = new Set<SessionDataListener>();
  private readonly pendingScrollbacks = new Map<number, PendingScrollback>();
  private nextRequestId = 1;

  constructor(
    private readonly invokeScrollback: (sessionId: string, requestId: number) => Promise<ScrollbackInvokeResult | string>,
  ) {}

  /** Take the port main brokered (at load, and again after a host restart). */
  attachPort(port: PtyPortEndpoint): void {
    const previous = this.port;
    this.port = port;
    port.addEventListener('message', this.handleMessage);
    port.start();
    if (previous) {
      previous.removeEventListener('message', this.handleMessage);
      try {
        previous.close();
      } catch {
        // Its host is gone already.
      }
      // Those answers would have come from the host that is gone.
      this.rejectPending(new Error('The pty host restarted before it answered'));
    }
    for (const message of this.unsent.splice(0)) port.postMessage(message);
  }

  write(sessionId: string, data: string): void {
    this.send({ type: 'write', sessionId, data });
  }

  ack(sessionId: string, bytes: number): void {
    this.send({ type: 'ack', sessionId, bytes });
  }

  onData(listener: SessionDataListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getScrollback(sessionId: string): Promise<string> {
    const requestId = this.nextRequestId++;
    return new Promise<string>((resolve, reject) => {
      this.pendingScrollbacks.set(requestId, { resolve, reject });
      this.invokeScrollback(sessionId, requestId).then(
        (result) => {
          // `{ sentToPort }` can arrive before the port's answer or after it,
          // so it settles nothing. Only data main sent itself does.
          const data = typeof result === 'string' ? result : result.sentToPort ? null : result.data;
          if (data === null) return;
          const pending = this.pendingScrollbacks.get(requestId);
          this.pendingScrollbacks.delete(requestId);
          pending?.resolve(data);
        },
        (error: unknown) => {
          const pending = this.pendingScrollbacks.get(requestId);
          this.pendingScrollbacks.delete(requestId);
          pending?.reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private send(message: ToPtyHostPortMessage): void {
    if (this.port) this.port.postMessage(message);
    else this.unsent.push(message);
  }

  private onMessage(message: unknown): void {
    if (!isHostMessage(message)) return;
    if (message.type === 'data') {
      for (const listener of this.listeners) listener(message.sessionId, message.data);
      return;
    }
    // An id this page never asked for (a reply meant for the page before a
    // reload) is dropped.
    const pending = this.pendingScrollbacks.get(message.requestId);
    if (!pending) return;
    this.pendingScrollbacks.delete(message.requestId);
    if (message.type === 'scrollback') pending.resolve(message.data);
    else pending.reject(new Error(message.message));
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pendingScrollbacks.values()];
    this.pendingScrollbacks.clear();
    for (const entry of pending) entry.reject(error);
  }
}
