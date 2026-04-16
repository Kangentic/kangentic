type AgeLevel = 'fresh' | 'aging' | 'stale';

function getAgeLevel(archivedAt: string): AgeLevel {
  const hoursAgo = (Date.now() - new Date(archivedAt).getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 24) return 'fresh';
  if (hoursAgo < 24 * 7) return 'aging';
  return 'stale';
}

/**
 * Colored dot shown next to an archived task's timestamp when the
 * task's agent session is old enough that Restore might fail (agent
 * CLIs garbage-collect their on-disk session files after a while).
 *
 * Three states:
 *   - fresh (< 24h)     -> renders nothing
 *   - aging (24h - 7d)  -> yellow dot, "Session may need to be re-created"
 *   - stale (> 7d)      -> gray dot, "Session may be expired"
 *
 * Only fires for archived tasks. Active tasks use their session
 * directly, no restoration involved.
 */
export function StaleTaskWarning({ archivedAt }: { archivedAt: string }) {
  const level = getAgeLevel(archivedAt);
  if (level === 'fresh') return null;
  const color = level === 'aging' ? 'bg-yellow-400/70' : 'bg-fg-disabled';
  const tooltip = level === 'aging' ? 'Session may need to be re-created' : 'Session may be expired';
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${color} mr-1.5 flex-shrink-0`}
      title={tooltip}
    />
  );
}
