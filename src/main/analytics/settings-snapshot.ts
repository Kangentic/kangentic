import { DEFAULT_CONFIG, type AppConfig } from '../../shared/types';
import { EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL_ID } from '../../shared/embedding-models';
import { resolveRelayMode } from '../../shared/relay';
import { resolveBrowserAutomationConfig } from '../browser/browser-automation-config';
import type { ConfigManager } from '../config/config-manager';
import { trackEvent } from './analytics';

/**
 * The settings_snapshot event: once per app run, which GLOBAL settings differ
 * from their defaults, as key/value pairs.
 *
 * A snapshot rather than a setting_changed stream, because the stream answers
 * "which settings did someone touch" (double-counting a toggle flipped back
 * and forth and never saying where it settled), while the snapshot answers
 * "what are people actually running with", which is the question that changes
 * a default. It is bounded at one event per run however much someone fiddles,
 * and sending deviations only makes the payload self-limiting; an empty
 * snapshot is itself the signal that a default is right.
 *
 * The allowlist is a SECURITY control before it is a budget one. The global
 * config carries free text (server URLs and auth, relay URLs, CLI paths, init
 * scripts, shortcuts) that must never leave the machine, so only a listed key
 * can be read, and a listed key can only leave through a closed shape: a
 * boolean, an enum drawn from a fixed set, a bucketed number, or a short
 * pattern-checked string. Anything else that reaches the wire is the literal
 * `other`, never the stored value. tests/unit/settings-snapshot.test.ts pins
 * the list against the settings registry (every id is `scope: 'global'`, so
 * there is always a value to read with no project open), against the
 * free-text denylist, and against a junk-value egress probe on every entry.
 *
 * Aptabase caps a property key at 40 characters and rejects the WHOLE event
 * past it, so one registry id carries a shorter wire name (`propKey`).
 */

type SnapshotValue = string | number | boolean | undefined;

interface SnapshotEntryBase {
  /** The settings-registry id (settings-registry.ts). Must be scope: 'global'. */
  id: string;
  /** Wire name when the registry id is over Aptabase's 40-character key cap. */
  propKey?: string;
  read: (config: AppConfig) => SnapshotValue;
}

interface BooleanEntry extends SnapshotEntryBase {
  kind: 'boolean';
  defaultValue: boolean;
}

interface EnumEntry extends SnapshotEntryBase {
  kind: 'enum';
  values: readonly string[];
  defaultValue: string;
}

interface NumberEntry extends SnapshotEntryBase {
  kind: 'number';
  defaultValue: number;
  bucket: (value: number) => string;
}

interface PatternEntry extends SnapshotEntryBase {
  kind: 'pattern';
  pattern: RegExp;
  maxLength: number;
  defaultValue: string;
}

export type SettingsSnapshotEntry = BooleanEntry | EnumEntry | NumberEntry | PatternEntry;

/** The literal sent for a stored value outside its entry's closed shape. */
export const SNAPSHOT_OTHER = 'other';

/** Aptabase's server-side cap on a property key. */
export const MAX_ANALYTICS_PROPERTY_KEY_LENGTH = 40;

/**
 * Bucket edges exclude the default (8): a label that contained the default
 * would read as if the default were being sent, when it never is. If the
 * default ever moves, 8 gets its own label rather than lying inside a range.
 */
export function bucketConcurrentSessions(value: number): string {
  if (value <= 3) return '1-3';
  if (value <= 7) return '4-7';
  if (value === 8) return '8';
  if (value <= 12) return '9-12';
  if (value <= 16) return '13-16';
  return '17+';
}

/** Default 0 (disabled) is never sent, so the buckets start at one minute. */
export function bucketIdleTimeoutMinutes(value: number): string {
  if (value <= 0) return '0';
  if (value <= 15) return '1-15';
  if (value <= 60) return '16-60';
  return '61+';
}

