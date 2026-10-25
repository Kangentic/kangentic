/**
 * The messages on a renderer's direct port to the pty host (a
 * `MessageChannelMain` pair main brokers once per renderer and never relays).
 * Keystrokes go to the host and their echo comes back on it, so typing never
 * waits on main's event loop. Main still carries everything else a terminal
 * does: resize, focus, mount, the scrollback request. Only the scrollback's
 * answer comes back on the port, after the session's earlier output, which is
 * what keeps the replay's held-byte drop exact (`useTerminal.ts`).
 *
 * Every field is plain data: the port structured-clones it.
 */

/** Renderer to host. */
export type ToPtyHostPortMessage =
  /** Typed (or pasted) input for a session's live PTY, through the host's write queue. */
  | { type: 'write'; sessionId: string; data: string }
  /** The renderer consumed this many characters of a session's output (backpressure). */
  | { type: 'ack'; sessionId: string; bytes: number };

/** Host to renderer. */
export type FromPtyHostPortMessage =
  /** Output for a session this renderer shows, in flush-sized slices. */
  | { type: 'data'; sessionId: string; data: string }
  /** The answer to a `getScrollback` this renderer asked main for, by its request id. */
  | { type: 'scrollback'; requestId: number; data: string }
  | { type: 'scrollbackFailed'; requestId: number; message: string };

/**
 * What main's `SESSION_GET_SCROLLBACK` answers a renderer that named a request
 * id: the host put the sample on the renderer's port, or, when it held no port
 * for that renderer, the sample itself.
 */
export type ScrollbackInvokeResult =
  | { sentToPort: true }
  | { sentToPort: false; data: string };
