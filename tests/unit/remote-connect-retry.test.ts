/**
 * Which setup failures of a host are retried on a timer, and how soon (#913). A launch with the network
 * down used to leave a host Unreachable until Reconnect was pressed. What a user loses if the split is
 * wrong: a refused sign-in retried every minute (a host's fail2ban bans its owner), or a network blip at
 * launch that never heals.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECT_RETRY_CAP_MS,
  CONNECT_RETRY_FIRST_MS,
  connectRetryDelayMs,
  isTransientConnectFailure,
} from '../../src/main/remote/connect-retry';

describe('isTransientConnectFailure', () => {
  it.each([
    'ssh exited with code 255: ssh: connect to host lab port 22: Connection timed out',
    'ssh: connect to host lab port 22: Connection refused',
    'ssh: Could not resolve hostname lab: Name or service not known',
    'ssh: connect to host 10.0.0.5 port 22: Network is unreachable',
    'ssh: connect to host 10.0.0.5 port 22: No route to host',
    'Connection closed by 10.0.0.5 port 22',
    'kex_exchange_identification: read: Connection reset by peer',
    'Could not read the host\'s details: Operation timed out',
  ])('retries the network\'s own failure: %s', (message) => {
    expect(isTransientConnectFailure(message)).toBe(true);
  });

  it.each([
    'dev@lab: Permission denied (publickey,password).',
    'Host key verification failed.',
    '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
    'The host address is not valid. Use a name from your SSH config, user@host, or an ssh:// address.',
    'This build of Kangentic does not include the program to install on a host. A development build makes it with npm run build:host.',
    'Installing the helper failed: the program\'s checksum does not match',
    'Too many authentication failures',
    'This host has glibc 2.17; the program needs 2.28 or newer.',
  ])('never retries what would fail the same way again: %s', (message) => {
    expect(isTransientConnectFailure(message)).toBe(false);
  });

  it('lets a permanent word win over a network word in the same message', () => {
    expect(isTransientConnectFailure('Connection closed by lab: Permission denied (publickey).')).toBe(false);
  });

  it('does not retry a failure it has no words for', () => {
    expect(isTransientConnectFailure('something unexpected')).toBe(false);
  });
});

describe('connectRetryDelayMs', () => {
  it('starts at the first wait, doubles, and stops at the cap', () => {
    expect(connectRetryDelayMs(0)).toBe(CONNECT_RETRY_FIRST_MS);
    expect(connectRetryDelayMs(1)).toBe(CONNECT_RETRY_FIRST_MS * 2);
    expect(connectRetryDelayMs(2)).toBe(CONNECT_RETRY_FIRST_MS * 4);
    expect(connectRetryDelayMs(3)).toBe(CONNECT_RETRY_FIRST_MS * 8);
    expect(connectRetryDelayMs(4)).toBe(CONNECT_RETRY_CAP_MS);
    expect(connectRetryDelayMs(40)).toBe(CONNECT_RETRY_CAP_MS);
  });
});
