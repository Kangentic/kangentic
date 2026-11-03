/**
 * Where each pty host command and request goes when the pty host also holds SSH links (#913). Both
 * `HostRouter` and `LinkHub` read these two tables, and both tables are exhaustive: a new command type
 * or request method fails `tsc` here until someone decides whether it follows a PTY, a session, every
 * host, or stays with the local core. Before them the routing was three sets in two files, and a new
 * session-addressed command would have gone to the local core in silence.
 *
 * Imports nothing of electron.
 */

import type { PtyHostCommand, PtyHostMethod } from '../pty/host/protocol';

export type CommandRoute =
  /** The router acts on it itself (a quit plan for one host's link). */
  | 'router'
  /** The local core and every link hear it: what each renderer shows and what a phone streams. */
  | 'every-host'
  /** The local core hears it, and so does the link holding the session it names. */
  | 'core-and-session'
  /** The link holding the PTY it names, or the local core when no link holds it. */
  | 'by-pty'
  /** The link holding the session it names, or the local core when no link holds it. */
  | 'by-session'
  /** Only the local core: a CLI run, or the core's own shutdown. */
  | 'core';

export const COMMAND_ROUTES = {
  remoteQuitPlan: 'router',
  write: 'by-pty',
  enqueueWrite: 'by-pty',
  sealUserInput: 'by-pty',
  resizePty: 'by-pty',
  kill: 'by-pty',
  resizeBuffer: 'by-session',
  markResized: 'by-session',
  setActivity: 'by-session',
  setAgentSessionIdKnown: 'by-session',
  finalizeTranscript: 'by-session',
  cancelSpawn: 'by-session',
  initSession: 'by-session',
  removeSession: 'core-and-session',
  setRendererFocus: 'every-host',
  forgetRenderer: 'every-host',
  setTapped: 'every-host',
  releaseBackpressure: 'every-host',
  cliSpawn: 'core',
  cliWrite: 'core',
  cliEndInput: 'core',
  cliStop: 'core',
  shutdown: 'core',
} as const satisfies Record<PtyHostCommand['type'], CommandRoute>;

export type RequestRoute =
  /** The router answers it: the `remote` operations on the links themselves. */
  | 'router'
  /** A spawn goes to a link when it names a host, and to the local core otherwise. */
  | 'spawn'
  /** The link holding the PTY it names, or the local core when no link holds it. */
  | 'by-pty'
  /** The link holding the session it names, or the local core when no link holds it. */
  | 'by-session'
  /** Only the local core: this computer's processes, files and diagnostics. */
  | 'core';

export const REQUEST_ROUTES = {
  spawn: 'spawn',
  getScrollback: 'by-session',
  getScrollbackForRenderer: 'by-session',
  drainWrites: 'by-pty',
  getPromptDraft: 'by-session',
  getSerializedFrame: 'by-session',
  getSeedFrame: 'by-session',
  getRawScrollback: 'by-session',
  getOutputPeek: 'by-session',
  getDiagnostics: 'core',
  ping: 'core',
  remote: 'router',
  closeProject: 'core',
  exec: 'core',
  listProcesses: 'core',
  reapTaggedProcesses: 'core',
  stopReportedProcess: 'core',
  checkReportedProcesses: 'core',
  probeTaskProcesses: 'core',
  awaitAgentExit: 'core',
  spawnRaw: 'core',
  devArmRoundTripProbe: 'core',
  devReadRoundTripProbe: 'core',
  devLagReport: 'core',
  devCpuProfile: 'core',
} as const satisfies Record<PtyHostMethod, RequestRoute>;

export function commandRoute(command: PtyHostCommand): CommandRoute {
  return COMMAND_ROUTES[command.type];
}

export function requestRoute(method: PtyHostMethod): RequestRoute {
  return REQUEST_ROUTES[method];
}
