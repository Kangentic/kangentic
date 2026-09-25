// Shares a project's IdP (Google, etc.) login across its tasks while keeping each
// task's localhost dev-app session isolated.
//
// The mechanism, in one picture:
//
//   task jar A ──writeback (non-local adds)──▶  project IDENTITY jar
//   task jar B ──writeback (non-local adds)──▶  (persist:kng-<projectId>-identity)
//      ▲                                                  │
//      └────────── load-boundary sync (non-local) ────────┘
//
// A sign-in in any task's pane mirrors its NON-localhost cookies into the project
// identity jar. Every time a task's pane or lane binds its jar, it first syncs the
// identity jar's non-localhost cookies in, so a task opened (or reopened, or
// opened after a restart) is already signed in with whatever the project last
// signed into. localhost cookies are never copied in either direction, so two
// tasks' dev servers never clobber each other's session.
//
// Deliberately ADD-ONLY: a sign-OUT is not propagated (Clear Browser Data is the
// explicit wipe-everywhere path), and the identity jar carries NO listener, so
// the only way out of it is the explicit sync. A write-suppression guard covers a
// programmatic sync's writes; the suppression window is best-effort against
// Chromium's async `changed` delivery, so a late echo can re-add an identical
// cookie to the identity jar - idempotent, and loop-free either way because the
// identity jar itself has no listener.

import { session, type Session } from 'electron';
import {
  BROWSER_PARTITION,
  browserPartitionForProjectIdentity,
} from '../../shared/browser-partition';
import { cookieToSetDetails, copyCookies, isLocalCookieDomain } from './cookie-seed';

/** Coalesces concurrent syncs of the same task partition. */
const syncInFlight = new Map<string, Promise<void>>();
/** Task partitions that already carry a write-back listener. */
const writebackInstalled = new Set<string>();
/** Task partitions whose write-back is suppressed during a programmatic sync. */
const suppressWriteback = new Set<string>();
/** Debounced identity-jar flush timers, keyed by the SOURCE task partition. */
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

const FLUSH_DEBOUNCE_MS = 2000;

/** True for the partitions that must never be seeded from, mirrored to, or given
 *  a write-back listener: the identity jar itself, and the legacy shared jar. */
function isHubPartition(partition: string, identityPartition: string): boolean {
  return partition === identityPartition || partition === BROWSER_PARTITION;
}

function scheduleIdentityFlush(sourcePartition: string, identitySession: Session): void {
  const existing = flushTimers.get(sourcePartition);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    flushTimers.delete(sourcePartition);
    void identitySession.cookies.flushStore().catch(() => {
      // Best-effort durability; the in-memory copy still serves this run.
    });
  }, FLUSH_DEBOUNCE_MS);
  // Never keep the process alive just for a pending cookie flush.
  (timer as { unref?: () => void }).unref?.();
  flushTimers.set(sourcePartition, timer);
}

/**
 * Install the one-way write-back listener on a task jar: a non-localhost
 * cookie ADD (a sign-in, or a Google token rotation) is mirrored into the project
 * identity jar. Idempotent per partition. No-op for the hub partitions. Never
 * mirrors a removal (add-only), and is suppressed while a programmatic sync is
 * writing into this jar so a synced cookie does not echo straight back.
 */
export function installIdentityWriteback(partition: string, projectId: string): void {
  const identityPartition = browserPartitionForProjectIdentity(projectId);
  if (isHubPartition(partition, identityPartition)) return;
  if (writebackInstalled.has(partition)) return;
  writebackInstalled.add(partition);

  const jar = session.fromPartition(partition);
  const identitySession = session.fromPartition(identityPartition);

  jar.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed) return; // add-only: sign-out propagation is intentionally out of scope
    if (suppressWriteback.has(partition)) return; // our own sync write, not a user change
    if (isLocalCookieDomain(cookie.domain ?? '')) return;
    const translated = cookieToSetDetails(cookie, Math.floor(Date.now() / 1000));
    if ('skipReason' in translated) return;
    void identitySession.cookies
      .set(translated.details)
      .then(() => scheduleIdentityFlush(partition, identitySession))
      .catch(() => {
        // A single failed mirror is not worth surfacing; the next change retries.
      });
  });
}

async function runSync(partition: string, identityPartition: string, projectId: string): Promise<void> {
  try {
    const identitySession = session.fromPartition(identityPartition);
    const jar = session.fromPartition(partition);
    // Install the write-back BEFORE the seed copy: installation must not depend
    // on the copy succeeding, or a transient identity-jar read failure would
    // leave this task's sign-ins unmirrored for the rest of the process. The
    // suppression below covers the copy's own writes either way.
    installIdentityWriteback(partition, projectId);
    suppressWriteback.add(partition);
    try {
      await copyCookies(identitySession, jar, { excludeLocal: true });
    } finally {
      suppressWriteback.delete(partition);
    }
  } catch (error) {
    console.warn(`[browser-pane] jar sync failed for ${partition}:`, error);
  }
}

/**
 * Sync the project identity jar's non-localhost cookies into a task jar, then
 * ensure the write-back listener is installed. Run on every pane/lane bind (a
 * load boundary), so a reopened or freshly created task picks up a sign-in made
 * in another session. No-op when there is no project id or the partition IS the
 * identity/legacy jar (nothing to seed a hub jar from).
 * Idempotent, serialized per partition, never throws.
 */
export async function syncJarFromIdentity(
  partition: string,
  projectId: string | null,
): Promise<void> {
  if (!projectId) return;
  const identityPartition = browserPartitionForProjectIdentity(projectId);
  if (isHubPartition(partition, identityPartition)) return;

  const inFlight = syncInFlight.get(partition);
  if (inFlight) return inFlight;

  const run = runSync(partition, identityPartition, projectId);
  syncInFlight.set(partition, run);
  try {
    await run;
  } finally {
    syncInFlight.delete(partition);
  }
}
