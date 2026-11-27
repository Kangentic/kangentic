/**
 * The remote (SSH) subsystem's failures that run in main and would otherwise only be logged.
 *
 * Two reporters, by what is lost:
 *
 * - `remoteRelayReporter` (`remote_session_relay`): the session relay, which carries a host agent's
 *   hooks, permission prompts and transcript to this computer. A failure there leaves the board not
 *   following an agent that is still running: a prompt that never shows, a conversation that stops.
 * - `remoteHostReporter` (`remote_host`): everything about a host itself and its projects: a
 *   worktree path that cannot be mapped, taking a running agent back at startup, revealing a
 *   restored host's projects, putting a host's own files back.
 * - `remoteProgramUpdateReporter` (`remote_program_update`): an update of the program on a host after
 *   an update of the app (`program-update.ts`) that could not finish. The old program keeps running and
 *   its agents are resumed, so what is lost is the update, until the next run tries again. Its `stage`
 *   says which step stopped it: `hold`, `suspend`, `stop`, `reconnect` or `resume`.
 *
 * A drop is a state, never a failure (`.claude/rules/ssh-remote.md`), and the reporters hold to it
 * with no work at the call site: a host out of reach is `HostUnreachableError`, a request the host
 * never answered is `HostRequestUnansweredError`, and both are in `EXPECTED_FAILURE_NAMES`, so
 * `isExpectedFailure` skips them. What still reports is a host that answered with a failure, a
 * write to this computer's disk that failed, and this side's own logic.
 *
 * Each site names its step in `stage`, a fixed word. A host's name or address, a path on either
 * machine and a project's name never ride a tag.
 *
 * Main only. `remote/helper/**` runs on the host and `remote/link/**`, `remote/protocol/**` and
 * `host-router.ts` run in the pty host: neither can import Sentry. The helper answers with the
 * failure in its reply, and the pty host relays a fixed code (`handledErrors.report`), which main
 * reports as `pty_host`.
 */

import { createChokepointReporter, type ChokepointReporter } from '../analytics/handled-report';

export const remoteRelayReporter: ChokepointReporter = createChokepointReporter('remote_session_relay');
export const remoteHostReporter: ChokepointReporter = createChokepointReporter('remote_host');
export const remoteProgramUpdateReporter: ChokepointReporter = createChokepointReporter('remote_program_update');
