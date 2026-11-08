/**
 * The shared notification decisions, plus the scan that keeps Mute total: every read
 * of the settings that decides an event goes through `effectiveNotificationConfig`.
 * A new event added with a raw read would keep notifying through Mute.
 *
 * Tier: Unit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_EVENT_KEYS,
  desktopSoundPlan,
  effectiveNotificationConfig,
  resolveEventSound,
} from '../../src/shared/notification-settings';
import { DEFAULT_CONFIG, type NotificationConfig } from '../../src/shared/types';

const defaults = (): NotificationConfig => structuredClone(DEFAULT_CONFIG.notifications);

describe('effectiveNotificationConfig', () => {
  it('returns the settings as saved when not muted', () => {
    const config = defaults();
    expect(effectiveNotificationConfig(config)).toBe(config);
  });

  it('turns every event off on both channels while muted, and leaves the rest alone', () => {
    const config = { ...defaults(), muted: true };
    const effective = effectiveNotificationConfig(config);

    for (const eventKey of NOTIFICATION_EVENT_KEYS) {
      expect(effective.desktop[eventKey]).toBe(false);
      expect(effective.toasts[eventKey]).toBe(false);
    }
    expect(effective.toasts.durationSeconds).toBe(config.toasts.durationSeconds);
    expect(effective.cooldownSeconds).toBe(config.cooldownSeconds);
  });

  it('never changes the saved switches, so they return when Mute is turned off', () => {
    const config = { ...defaults(), muted: true };
    effectiveNotificationConfig(config);
    expect(config.desktop.onAgentIdle).toBe(true);
  });

  it('declares every event the config has', () => {
    const configKeys = Object.keys(DEFAULT_CONFIG.notifications.desktop);
    expect([...NOTIFICATION_EVENT_KEYS].sort()).toEqual(configKeys.sort());
    expect(Object.keys(DEFAULT_CONFIG.notifications.sounds).sort()).toEqual(configKeys.sort());
  });
});

describe('resolveEventSound', () => {
  it('is the saved choice', () => {
    const config = defaults();
    config.sounds.onAgentCrash = 'fall';
    expect(resolveEventSound(config, 'onAgentCrash')).toBe('fall');
  });

  it('is off while muted', () => {
    const config = { ...defaults(), muted: true };
    config.sounds.onAgentCrash = 'fall';
    expect(resolveEventSound(config, 'onAgentCrash')).toBe('off');
  });

  it('is off for a custom choice with no file behind it', () => {
    const config = defaults();
    config.sounds.onAgentCrash = 'custom';
    expect(resolveEventSound(config, 'onAgentCrash')).toBe('off');
    config.customSounds.onAgentCrash = 'gong.wav';
    expect(resolveEventSound(config, 'onAgentCrash')).toBe('custom');
  });
});

describe('desktopSoundPlan', () => {
  it.each([
    ['no event', undefined, true, { silent: undefined, playInWindow: false }],
    ['off', 'off', true, { silent: true, playInWindow: false }],
    ['system', 'system', true, { silent: false, playInWindow: false }],
    ['a sound, with a window', 'chime', true, { silent: true, playInWindow: true }],
    ['a sound, with no window', 'chime', false, { silent: false, playInWindow: false }],
    ['off, with no window', 'off', false, { silent: true, playInWindow: false }],
  ] as const)('%s', (_name, sound, hasWindow, expected) => {
    expect(desktopSoundPlan(sound, hasWindow)).toEqual(expected);
  });
});

describe('every read that decides a notification honors Mute', () => {
  const REPO_ROOT = path.resolve(__dirname, '../..');
  const RAW_READ = /\bconfig\.notifications\b|\.load\(\)\.notifications\b/;
  // Each reads settings that are not an event switch, or is the one that applies Mute.
  const ALLOWED: Record<string, RegExp> = {
    // Reads only the stack limit and the duration.
    'src/renderer/stores/toast-store.ts': /config\.notifications\.toasts;/,
    // The settings tab edits the saved values.
    'src/renderer/components/settings/tabs/NotificationsTab.tsx': /./,
    // One-time migrations write the saved value.
    'src/main/config/config-manager.ts': /this\.config\.notifications\./,
    // Sound comes through resolveEventSound, which reads `muted` itself.
    'src/renderer/utils/event-sound-player.ts': /effectiveNotificationConfig\(/,
    'src/main/ipc/register-all.ts': /effectiveNotificationConfig\(/,
    // The second is CONFIG_SET asking whether the write touched notifications at all.
    'src/main/ipc/handlers/system.ts': /effectiveNotificationConfig\(|if \(config\.notifications\) context\.appBadge\.refresh\(\)/,
  };

  function sourceFiles(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(fullPath);
      return /\.tsx?$/.test(entry.name) ? [fullPath] : [];
    });
  }

  const reads = ['src/main', 'src/renderer'].flatMap((tree) => sourceFiles(path.join(REPO_ROOT, tree))).flatMap((file) => {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    return fs.readFileSync(file, 'utf8').split('\n')
      .filter((line) => RAW_READ.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
      .map((line) => ({ relative, line: line.trim() }));
  });

  it('finds the real reads, so the scan cannot pass on an empty list', () => {
    expect(reads.some((read) => read.relative === 'src/renderer/utils/event-sound-player.ts')).toBe(true);
    expect(reads.some((read) => read.relative === 'src/main/ipc/register-all.ts')).toBe(true);
  });

  it('has no raw read outside the named exceptions', () => {
    const raw = reads.filter((read) => !ALLOWED[read.relative]?.test(read.line));
    expect(raw, 'Read notifications through effectiveNotificationConfig, or a new event misses Mute').toEqual([]);
  });
});
