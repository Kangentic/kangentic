import { promises as fsPromises, readFileSync } from 'node:fs';
import { trackEvent } from './analytics';

/**
 * The curated feature vocabulary for adoption tracking. Deliberately small:
 * each feature adds up to one `feature_used` event per user per day, so the
 * list is a budget decision, not a free enum (see docs/analytics.md's event
 * budget). Renderer-reported features arrive over IPC and are validated
 * against this list, so a compromised or drifted renderer cannot invent
 * event vocabulary.
 */
export const ANALYTICS_FEATURES = [
  'command_terminal',
  'worktree_session',
  'board_profile',
  'popout_window',
  'browser_pane',
  'mcp_server',
  'mobile_bridge',
  'usage_dashboard',
  'quick_find',
  'settings',
] as const;

export type AnalyticsFeature = (typeof ANALYTICS_FEATURES)[number];

const featureSet: ReadonlySet<string> = new Set(ANALYTICS_FEATURES);

/** Type guard for renderer-supplied feature names crossing the IPC boundary. */
export function isKnownAnalyticsFeature(value: string): value is AnalyticsFeature {
  return featureSet.has(value);
}

/**
 * Onboarding funnel steps, each fired at most once per install so the funnel
 * reads as install counts per step (where do new installs stall?).
 * `first_project` rides the project_create path; the rest ride the first task
 * create / agent spawn / done-move.
 */
export const ONBOARDING_MILESTONES = [
  'first_project',
  'first_task',
  'first_spawn',
  'first_task_complete',
] as const;

export type OnboardingMilestone = (typeof ONBOARDING_MILESTONES)[number];

interface UsageFlags {
  milestones: Partial<Record<OnboardingMilestone, true>>;
  featureFirstUse: Partial<Record<AnalyticsFeature, true>>;
  /** The app version of the previous run, for update_outcome detection. */
  lastRunVersion?: string;
}

/**
 * Lifetime once-per-install flags, persisted beside analytics-client-id.json
 * in the global config dir (NOT per-project: milestones describe the install).
 * Null until initUsageAnalytics runs; while null, lifetime-once events
 * (feature_first_use, onboarding_milestone) are skipped entirely rather than
 * fired unbounded, and only the in-memory daily-deduped feature_used flows.
 *
 * Deliberately NOT gated on whether analytics is enabled: trackEvent already
 * no-ops when disabled, and a dev/opted-out install burning its lifetime flags
 * sends nothing either way. Dev machines are not real installs; an opted-out
 * user stays opted out.
 */
let usageFlags: UsageFlags | null = null;
let usageFlagsPath: string | null = null;

/** In-memory once-per-UTC-day dedup for feature_used. Resets on app restart,
 *  which can only under-dedup (an extra event after a same-day restart), never
 *  inflate past one per feature per app run per day. */
const featureUsedDay = new Map<AnalyticsFeature, string>();

function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Serializes flag writes: two milestones landing in the same tick would
 *  otherwise race unordered writeFile calls on one path and can leave the
 *  file holding the OLDER state (or interleaved garbage). The chain keeps
 *  order; each payload is a full snapshot, so the last write wins whole. */
let pendingFlagsWrite: Promise<void> = Promise.resolve();

function persistUsageFlags(): void {
  if (!usageFlags || !usageFlagsPath) return;
  const targetPath = usageFlagsPath;
  const payload = JSON.stringify(usageFlags, null, 2);
  // Fire-and-forget like every other analytics write: losing a flag write
  // means at worst one duplicate lifetime event on a later run.
  pendingFlagsWrite = pendingFlagsWrite
    .then(() => fsPromises.writeFile(targetPath, payload, 'utf-8'))
    .catch(() => {});
}

/** A JSON object (not array/primitive) usable as a flag record; anything else
 *  falls back to empty. Field-level, because a syntactically valid file with
 *  the wrong shape (a string where a record belongs) would otherwise flow
 *  through an `as` cast and make trackMilestone's property write throw a
 *  TypeError out of its call sites (project create, startup). */
function asFlagRecord<FlagKey extends string>(value: unknown): Partial<Record<FlagKey, true>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Partial<Record<FlagKey, true>>)
    : {};
}

