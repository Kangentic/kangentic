import { useMemo } from 'react';
import { queuePlaceOf, type QueuePlace } from '../../shared/queue-place';
import { useSessionStore } from '../stores/session-store';

/** Where a queued session stands in line, live. Null until main has reported it. */
export function useQueuePlace(sessionId: string | null | undefined): QueuePlace | null {
  const snapshot = useSessionStore((state) => state.queueSnapshot);
  return useMemo(() => (sessionId ? queuePlaceOf(snapshot, sessionId) : null), [snapshot, sessionId]);
}
