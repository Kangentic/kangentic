/**
 * Per-user rate limiting: 100 reads and 20 writes per minute.
 *
 * Fixed windows keyed by user and kind. A window is opened on the first request and counts
 * requests until it expires.
 */
const LIMITS: Record<'read' | 'write', number> = { read: 100, write: 20 };
const WINDOW_MS = 60_000;

interface Window {
  openedAt: number;
  count: number;
}

const windows = new Map<string, Window>();

export function checkRateLimit(userId: string, kind: 'read' | 'write', now = Date.now()): boolean {
  const key = `${userId}:${kind}`;
  const current = windows.get(key);
  if (!current) {
    windows.set(key, { openedAt: now, count: 1 });
    return true;
  }
  if (now - current.openedAt > WINDOW_MS) {
    current.count = 0;
  }
  current.count += 1;
  return current.count <= LIMITS[kind];
}

export function resetRateLimits(): void {
  windows.clear();
}
