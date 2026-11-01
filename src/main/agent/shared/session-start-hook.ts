import { EventType, type AdapterRuntimeStrategy, type SessionStartReport } from '../../../shared/types';

type StatusFileHook = NonNullable<AdapterRuntimeStrategy['statusFile']>;

/**
 * The SessionStart report an events.jsonl record carries
 * (`statusFile.parseSessionStart`), or null for any other record and for an
 * adapter that does not read its SessionStart hooks.
 */
function sessionStartOfRecord(statusFileHook: StatusFileHook, record: Record<string, unknown>): SessionStartReport | null {
  if (!statusFileHook.parseSessionStart) return null;
  if (record.type !== EventType.SessionStart || typeof record.hookContext !== 'string') return null;
  return statusFileHook.parseSessionStart(record.hookContext);
}

/**
 * The SessionStart report on one raw events.jsonl line, as event-bridge.js
 * writes it, or null. Most lines are tool and turn events, so a line that
 * cannot name a SessionStart is skipped before it is parsed. A torn final line,
 * normal for an append-only file being written, reads as null.
 */
export function sessionStartOfLine(statusFileHook: StatusFileHook, line: string): SessionStartReport | null {
  if (!statusFileHook.parseSessionStart || !line.includes(EventType.SessionStart)) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  return sessionStartOfRecord(statusFileHook, record as Record<string, unknown>);
}
