import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * settings_snapshot: once per app run, which GLOBAL settings differ from their
 * defaults. The allowlist in src/main/analytics/settings-snapshot.ts is a
 * security control before it is a budget one, so the load-bearing assertions
 * here are about what can NEVER reach the wire:
 *
 *   - only allowlisted keys, every one of them `scope: 'global'` in the
 *     settings registry (there is always a value to read with no project open);
 *   - never a free-text key (server URLs and auth, relay URLs, CLI paths, init
 *     scripts, shortcuts);
 *   - never a raw stored value outside an entry's closed shape - a junk value
 *     under an allowlisted key reads as the literal `other`;
 *   - never a property key over Aptabase's 40-character cap, which would make
 *     the server reject the WHOLE event.
 */

const mocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: mocks.trackEvent,
}));

import {
  SETTINGS_SNAPSHOT_ALLOWLIST,
  SNAPSHOT_OTHER,
  MAX_ANALYTICS_PROPERTY_KEY_LENGTH,
  buildSettingsSnapshot,
  trackSettingsSnapshot,
  snapshotPropKey,
  bucketConcurrentSessions,
  bucketIdleTimeoutMinutes,
  bucketDeviationCount,
} from '../../src/main/analytics/settings-snapshot';
import { resolveBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';
import { resolveRelayMode } from '../../src/shared/relay';
import { SETTINGS_REGISTRY } from '../../src/renderer/components/settings/settings-registry';
import { SETTINGS_TABS } from '../../src/renderer/components/settings/settings-tabs';
import { DEFAULT_CONFIG, type AppConfig } from '../../src/shared/types';

/**
 * Keys that carry paths, hostnames, or credentials. This list is the reason
 * the allowlist exists; it is pinned here so an allowlist entry can never be
 * added for one of them without this test going red.
 */
const NEVER_SNAPSHOT = [
  'agent.executionServerUrl',
  'agent.executionServerAuth',
  'agent.cliPaths',
  'mobileBridge.relayUrl',
  'browser.defaultUrl',
  'git.copyFiles',
  'git.initScript',
  'terminal.colors',
  'shortcuts',
  'hotkeys',
];

const JUNK_URL = 'wss://leak.example.internal:8443/token';
const JUNK_PATH = 'C:\\Users\\dev\\secret';

const tabCategoryById = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, tab.category]));
const registryById = Object.fromEntries(SETTINGS_REGISTRY.map((entry) => [entry.id, entry]));

/** Write `value` at a dotted path on a deep clone of `config`. Every
 *  allowlisted id is also its config path, which is what makes a generic
 *  junk-injection probe possible. */
function withPath(config: AppConfig, dottedPath: string, value: unknown): AppConfig {
  const clone = structuredClone(config) as unknown as Record<string, unknown>;
  const segments = dottedPath.split('.');
  let cursor: Record<string, unknown> = clone;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== 'object' || next === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return clone as unknown as AppConfig;
}

function readPath(config: AppConfig, dottedPath: string): unknown {
  let cursor: unknown = config;
  for (const segment of dottedPath.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Every allowlisted setting moved off its default. */
function fullyDeviatedConfig(): AppConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    animationsEnabled: false,
    windowLightDismiss: 'all',
    agent: {
      ...DEFAULT_CONFIG.agent,
      maxConcurrentSessions: 2,
      queueOverflow: 'reject',
      autoResumeSessionsOnRestart: false,
      idleTimeoutMinutes: 30,
    },
    memory: {
      indexingEnabled: false,
      semanticEnabled: true,
      embeddingModel: 'bge-small',
      acceleration: 'cpu',
    },
    browserAutomation: {
      enabled: false,
      allowEval: true,
      restrictNavigationToLocalhost: true,
    },
    mobileBridge: {
      enabled: true,
      relayMode: 'custom',
      relayUrl: JUNK_URL,
    },
    dictation: {
      ...DEFAULT_CONFIG.dictation,
      language: 'de',
    },
  };
}