/**
 * Load (or create) the lifetime usage flags. Called once at startup from
 * index.ts with a path under the global config dir. Sync read: the file is a
 * few hundred bytes and startup already does sync config reads.
 */
export function initUsageAnalytics(flagsFilePath: string): void {
  usageFlagsPath = flagsFilePath;
  try {
    const parsed = JSON.parse(readFileSync(flagsFilePath, 'utf-8')) as Record<string, unknown> | null;
    const lastRunVersion = parsed?.lastRunVersion;
    usageFlags = {
      milestones: asFlagRecord<OnboardingMilestone>(parsed?.milestones),
      featureFirstUse: asFlagRecord<AnalyticsFeature>(parsed?.featureFirstUse),
      lastRunVersion: typeof lastRunVersion === 'string' ? lastRunVersion : undefined,
    };
  } catch {
    // Missing or corrupt file: start fresh. Worst case is one repeated
    // lifetime event, not data loss.
    usageFlags = { milestones: {}, featureFirstUse: {} };
  }
}

/**
 * Record one use of a curated feature. Emits `feature_used` at most once per
 * feature per UTC day, and `feature_first_use` at most once per install.
 * Fire-and-forget from any main-process call site; renderer surfaces reach
 * this through the analytics:trackFeatureUsed IPC funnel.
 */
export function trackFeatureUsed(feature: AnalyticsFeature): void {
  const day = currentUtcDay();
  if (featureUsedDay.get(feature) !== day) {
    featureUsedDay.set(feature, day);
    trackEvent('feature_used', { feature });
  }
  if (usageFlags && !usageFlags.featureFirstUse[feature]) {
    usageFlags.featureFirstUse[feature] = true;
    trackEvent('feature_first_use', { feature });
    persistUsageFlags();
  }
}

/**
 * Record an onboarding funnel step, at most once per install. No-op until
 * initUsageAnalytics has loaded the lifetime flags.
 */
export function trackMilestone(step: OnboardingMilestone): void {
  if (!usageFlags || usageFlags.milestones[step]) return;
  usageFlags.milestones[step] = true;
  trackEvent('onboarding_milestone', { step });
  persistUsageFlags();
}

/**
 * Bucket an absolute task count for board_snapshot, so board size reads as a
 * distribution without ever sending an exact per-user count.
 */
export function bucketTaskCount(count: number): string {
  if (count === 0) return '0';
  if (count <= 9) return '1-9';
  if (count <= 49) return '10-49';
  if (count <= 199) return '50-199';
  return '200+';
}

/** Numeric-tuple compare of dotted versions; non-numeric segments compare 0. */
function isVersionDowngrade(fromVersion: string, toVersion: string): boolean {
  const fromParts = fromVersion.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const toParts = toVersion.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(fromParts.length, toParts.length);
  for (let index = 0; index < length; index += 1) {
    const fromSegment = fromParts[index] ?? 0;
    const toSegment = toParts[index] ?? 0;
    if (toSegment < fromSegment) return true;
    if (toSegment > fromSegment) return false;
  }
  return false;
}

/**
 * Detect an applied update (or rollback) by comparing this run's version with
 * the persisted previous run's. Fired once per launch from index.ts. A failed
 * update never reaches here; it reports through app_error `source: 'updater'`
 * (and Sentry). First run ever just records the baseline.
 */
export function trackUpdateOutcome(currentVersion: string): void {
  if (!usageFlags) return;
  const previousVersion = usageFlags.lastRunVersion;
  if (previousVersion === currentVersion) return;
  if (previousVersion) {
    trackEvent('update_outcome', {
      result: isVersionDowngrade(previousVersion, currentVersion) ? 'rolled_back' : 'applied',
      fromVersion: previousVersion,
      toVersion: currentVersion,
    });
  }
  usageFlags.lastRunVersion = currentVersion;
  persistUsageFlags();
}

/** Reset module state between unit tests (vitest shares module instances). */
export function resetUsageAnalyticsForTests(): void {
  usageFlags = null;
  usageFlagsPath = null;
  featureUsedDay.clear();
}
