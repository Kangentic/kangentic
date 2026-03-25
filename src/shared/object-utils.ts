/** Retrieve a value from a nested object using a dotted key path (e.g. "terminal.fontSize"). */
export function getNestedValue(object: object, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = object;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Check whether a dotted key path exists in a nested object. */
export function hasNestedKey(object: object, keyPath: string): boolean {
  const parts = keyPath.split('.');
  let current: unknown = object;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return false;
    if (!(part in (current as Record<string, unknown>))) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

/** Remove a dotted key path from a nested object (mutates in place), then prune empty parents. */
export function removeNestedKey(object: object, keyPath: string): void {
  const parts = keyPath.split('.');
  const ancestors: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current: unknown = object;
  for (let index = 0; index < parts.length - 1; index++) {
    if (current == null || typeof current !== 'object') return;
    ancestors.push({ parent: current as Record<string, unknown>, key: parts[index] });
    current = (current as Record<string, unknown>)[parts[index]];
  }
  if (current != null && typeof current === 'object') {
    delete (current as Record<string, unknown>)[parts[parts.length - 1]];
  }
  // Prune empty parent objects bottom-up
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const { parent, key } = ancestors[index];
    const child = parent[key];
    if (child != null && typeof child === 'object' && Object.keys(child as Record<string, unknown>).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
}

/** Check if an object is a flat key-value map (all values are primitives, not nested objects/arrays). */
function isFlatMap(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (item) => item === null || typeof item !== 'object',
  );
}

/** Deep-merge source into target (returns new object). Allows null to override.
 *  Flat maps (objects with only primitive values) are replaced entirely, not merged key-by-key.
 *  This allows key deletion in flat maps like `labelColors: Record<string, string>`. */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof result[key] === 'object') {
      if (isFlatMap(value)) {
        result[key] = { ...value as Record<string, unknown> };
      } else {
        result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
      }
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/** Typed deep-merge for AppConfig (avoids `as unknown as` chains at call sites). */
export function deepMergeConfig<T extends object>(base: T, overrides: Partial<T> | Record<string, unknown>): T {
  return deepMerge(base, overrides as Partial<T>);
}

/** Simple deep equality check for plain values, arrays, and objects. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}
