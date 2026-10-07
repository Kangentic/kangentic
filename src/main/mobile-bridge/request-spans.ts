/**
 * Timed spans a capability handler records about one phone request, collected
 * by the service when it sends that request's response and printed on the
 * slow-request line. It exists so a handler can say where its own time went
 * (the terminal seed's settle plus serialize, say) without every handler
 * signature growing a timing parameter: the request is keyed by device and
 * requestId, which both the handler and the service already hold.
 *
 * Bounded: a span recorded for a request whose response is never collected
 * (the session dropped mid-dispatch) is evicted oldest-first once
 * MAX_TRACKED_REQUESTS is reached, so a dead session cannot grow the map.
 */

const MAX_TRACKED_REQUESTS = 256;

const spansByRequest = new Map<string, string[]>();

function requestKey(deviceId: string, requestId: string): string {
  return `${deviceId}\u0000${requestId}`;
}

/** Records one span, e.g. `seed 412 ms, 183 kB`, against a request still in flight. */
export function noteRequestSpan(deviceId: string, requestId: string, span: string): void {
  const key = requestKey(deviceId, requestId);
  const existing = spansByRequest.get(key);
  if (existing) {
    existing.push(span);
    return;
  }
  if (spansByRequest.size >= MAX_TRACKED_REQUESTS) {
    const oldestKey = spansByRequest.keys().next().value;
    if (oldestKey !== undefined) spansByRequest.delete(oldestKey);
  }
  spansByRequest.set(key, [span]);
}

/** Returns and forgets every span recorded for a request. */
export function takeRequestSpans(deviceId: string, requestId: string): string[] {
  const key = requestKey(deviceId, requestId);
  const spans = spansByRequest.get(key) ?? [];
  spansByRequest.delete(key);
  return spans;
}

export function resetRequestSpansForTests(): void {
  spansByRequest.clear();
}
