/**
 * What the process holding the links says when a host has no link there. It knows no host's name and never
 * says its id, which reached a terminal and a Sentry title before (DESKTOP-4N). Main's host service rewrites it
 * with the host's name and its last connect's words where it can.
 */
export const HOST_NOT_CONNECTED_SENTENCE = 'This host is not connected.';

/**
 * The error's name. A refusal crosses the pty host's transport as a plain Error with this name, so main
 * matches by it (`sendHelper`, `isRemoteLinkRefusal`), never by class. The class below spells it out as a
 * literal, the declaration `handled-report.test.ts` finds for `EXPECTED_FAILURE_NAMES`, and
 * `pty-spawn.test.ts` pins that the two agree.
 */
export const HOST_UNREACHABLE_ERROR_NAME = 'HostUnreachableError';

/**
 * A host this computer cannot reach: no link is set up for it, or its connect failed or is still under
 * way. Its own module, with no imports, so main can throw it without bundling the link hub. The name is
 * set explicitly because it is what survives the transport.
 */
export class HostUnreachableError extends Error {
  constructor(readonly hostId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HostUnreachableError';
  }
}
