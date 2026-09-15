/**
 * Read declarations out of `src/shared/types.ts` at RUNTIME, for parity tests
 * that check a hand-maintained list against the real type.
 *
 * These tests used to make that check with a type annotation:
 * `Record<keyof Swimlane, ...>`, or `Record<SessionSpawnStrategy, true>`, whose
 * comments claim a missing member fails `npm run typecheck`. It does not.
 * `tsconfig.json` includes only `src/**` and `packages/protocol/src/**`, so
 * `tests/` is never typechecked, and those guards fire in an editor and nowhere
 * in CI. Both were, in effect, documentation.
 *
 * Making tsc cover `tests/` would be the better fix and is not a small one:
 * measured 2026-09-15, `tests/unit/**` alone produces hundreds of pre-existing
 * errors (deliberately partial mock objects, vitest `Mock` signatures, top-level
 * await under the CJS `module` setting). Until that is worth doing on its own,
 * a parity test that wants a real guarantee reads the source here instead.
 *
 * Every function throws on an unexpected shape rather than returning an empty
 * list, so a rename fails loudly instead of letting the caller's comparison pass
 * against nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

const TYPES_FILE = 'src/shared/types.ts';

function readTypesSource(): string {
  return fs.readFileSync(path.resolve(__dirname, '../../..', TYPES_FILE), 'utf-8');
}

/** Field names declared on an exported interface, in declaration order. */
export function readInterfaceFieldNames(interfaceName: string): string[] {
  const source = readTypesSource();
  const match = source.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) {
    throw new Error(`Could not find "export interface ${interfaceName}" in ${TYPES_FILE}`);
  }
  const fieldNames = Array.from(
    match[1].matchAll(/^\s{2}([a-z_][a-z0-9_]*)\??:/gim),
    (fieldMatch) => fieldMatch[1],
  );
  if (fieldNames.length === 0) {
    throw new Error(`Parsed interface ${interfaceName} in ${TYPES_FILE} but found no fields`);
  }
  return fieldNames;
}

/** Members of an exported string-literal union type, sorted. */
export function readStringUnionMembers(typeName: string): string[] {
  const source = readTypesSource();
  const match = source.match(new RegExp(`export type ${typeName} = ([^;]+);`));
  if (!match) {
    throw new Error(`Could not find "export type ${typeName}" in ${TYPES_FILE}`);
  }
  const members = Array.from(match[1].matchAll(/'([^']+)'/g), (memberMatch) => memberMatch[1]).sort();
  if (members.length === 0) {
    throw new Error(`Parsed type ${typeName} in ${TYPES_FILE} but found no string-literal members`);
  }
  return members;
}
