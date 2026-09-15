/**
 * The runtime type-source readers fail loudly.
 *
 * These helpers exist because a `Record<keyof Swimlane, ...>` annotation in a
 * test file guards nothing: `tsconfig.json` includes only `src/**` and
 * `packages/protocol/src/**`, so `tests/` is never typechecked and the guard
 * fires in an editor and nowhere in CI. A regex scanner replaces it, which
 * trades one silent-failure mode for another: a scanner that stops matching
 * returns an empty list, and every parity test built on it then passes by
 * comparing nothing against nothing.
 *
 * So the throw IS the guarantee, and it needs its own coverage. Without these
 * cases, renaming an interface in types.ts would be caught only indirectly, and
 * a regex that under-matched would not be caught at all.
 */

import { describe, it, expect } from 'vitest';
import {
  readInterfaceFieldNames,
  readStringUnionMembers,
} from './helpers/shared-type-source';

describe('readInterfaceFieldNames', () => {
  it('reads the real Swimlane fields, in declaration order', () => {
    const fieldNames = readInterfaceFieldNames('Swimlane');

    // Spot-check both ends plus the session fields, rather than pinning the
    // whole list, which would turn every new column into a failure here.
    expect(fieldNames[0]).toBe('id');
    expect(fieldNames).toContain('session_target');
    expect(fieldNames).toContain('session_spawn_strategy');
    expect(fieldNames).toContain('created_at');
  });

  it('skips doc comments rather than reading one as a field', () => {
    // Several Swimlane fields carry a JSDoc line directly above them, which is
    // indented to the same depth as the fields themselves.
    const fieldNames = readInterfaceFieldNames('Swimlane');

    expect(fieldNames.every((fieldName) => /^[a-z_][a-z0-9_]*$/i.test(fieldName))).toBe(true);
    expect(fieldNames).not.toContain('*');
  });

  it('throws on an interface that does not exist', () => {
    expect(() => readInterfaceFieldNames('NoSuchInterface')).toThrow(/NoSuchInterface/);
  });
});

describe('readStringUnionMembers', () => {
  it('reads the unions the column parity tests compare against', () => {
    expect(readStringUnionMembers('SessionTarget')).toEqual(['isolated', 'main']);
    expect(readStringUnionMembers('SessionSpawnStrategy')).toEqual(['always_spawn_new', 'create_or_resume']);
    expect(readStringUnionMembers('AutoCommandMode')).toEqual(['deferred', 'immediate']);
  });

  it('throws on a union that does not exist', () => {
    expect(() => readStringUnionMembers('NoSuchUnion')).toThrow(/NoSuchUnion/);
  });

  it('throws for a name declared as an interface rather than a type alias', () => {
    // Returning [] here would make a parity assertion pass by comparing an
    // empty list against an empty list, which is the failure mode the whole
    // throw-on-unexpected-shape contract exists to prevent.
    expect(() => readStringUnionMembers('Swimlane')).toThrow(/Swimlane/);
  });
});