/** How many settings a run deviates on, as a distribution. */
export function bucketDeviationCount(count: number): string {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count === 2) return '2';
  if (count <= 5) return '3-5';
  return '6+';
}

const memoryDefaults = DEFAULT_CONFIG.memory;
const dictationDefaults = DEFAULT_CONFIG.dictation;
const browserAutomationDefaults = resolveBrowserAutomationConfig(undefined);

/**
 * Chosen because we do not know the answer today and the answer would change
 * what we build: semantic memory (zero visibility), concurrency and session
 * lifecycle, the conservative security posture of browser automation, the
 * unproven mobile relay and dictation surfaces, and two contested UX defaults.
 * Cosmetic settings, settings already carried by other events (permission
 * mode, worktrees, default agent and model on session_spawn), and every
 * free-text key stay out; `agent.executionMode` is project-scoped and needs
 * the per-project shape instead.
 */
export const SETTINGS_SNAPSHOT_ALLOWLIST: readonly SettingsSnapshotEntry[] = [
  {
    id: 'memory.indexingEnabled',
    kind: 'boolean',
    defaultValue: memoryDefaults?.indexingEnabled ?? true,
    read: (config) => config.memory?.indexingEnabled,
  },
  {
    id: 'memory.semanticEnabled',
    kind: 'boolean',
    defaultValue: memoryDefaults?.semanticEnabled ?? false,
    read: (config) => config.memory?.semanticEnabled,
  },
  {
    id: 'memory.embeddingModel',
    kind: 'enum',
    // The app's own model list, so a model added upstream counts as itself
    // rather than as `other`.
    values: EMBEDDING_MODELS.map((model) => model.id),
    defaultValue: memoryDefaults?.embeddingModel ?? DEFAULT_EMBEDDING_MODEL_ID,
    read: (config) => config.memory?.embeddingModel,
  },
  {
    id: 'memory.acceleration',
    kind: 'enum',
    values: ['auto', 'gpu', 'cpu'],
    defaultValue: memoryDefaults?.acceleration ?? 'auto',
    read: (config) => config.memory?.acceleration,
  },
  {
    id: 'agent.maxConcurrentSessions',
    kind: 'number',
    defaultValue: DEFAULT_CONFIG.agent.maxConcurrentSessions,
    bucket: bucketConcurrentSessions,
    read: (config) => config.agent?.maxConcurrentSessions,
  },
  {
    id: 'agent.queueOverflow',
    kind: 'enum',
    values: ['queue', 'reject'],
    defaultValue: DEFAULT_CONFIG.agent.queueOverflow,
    read: (config) => config.agent?.queueOverflow,
  },
  {
    id: 'agent.autoResumeSessionsOnRestart',
    kind: 'boolean',
    defaultValue: DEFAULT_CONFIG.agent.autoResumeSessionsOnRestart,
    read: (config) => config.agent?.autoResumeSessionsOnRestart,
  },
  {
    id: 'agent.idleTimeoutMinutes',
    kind: 'number',
    defaultValue: DEFAULT_CONFIG.agent.idleTimeoutMinutes,
    bucket: bucketIdleTimeoutMinutes,
    read: (config) => config.agent?.idleTimeoutMinutes,
  },
  {
    id: 'browserAutomation.enabled',
    kind: 'boolean',
    defaultValue: browserAutomationDefaults.enabled,
    read: (config) => resolveBrowserAutomationConfig(config.browserAutomation).enabled,
  },
  {
    id: 'browserAutomation.allowEval',
    kind: 'boolean',
    defaultValue: browserAutomationDefaults.allowEval,
    read: (config) => resolveBrowserAutomationConfig(config.browserAutomation).allowEval,
  },
  {
    id: 'browserAutomation.restrictNavigationToLocalhost',
    propKey: 'browserAutomation.localhostOnly',
    kind: 'boolean',
    defaultValue: browserAutomationDefaults.restrictNavigationToLocalhost,
    read: (config) =>
      resolveBrowserAutomationConfig(config.browserAutomation).restrictNavigationToLocalhost,
  },
  {
    id: 'mobileBridge.relayMode',
    kind: 'enum',
    values: ['hosted', 'local', 'custom'],
    // The build-honored mode (a stored 'local' runs as hosted outside a dev
    // build), which is what the Select and the dialer show; the pre-relayMode
    // "relayUrl set means custom" inference is applied the same way.
    defaultValue: 'hosted',
    read: (config) => resolveRelayMode(config.mobileBridge),
  },
  {
    id: 'dictation.language',
    kind: 'pattern',
    // BCP-47 shape: a 2-3 letter language, optional short subtags. Not an
    // enum because the set is model-derived, so a bare pattern plus a cap
    // keeps a mistyped or hand-edited value from carrying anything longer.
    pattern: /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/,
    maxLength: 16,
    defaultValue: dictationDefaults?.language ?? 'en',
    read: (config) => config.dictation?.language,
  },
  {
    id: 'windowLightDismiss',
    kind: 'enum',
    values: ['off', 'single', 'focused', 'all'],
    defaultValue: DEFAULT_CONFIG.windowLightDismiss,
    read: (config) => config.windowLightDismiss,
  },
  {
    id: 'animationsEnabled',
    kind: 'boolean',
    defaultValue: DEFAULT_CONFIG.animationsEnabled,
    read: (config) => config.animationsEnabled,
  },
];

