/**
 * True for a JSON object: not null, not an array. The guard an adapter puts in front of a file or
 * a CLI answer it parsed, before it reads a field off it.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
