/**
 * The version gate on helper methods (task #1227). The app talks to programs older than itself until a busy
 * host swaps, and on a host shared by two computers on different versions. `HELPER_METHOD_SINCE` is what
 * `RemoteHostService.supports` reads, so an entry newer than the release that shipped the method would hold
 * it back from programs that have it, and one older than the floor would send it to programs that do not.
 *
 * What a user loses if it breaks: a new helper method sent to an older program on their host, answered
 * "unknown method", or a fix held back from a program that has it.
 */
import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/shared/announcements';
import { HELPER_METHOD_SINCE, OLDEST_HOST_PROGRAM_VERSION } from '../../src/main/remote/protocol/messages';

describe('helper methods and the program versions that have them', () => {
  it('pins the oldest program the app talks to: 0.58.0, the first release with SSH hosts and programInfo', () => {
    expect(OLDEST_HOST_PROGRAM_VERSION).toBe('0.58.0');
    // Every version the app can meet must be able to say which it is.
    expect(HELPER_METHOD_SINCE.programInfo).toBe(OLDEST_HOST_PROGRAM_VERSION);
  });

  it('names no method as older than the floor', () => {
    const older = Object.entries(HELPER_METHOD_SINCE).filter(([, since]) => compareVersions(since, OLDEST_HOST_PROGRAM_VERSION) < 0);
    expect(older).toEqual([]);
  });

  it('gates retireIfIdle on the release that adds it, so a pre-update program is stopped by its pid instead', () => {
    expect(HELPER_METHOD_SINCE.retireIfIdle).toBe('0.65.0');
    expect(compareVersions('0.64.0', HELPER_METHOD_SINCE.retireIfIdle)).toBeLessThan(0);
  });
});