/** The wire name of an allowlist entry. */
export function snapshotPropKey(entry: SettingsSnapshotEntry): string {
  return entry.propKey ?? entry.id;
}

/**
 * The value to send for one entry, or null when the stored value is absent or
 * equals its default. A stored value outside the entry's closed shape (a
 * string where a boolean belongs, an enum member the app does not know, a
 * pattern miss) is a deviation that reads as `other`: it is not the default,
 * and it is never sent verbatim.
 */
function encodeDeviation(entry: SettingsSnapshotEntry, value: SnapshotValue): string | null {
  if (value === undefined || value === null) return null;
  switch (entry.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') return SNAPSHOT_OTHER;
      return value === entry.defaultValue ? null : String(value);
    case 'enum':
      if (typeof value !== 'string' || !entry.values.includes(value)) return SNAPSHOT_OTHER;
      return value === entry.defaultValue ? null : value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return SNAPSHOT_OTHER;
      return value === entry.defaultValue ? null : entry.bucket(value);
    case 'pattern':
      if (typeof value !== 'string' || value.length > entry.maxLength || !entry.pattern.test(value)) {
        return SNAPSHOT_OTHER;
      }
      return value === entry.defaultValue ? null : value;
  }
}

/** The deviations in `config`, keyed by wire name. Empty when every listed
 *  setting is at its default. */
export function buildSettingsSnapshot(config: AppConfig): Record<string, string> {
  const props: Record<string, string> = {};
  for (const entry of SETTINGS_SNAPSHOT_ALLOWLIST) {
    const encoded = encodeDeviation(entry, entry.read(config));
    if (encoded !== null) props[snapshotPropKey(entry)] = encoded;
  }
  return props;
}

/**
 * Send the once-per-run snapshot. Reads the GLOBAL config only (never a
 * project's overrides: every listed key is global-scoped, and there may be no
 * project open). `deviations` is always present so an all-defaults run still
 * sends one event and the dashboard shows the distribution.
 */
export function trackSettingsSnapshot(configManager: Pick<ConfigManager, 'load'>): void {
  try {
    const snapshot = buildSettingsSnapshot(configManager.load());
    trackEvent('settings_snapshot', {
      ...snapshot,
      deviations: bucketDeviationCount(Object.keys(snapshot).length),
    });
  } catch (error) {
    console.warn('[ANALYTICS] settings_snapshot failed:', error);
  }
}