beforeEach(() => {
  mocks.trackEvent.mockClear();
});

describe('the allowlist stays pinned to the settings registry', () => {
  it('is non-empty and every id is unique', () => {
    expect(SETTINGS_SNAPSHOT_ALLOWLIST.length).toBeGreaterThan(0);
    const ids = SETTINGS_SNAPSHOT_ALLOWLIST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every id is a registry entry with scope global in a system tab, so there is a value to read with no project open', () => {
    const problems: string[] = [];
    for (const entry of SETTINGS_SNAPSHOT_ALLOWLIST) {
      const registryEntry = registryById[entry.id];
      if (!registryEntry) {
        problems.push(`${entry.id}: not in SETTINGS_REGISTRY (stale allowlist entry)`);
        continue;
      }
      if (registryEntry.scope !== 'global') {
        problems.push(`${entry.id}: scope ${registryEntry.scope}, a once-per-run snapshot has no project to read it from`);
      }
      if (tabCategoryById[registryEntry.tabId] !== 'system') {
        problems.push(`${entry.id}: tab ${registryEntry.tabId} is not a system tab`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('never lists a free-text key', () => {
    const ids = new Set(SETTINGS_SNAPSHOT_ALLOWLIST.map((entry) => entry.id));
    for (const forbidden of NEVER_SNAPSHOT) {
      expect(ids.has(forbidden), `${forbidden} must never be snapshotted`).toBe(false);
    }
  });

  it('reads its defaults from DEFAULT_CONFIG for every key that has one, so a default flip cannot make unchanged users look deviated', () => {
    for (const entry of SETTINGS_SNAPSHOT_ALLOWLIST) {
      const configured = readPath(DEFAULT_CONFIG, entry.id);
      if (configured === undefined) continue; // resolver-defaulted, pinned below
      expect(entry.defaultValue, entry.id).toBe(configured);
    }
  });

  it('matches the resolvers for the four keys DEFAULT_CONFIG deliberately leaves unset', () => {
    const byId = Object.fromEntries(SETTINGS_SNAPSHOT_ALLOWLIST.map((entry) => [entry.id, entry]));
    const resolved = resolveBrowserAutomationConfig(undefined);
    expect(byId['browserAutomation.enabled'].defaultValue).toBe(resolved.enabled);
    expect(byId['browserAutomation.allowEval'].defaultValue).toBe(resolved.allowEval);
    expect(byId['browserAutomation.restrictNavigationToLocalhost'].defaultValue).toBe(
      resolved.restrictNavigationToLocalhost,
    );
    expect(byId['mobileBridge.relayMode'].defaultValue).toBe(resolveRelayMode(undefined));
  });
});

describe('wire shape', () => {
  it('keeps every property key at or under the Aptabase cap, and the event name under 60', () => {
    for (const entry of SETTINGS_SNAPSHOT_ALLOWLIST) {
      const key = snapshotPropKey(entry);
      expect(key.length, `${key} is ${key.length} chars`).toBeLessThanOrEqual(MAX_ANALYTICS_PROPERTY_KEY_LENGTH);
      expect(key).not.toBe('deviations');
    }
    expect('settings_snapshot'.length).toBeLessThanOrEqual(60);
  });

  it('shortens the one registry id that is over the cap, which would otherwise make the server drop the whole event', () => {
    const entry = SETTINGS_SNAPSHOT_ALLOWLIST.find(
      (candidate) => candidate.id === 'browserAutomation.restrictNavigationToLocalhost',
    );
    expect(entry).toBeDefined();
    expect(entry!.id.length).toBeGreaterThan(MAX_ANALYTICS_PROPERTY_KEY_LENGTH);
    expect(snapshotPropKey(entry!)).toBe('browserAutomation.localhostOnly');
  });
});

describe('buildSettingsSnapshot', () => {
  it('is empty for the defaults', () => {
    expect(buildSettingsSnapshot(DEFAULT_CONFIG)).toEqual({});
  });

  it('sends exactly the deviated keys, numerics bucketed, booleans as strings', () => {
    expect(buildSettingsSnapshot(fullyDeviatedConfig())).toEqual({
      'memory.indexingEnabled': 'false',
      'memory.semanticEnabled': 'true',
      'memory.embeddingModel': 'bge-small',
      'memory.acceleration': 'cpu',
      'agent.maxConcurrentSessions': '1-3',
      'agent.queueOverflow': 'reject',
      'agent.autoResumeSessionsOnRestart': 'false',
      'agent.idleTimeoutMinutes': '16-60',
      'browserAutomation.enabled': 'false',
      'browserAutomation.allowEval': 'true',
      'browserAutomation.localhostOnly': 'true',
      'mobileBridge.relayMode': 'custom',
      'dictation.language': 'de',
      windowLightDismiss: 'all',
      animationsEnabled: 'false',
    });
  });

  it('never emits a raw number', () => {
    const snapshot = buildSettingsSnapshot(fullyDeviatedConfig());
    for (const [key, value] of Object.entries(snapshot)) {
      expect(typeof value, key).toBe('string');
      expect(/^\d+$/.test(value), `${key} carries a raw number: ${value}`).toBe(false);
    }
  });

  it('never emits a key outside the allowlist, even when every free-text key is populated', () => {
    let config = fullyDeviatedConfig();
    for (const forbidden of NEVER_SNAPSHOT) {
      config = withPath(config, forbidden, JUNK_URL);
    }
    const allowedKeys = new Set(SETTINGS_SNAPSHOT_ALLOWLIST.map(snapshotPropKey));
    const snapshot = buildSettingsSnapshot(config);
    for (const key of Object.keys(snapshot)) {
      expect(allowedKeys.has(key), `${key} is not an allowlisted wire key`).toBe(true);
    }
    expect(JSON.stringify(snapshot)).not.toContain('leak.example');
  });

  it('turns a junk value under ANY allowlisted key into the literal other, never the stored text', () => {
    // A hand-edited or corrupted config can put anything under an allowlisted
    // key. This probes every entry with every junk shape so a future entry
    // cannot opt out of the closed-shape rule by omission.
    const junkValues: unknown[] = [JUNK_URL, JUNK_PATH, 'not-a-known-value', { nested: JUNK_URL }];
    for (const entry of SETTINGS_SNAPSHOT_ALLOWLIST) {
      for (const junk of junkValues) {
        const snapshot = buildSettingsSnapshot(withPath(DEFAULT_CONFIG, entry.id, junk));
        const serialized = JSON.stringify(snapshot);
        expect(serialized, `${entry.id} leaked ${String(junk)}`).not.toContain('leak.example');
        expect(serialized, `${entry.id} leaked a path`).not.toContain('Users');
        expect(serialized, `${entry.id} leaked an unknown value`).not.toContain('not-a-known-value');
        expect(snapshot[snapshotPropKey(entry)], `${entry.id} with ${String(junk)}`).toBe(SNAPSHOT_OTHER);
      }
    }
  });

  it('never emits a non-finite number: it reads as other, or as unset where a resolver treats a falsy value as absent', () => {
    // NaN is falsy, so the relay resolver reads it as "no mode stored" and
    // falls back to hosted (the default, so nothing is sent). Either outcome
    // keeps the invariant that matters: the raw value never leaves.
    for (const entry of SETTINGS_SNAPSHOT_ALLOWLIST) {
      const snapshot = buildSettingsSnapshot(withPath(DEFAULT_CONFIG, entry.id, Number.NaN));
      const emitted = snapshot[snapshotPropKey(entry)];
      expect([SNAPSHOT_OTHER, undefined], `${entry.id} with NaN emitted ${String(emitted)}`).toContain(emitted);
      expect(JSON.stringify(snapshot)).not.toContain('NaN');
    }
  });

  it('reads the relay mode the build honors: a bare relayUrl means custom, a stored local runs as hosted outside a dev build', () => {
    const inferredCustom = buildSettingsSnapshot({
      ...DEFAULT_CONFIG,
      mobileBridge: { enabled: false, relayUrl: JUNK_URL },
    });
    expect(inferredCustom).toEqual({ 'mobileBridge.relayMode': 'custom' });

    // vitest pins __KANGENTIC_DEV__ to false, the production build.
    const storedLocal = buildSettingsSnapshot({
      ...DEFAULT_CONFIG,
      mobileBridge: { enabled: false, relayMode: 'local', relayUrl: '' },
    });
    expect(storedLocal).toEqual({});
  });

  it('compares the raw number to the default, so a value inside the default bucket range is still a deviation', () => {
    const snapshot = buildSettingsSnapshot(withPath(DEFAULT_CONFIG, 'agent.maxConcurrentSessions', 6));
    expect(snapshot).toEqual({ 'agent.maxConcurrentSessions': '4-7' });
  });
});

describe('trackSettingsSnapshot', () => {
  it('sends one event with a zero deviations bucket for an all-defaults config', () => {
    trackSettingsSnapshot({ load: () => DEFAULT_CONFIG });
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.trackEvent).toHaveBeenCalledWith('settings_snapshot', { deviations: '0' });
  });

  it('sends the deviations beside their bucketed count', () => {
    trackSettingsSnapshot({ load: () => fullyDeviatedConfig() });
    const [, props] = mocks.trackEvent.mock.calls[0];
    expect(props).toMatchObject({ deviations: '6+', 'memory.semanticEnabled': 'true' });
  });

  it('never throws when the config cannot be read; it warns and sends nothing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      trackSettingsSnapshot({
        load: () => {
          throw new Error('EACCES');
        },
      }),
    ).not.toThrow();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[ANALYTICS] settings_snapshot failed:', expect.any(Error));
    warnSpy.mockRestore();
  });
});

