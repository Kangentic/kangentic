/**
 * The retired idle-timeout encoding (0 = off, minutes > 0 = on) read once
 * into the switch plus minutes that replaced it. ConfigManager's own tests
 * drive it through a real config file; these pin the pure rules.
 */
import { describe, it, expect } from 'vitest';
import { legacyIdleTimeoutIsOn, migrateLegacyIdleTimeout } from '../../src/main/config/legacy-idle-timeout';

const DEFAULT_MINUTES = 30;

describe('legacyIdleTimeoutIsOn', () => {
  it('is on only for a positive number of minutes', () => {
    expect(legacyIdleTimeoutIsOn(1)).toBe(true);
    expect(legacyIdleTimeoutIsOn(90)).toBe(true);
    expect(legacyIdleTimeoutIsOn(0)).toBe(false);
    expect(legacyIdleTimeoutIsOn(-5)).toBe(false);
    expect(legacyIdleTimeoutIsOn(null)).toBe(false);
    expect(legacyIdleTimeoutIsOn('15')).toBe(false);
  });
});

describe('migrateLegacyIdleTimeout', () => {
  it('turns a saved timeout into the switch on, keeping the minutes', () => {
    const agent: Record<string, unknown> = { idleTimeoutEnabled: false, idleTimeoutMinutes: 20 };

    const changed = migrateLegacyIdleTimeout(agent, { idleTimeoutMinutes: 20 }, DEFAULT_MINUTES);

    expect(changed).toBe(true);
    expect(agent).toEqual({ idleTimeoutEnabled: true, idleTimeoutMinutes: 20 });
  });

  it('turns a saved 0 into the switch off with the default minutes', () => {
    const agent: Record<string, unknown> = { idleTimeoutEnabled: false, idleTimeoutMinutes: 0 };

    const changed = migrateLegacyIdleTimeout(agent, { idleTimeoutMinutes: 0 }, DEFAULT_MINUTES);

    expect(changed).toBe(true);
    expect(agent).toEqual({ idleTimeoutEnabled: false, idleTimeoutMinutes: DEFAULT_MINUTES });
  });

  it('changes nothing when the file already saved the switch', () => {
    const agent: Record<string, unknown> = { idleTimeoutEnabled: false, idleTimeoutMinutes: 20 };

    const changed = migrateLegacyIdleTimeout(
      agent,
      { idleTimeoutEnabled: false, idleTimeoutMinutes: 20 },
      DEFAULT_MINUTES,
    );

    expect(changed).toBe(false);
    expect(agent).toEqual({ idleTimeoutEnabled: false, idleTimeoutMinutes: 20 });
  });

  it('changes nothing when the file never saved a timeout', () => {
    const agent: Record<string, unknown> = { idleTimeoutEnabled: false, idleTimeoutMinutes: DEFAULT_MINUTES };

    expect(migrateLegacyIdleTimeout(agent, { maxConcurrentSessions: 4 }, DEFAULT_MINUTES)).toBe(false);
    expect(migrateLegacyIdleTimeout(agent, undefined, DEFAULT_MINUTES)).toBe(false);
    expect(agent).toEqual({ idleTimeoutEnabled: false, idleTimeoutMinutes: DEFAULT_MINUTES });
  });
});
