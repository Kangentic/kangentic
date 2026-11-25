/**
 * Main's half of the session layer: failures in `SessionManager`, the session queue, the
 * main-side readers and the pty host client that are caught where they happen.
 *
 * A launch that fails reports through the launch report (`agent-launch-report.ts`), and a
 * failure inside the pty host reaches main as a relayed code (`pty-host-report.ts`, source
 * `pty_host`). This reporter is for main's own work around a session that no caller sees
 * fail: a queued agent whose start threw, a listener of `turn-ended` or `session-resumed`
 * throwing (so a column's turn-end rows or a resume's follow-ups never run), a queue gate
 * that threw and fell back, a status or events parser that threw, the handling of sessions
 * a lost host left behind.
 *
 * Each site names its step in `stage`, a fixed word. No session id, task title, command
 * line, working directory, terminal output or prompt text rides a tag.
 *
 * Main only, and a leaf. Nothing under `host/` or `process-tag/` may import it: that code
 * runs in the pty host, which cannot load Sentry. There a failure is relayed with
 * `handledErrors.report(code, error)` and a code added to `PtyHostHandledErrorCode`
 * (`host/protocol.ts`).
 */

import { createChokepointReporter, type ChokepointReporter } from '../analytics/handled-report';

export const sessionManagerReporter: ChokepointReporter = createChokepointReporter('session_manager');