describe('buckets', () => {
  it('bucketConcurrentSessions excludes the default from every range label', () => {
    expect(bucketConcurrentSessions(1)).toBe('1-3');
    expect(bucketConcurrentSessions(3)).toBe('1-3');
    expect(bucketConcurrentSessions(4)).toBe('4-7');
    expect(bucketConcurrentSessions(7)).toBe('4-7');
    expect(bucketConcurrentSessions(8)).toBe('8');
    expect(bucketConcurrentSessions(9)).toBe('9-12');
    expect(bucketConcurrentSessions(12)).toBe('9-12');
    expect(bucketConcurrentSessions(13)).toBe('13-16');
    expect(bucketConcurrentSessions(16)).toBe('13-16');
    expect(bucketConcurrentSessions(17)).toBe('17+');
    expect(bucketConcurrentSessions(64)).toBe('17+');
  });

  it('bucketIdleTimeoutMinutes', () => {
    expect(bucketIdleTimeoutMinutes(0)).toBe('0');
    expect(bucketIdleTimeoutMinutes(1)).toBe('1-15');
    expect(bucketIdleTimeoutMinutes(15)).toBe('1-15');
    expect(bucketIdleTimeoutMinutes(16)).toBe('16-60');
    expect(bucketIdleTimeoutMinutes(60)).toBe('16-60');
    expect(bucketIdleTimeoutMinutes(61)).toBe('61+');
  });

  it('bucketDeviationCount', () => {
    expect(bucketDeviationCount(0)).toBe('0');
    expect(bucketDeviationCount(1)).toBe('1');
    expect(bucketDeviationCount(2)).toBe('2');
    expect(bucketDeviationCount(3)).toBe('3-5');
    expect(bucketDeviationCount(5)).toBe('3-5');
    expect(bucketDeviationCount(6)).toBe('6+');
    expect(bucketDeviationCount(15)).toBe('6+');
  });
});
