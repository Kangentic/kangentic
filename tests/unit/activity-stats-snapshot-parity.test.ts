import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// `ActivityStatsSnapshot` is declared twice on purpose: an engine-internal copy in
// src/main/activity-engine/engine/shapes.ts (uses named helper types like TransitionRecord and
// CompensationCounters) and an IPC payload copy in src/shared/types.ts (inlines those shapes so
// the renderer needs no engine imports). The two describe the SAME data, so their top-level
// fields must match. TypeScript does not enforce this: each interface compiles independently, so
// a field added to one copy and not the other passes typecheck silently. That happened to be the
// gap flagged in review when `idleHintPending` was added. This test is the mechanical backstop:
// it parses both files, extracts each interface's top-level field names, and fails (naming the
// divergent fields) if they drift.
//
// It compares NAMES only, not value types: the value types intentionally differ in
// representation (named vs inlined), but the set of fields is the contract that must stay aligned.
//
// The compensation counters get the same check one level down: the engine names them
// `CompensationCounters`, the IPC copy inlines them as `compensationCounters: { ... }`, and a
// counter added to one copy alone would otherwise pass this file.

const REPO_ROOT = path.resolve(__dirname, '../..');
const ENGINE_SHAPES = path.join(REPO_ROOT, 'src/main/activity-engine/engine/shapes.ts');
const SHARED_TYPES = path.join(REPO_ROOT, 'src/shared/types.ts');
const INTERFACE_NAME = 'ActivityStatsSnapshot';
const COUNTERS_INTERFACE_NAME = 'CompensationCounters';
const COUNTERS_FIELD_NAME = 'compensationCounters';

function withoutComments(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** The body between the brace that opens at `openBraceIndex` and the one that closes it. */
function braceBody(source: string, openBraceIndex: number, label: string): string {
  let braceDepth = 0;
  for (let index = openBraceIndex; index < source.length; index++) {
    const character = source[index];
    if (character === '{') {
      braceDepth++;
    } else if (character === '}') {
      braceDepth--;
      if (braceDepth === 0) return source.slice(openBraceIndex + 1, index);
    }
  }
  throw new Error(`Unbalanced braces for ${label}`);
}

/** Property names declared at brace depth 0 of an interface or inline object type body. */
function depthZeroFieldNames(body: string): string[] {
  const fieldNames: string[] = [];
  let depth = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (depth === 0) {
      const match = line.match(/^(\w+)\??\s*:/);
      if (match) fieldNames.push(match[1]);
    }
    for (const character of line) {
      if (character === '{') depth++;
      else if (character === '}') depth--;
    }
  }
  return fieldNames;
}

/** The counter names of `export interface CompensationCounters` in the engine shapes. */
function engineCounterNames(): string[] {
  const source = withoutComments(ENGINE_SHAPES);
  const marker = `export interface ${COUNTERS_INTERFACE_NAME} {`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Could not find "${marker}" in ${ENGINE_SHAPES}`);
  return depthZeroFieldNames(braceBody(source, markerIndex + marker.length - 1, COUNTERS_INTERFACE_NAME));
}

/** The counter names of the inline `compensationCounters: { ... }` in the IPC copy. */
function ipcCounterNames(): string[] {
  const source = withoutComments(SHARED_TYPES);
  const marker = `export interface ${INTERFACE_NAME} {`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`Could not find "${marker}" in ${SHARED_TYPES}`);
  const snapshotBody = braceBody(source, markerIndex + marker.length - 1, INTERFACE_NAME);
  const fieldMatch = snapshotBody.match(new RegExp(`\\b${COUNTERS_FIELD_NAME}\\s*:\\s*\\{`));
  if (!fieldMatch || fieldMatch.index === undefined) {
    throw new Error(`Could not find an inline "${COUNTERS_FIELD_NAME}: {" in ${INTERFACE_NAME} (${SHARED_TYPES})`);
  }
  return depthZeroFieldNames(braceBody(snapshotBody, fieldMatch.index + fieldMatch[0].length - 1, COUNTERS_FIELD_NAME));
}

/**
 * Extract the top-level property names of `export interface <interfaceName>` from a TypeScript
 * source file. Comments are stripped first so commented prose can never look like a field, then
 * the interface body is isolated by brace-matching, then property declarations are captured only
 * at brace depth 0 so the fields of inlined nested object types are skipped.
 */
function topLevelFieldNames(filePath: string, interfaceName: string): string[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const marker = `export interface ${interfaceName} {`;
  const markerIndex = withoutComments.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find "${marker}" in ${filePath}`);
  }

  // Brace-match from the interface's opening brace to find its body.
  let braceDepth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (let index = markerIndex + marker.length - 1; index < withoutComments.length; index++) {
    const character = withoutComments[index];
    if (character === '{') {
      braceDepth++;
      if (braceDepth === 1) bodyStart = index + 1;
    } else if (character === '}') {
      braceDepth--;
      if (braceDepth === 0) {
        bodyEnd = index;
        break;
      }
    }
  }
  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error(`Unbalanced braces for interface ${interfaceName} in ${filePath}`);
  }

  const fieldNames: string[] = [];
  let depth = 0;
  for (const rawLine of withoutComments.slice(bodyStart, bodyEnd).split('\n')) {
    const line = rawLine.trim();
    if (depth === 0) {
      const match = line.match(/^(\w+)\??\s*:/);
      if (match) fieldNames.push(match[1]);
    }
    for (const character of line) {
      if (character === '{') depth++;
      else if (character === '}') depth--;
    }
  }
  return fieldNames;
}

