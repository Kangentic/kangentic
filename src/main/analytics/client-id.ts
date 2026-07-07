import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { machineId } from 'node-machine-id';

const APP_SALT = 'kangentic-analytics-v1';

/**
 * Upper bound on the OS machine-id lookup. `machineId()` shells out to a
 * subprocess (`reg.exe` on Windows, `ioreg` on macOS, a dbus file read on
 * Linux) with no timeout of its own, so a locked-down or AV-intercepted
 * environment can hang it indefinitely. A hang here would stall the whole
 * startup analytics path (app_launch, the heartbeat interval, the powerMonitor
 * listeners), so cap it and fall back to a random id on timeout.
 */
const MACHINE_ID_TIMEOUT_MS = 3000;

interface ClientIdCache {
  clientId: string;
}

/** Reject after `timeoutMs` so a hung machine-id lookup can't stall startup. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('machineId timed out')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Derive a stable, anonymous per-user client id from the OS machine id
 * (already SHA-256-hashed by node-machine-id) and the OS home directory
 * (hashed here so the raw path, which contains the username, is never used
 * directly). HMAC'd with a fixed app salt so the result is not correlatable
 * with the raw machine id across other apps that also read it.
 *
 * Stable across app updates and a clean uninstall/reinstall (the machine id
 * is tied to the OS install, not our app's data), and distinct per OS user on
 * a shared machine.
 */
export function deriveClientId(machineIdValue: string, homeDir: string): string {
  const homeDigest = createHash('sha256').update(homeDir).digest('hex');
  return createHmac('sha256', APP_SALT).update(`${machineIdValue}:${homeDigest}`).digest('hex');
}

/**
 * Resolve (and cache) the anonymous client id. Cached in `cacheFilePath`
 * purely as a launch-time optimization. The OS machine id remains the source
 * of truth, so a missing or corrupt cache just re-derives the same value.
 * Falls back to a persisted random id if the OS machine-id source is
 * unavailable (hardened/containerized environments), so startup never fails.
 */
export async function resolveClientId(homeDir: string, cacheFilePath: string): Promise<string> {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8')) as ClientIdCache;
    // Guard the type explicitly: a corrupt cache with a non-string clientId
    // (e.g. a number) would otherwise be returned as-is, breaking the
    // Promise<string> contract. On any mismatch, fall through and re-derive.
    if (typeof cached.clientId === 'string' && cached.clientId) return cached.clientId;
  } catch {
    // No cache yet, or unreadable. Derive fresh below.
  }

  let clientId: string;
  try {
    const machineIdValue = await withTimeout(machineId(), MACHINE_ID_TIMEOUT_MS);
    clientId = deriveClientId(machineIdValue, homeDir);
  } catch {
    clientId = randomUUID();
  }

  try {
    fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    fs.writeFileSync(cacheFilePath, JSON.stringify({ clientId }));
  } catch {
    // Best-effort cache; if the write fails we just re-derive next launch.
  }

  return clientId;
}
