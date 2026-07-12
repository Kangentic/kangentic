/**
 * The single `isJsonValue` runtime check, shared by framing.ts (validating a
 * whole decoded BridgeMessage) and payloads.ts (validating one verb's
 * request payload before a handler trusts it). Split out so neither module
 * has to re-derive the other's copy.
 */
import type { JsonValue } from './messages';

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === 'boolean' || valueType === 'number' || valueType === 'string') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (valueType === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
