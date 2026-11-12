/**
 * When and how soon a host that could not be set up is tried again (#913). Setting a host up installs the
 * program on it over `ssh` before any link exists, and a link retries by itself only once one does. A
 * launch, or a restart of the pty host, with the network down therefore left the host Unreachable until
 * someone pressed Reconnect, though the link's own redial would have found it the moment the network came
 * back.
 *
 * Only a failure that is the network's is retried. A sign-in that is refused, a host key that changed, an
 * address that is not valid and a build with no program to install would fail the same way every time, and
 * trying them again on a timer is how a host's fail2ban bans its owner. Those wait for the person.
 *
 * Imports nothing of electron.
 */

/** The first wait, and the cap the doubling stops at. */
export const CONNECT_RETRY_FIRST_MS = 5_000;
export const CONNECT_RETRY_CAP_MS = 60_000;

/** The wait before retry number `attempt` (0 for the first). */
export function connectRetryDelayMs(attempt: number): number {
  return Math.min(CONNECT_RETRY_CAP_MS, CONNECT_RETRY_FIRST_MS * 2 ** Math.max(0, attempt));
}

/** Words that say the failure will not change by itself. A message with one of them is never retried. */
const PERMANENT_FAILURE = [
  /permission denied/i,
  /host key verification failed/i,
  /remote host identification has changed/i,
  /too many authentication failures/i,
  /the host address is not valid/i,
  /does not include the program to install/i,
  /checksum/i,
  /glibc/i,
];

/** Words that say the network, not the host's answer, is why. */
const NETWORK_FAILURE = [
  /connection timed out/i,
  /operation timed out/i,
  /timed out/i,
  /connection refused/i,
  /connection reset/i,
  /connection closed/i,
  /could not resolve hostname/i,
  /name or service not known/i,
  /temporary failure in name resolution/i,
  /network is unreachable/i,
  /no route to host/i,
  /host is down/i,
  /kex_exchange_identification/i,
  /ssh_exchange_identification/i,
  /broken pipe/i,
];

export function isTransientConnectFailure(message: string): boolean {
  if (PERMANENT_FAILURE.some((pattern) => pattern.test(message))) return false;
  return NETWORK_FAILURE.some((pattern) => pattern.test(message));
}