describe('ActivityStatsSnapshot parity', () => {
  it('the engine-internal and IPC copies declare the same top-level fields', () => {
    const engineFields = topLevelFieldNames(ENGINE_SHAPES, INTERFACE_NAME).sort();
    const ipcFields = topLevelFieldNames(SHARED_TYPES, INTERFACE_NAME).sort();

    const onlyInEngine = engineFields.filter((field) => !ipcFields.includes(field));
    const onlyInIpc = ipcFields.filter((field) => !engineFields.includes(field));

    expect(
      onlyInEngine,
      `Fields only in the engine copy (src/main/activity-engine/engine/shapes.ts); add them to the IPC copy in src/shared/types.ts: ${onlyInEngine.join(', ')}`,
    ).toEqual([]);
    expect(
      onlyInIpc,
      `Fields only in the IPC copy (src/shared/types.ts); add them to the engine copy in src/main/activity-engine/engine/shapes.ts: ${onlyInIpc.join(', ')}`,
    ).toEqual([]);
    expect(engineFields).toEqual(ipcFields);
  });

  it('extracts a non-trivial field set (guards against a parser that silently finds nothing)', () => {
    // Without this, a regression that makes topLevelFieldNames return [] for both copies would
    // make the parity assertion above pass vacuously.
    const engineFields = topLevelFieldNames(ENGINE_SHAPES, INTERFACE_NAME);
    expect(engineFields).toContain('idleHintPending');
    expect(engineFields).toContain('sessionId');
    expect(engineFields.length).toBeGreaterThanOrEqual(15);
  });

  it('the engine and IPC copies declare the same compensation counters', () => {
    const engineCounters = engineCounterNames().sort();
    const ipcCounters = ipcCounterNames().sort();

    const onlyInEngine = engineCounters.filter((counter) => !ipcCounters.includes(counter));
    const onlyInIpc = ipcCounters.filter((counter) => !engineCounters.includes(counter));

    expect(
      onlyInEngine,
      `Counters only in CompensationCounters (src/main/activity-engine/engine/shapes.ts); add them to ActivityStatsSnapshot.compensationCounters in src/shared/types.ts: ${onlyInEngine.join(', ')}`,
    ).toEqual([]);
    expect(
      onlyInIpc,
      `Counters only in ActivityStatsSnapshot.compensationCounters (src/shared/types.ts); add them to CompensationCounters in src/main/activity-engine/engine/shapes.ts: ${onlyInIpc.join(', ')}`,
    ).toEqual([]);
    // Guards against a parser that silently finds nothing in either copy.
    expect(engineCounters).toContain('staleThinking');
    expect(engineCounters).toContain('internalAgentToolEvent');
    expect(engineCounters.length).toBeGreaterThanOrEqual(10);
  });
});
