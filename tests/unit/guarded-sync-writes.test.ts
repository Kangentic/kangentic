import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

// Enforces .claude/rules/guarded-sync-writes.md. A bare fs.writeFileSync/mkdirSync/renameSync
// in these trees is exactly the shape that let ConfigManager.save() take the app down
// (DESKTOP-14) and reject config:set with no renderer handler to catch it (DESKTOP-13): a
// write with no try/catch, reachable from a timer or an IPC handler with nowhere to send a
// rejection. Every call site here is now one of three things - routed through safeWriteJson
// (which never throws), lexically inside its own try/catch, or marked `// sync-write-ok:
// <reason>` because the throw is deliberate and something downstream already turns it into a
// user-visible failure (an IPC rejection the renderer toasts, or spawnAgent's
// reportHandledError + notifySpawnBlocked).
//
// The scan parses the real AST (TypeScript compiler API) to decide "lexically inside a try",
// rather than tracking brace depth by hand - a line-based scan cannot reliably tell whether a
// given line sits inside a try block once nesting is involved. The marker check stays
// line-based (same-line trailing comment, or an unbroken run of comment/blank lines directly
// above), matching the `// select-none-ok:` / `// value-pulse-ok:` convention elsewhere in the
// tree. This proves lexical placement only, not runtime control flow: a call inside a callback
// that is merely nested inside a try block's TEXT, but invoked asynchronously after the try's
// dynamic extent has ended, would read as "guarded" here even though a throw from it would not
// actually be caught. No call site in the scoped trees does that today.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = [
  'src/main/config',
  'src/main/boards',
  'src/main/browser',
  'src/main/mobile-bridge',
  'src/main/db/repositories',
  'src/main/agent/adapters',
  'src/main/transition-engine',
  'src/main/ipc/handlers',
  'src/main/transcription',
];
const GUARDED_CALLS = new Set(['writeFileSync', 'mkdirSync', 'renameSync']);
const MARKER = 'sync-write-ok:';

interface SyncWriteCall {
  file: string;
  line: number;
  callee: string;
  guarded: boolean;
}

/** True when `node` sits inside the TRY block (not the catch or finally) of some ancestor
 *  TryStatement, walking all the way up to the source file. */
function isLexicallyInsideTry(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent: ts.Node = current.parent;
    if (ts.isTryStatement(parent) && current === parent.tryBlock) return true;
    current = parent;
  }
  return false;
}

/** True when `line` carries the marker AND text follows the colon. The rule requires the reason
 *  to name what depends on the write and where the throw is caught, so a bare `// sync-write-ok:`
 *  buys nothing and must not satisfy the scan: an empty escape hatch is how a genuinely
 *  overlooked write gets waved through. */
function carriesMarkerWithReason(line: string): boolean {
  const markerIndex = line.indexOf(MARKER);
  if (markerIndex === -1) return false;
  return line.slice(markerIndex + MARKER.length).trim().length > 0;
}

/** A `// sync-write-ok: <reason>` marker on the call's own line (trailing comment), or as part of
 *  an unbroken run of comment/blank lines immediately above it. Stops at the first line that is
 *  neither blank nor a comment, so a marker for an unrelated, more distant call cannot be
 *  mistaken for covering this one. */
function hasMarker(sourceLines: string[], lineIndex: number): boolean {
  if (sourceLines[lineIndex] !== undefined && carriesMarkerWithReason(sourceLines[lineIndex])) return true;
  let index = lineIndex - 1;
  while (index >= 0) {
    const trimmed = sourceLines[index].trim();
    if (trimmed === '') {
      index--;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      if (carriesMarkerWithReason(trimmed)) return true;
      index--;
      continue;
    }
    break;
  }
  return false;
}

// Takes the source text rather than a path so the detector's own positive path can be driven
// over known-bad input below. Without that, a broken match/guard predicate would report
// nothing and the whole suite would pass vacuously.
function scanSource(fileLabel: string, source: string): SyncWriteCall[] {
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sourceLines = source.split('\n');
  const found: SyncWriteCall[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === 'fs' &&
      GUARDED_CALLS.has(node.expression.name.text)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push({
        file: fileLabel,
        line: line + 1,
        callee: node.expression.name.text,
        guarded: isLexicallyInsideTry(node) || hasMarker(sourceLines, line),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function scanFile(filePath: string): SyncWriteCall[] {
  return scanSource(path.relative(REPO_ROOT, filePath).replace(/\\/g, '/'), fs.readFileSync(filePath, 'utf-8'));
}

function collectTsFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectTsFiles(fullPath));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(fullPath);
  }
  return found;
}

const scannedFiles = SCAN_DIRS.flatMap((relativeDir) => {
  const absoluteDir = path.join(REPO_ROOT, relativeDir);
  return fs.existsSync(absoluteDir) ? collectTsFiles(absoluteDir) : [];
});
const allCalls = scannedFiles.flatMap(scanFile);

describe('synchronous fs writes are guarded, tried, or marked', () => {
  it('has no unguarded fs.writeFileSync/mkdirSync/renameSync in the scoped trees', () => {
    const offenders = allCalls.filter((call) => !call.guarded);
    const report = offenders.map((call) => `  ${call.file}:${call.line} fs.${call.callee}(`).join('\n');

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Unguarded synchronous fs write(s):\n${report}\n\n`
          + 'Route it through safeWriteJson() (src/main/safe-write.ts), wrap it in a local\n'
          + 'try/catch, or mark it `// sync-write-ok: <reason>` naming why the throw is\n'
          + 'deliberate and where it is caught. See .claude/rules/guarded-sync-writes.md.',
    ).toEqual([]);
  });

  // Without this the scan could pass vacuously: a predicate that stops matching `fs.xxx(`
  // calls, or a marker check that stops finding them, would report zero offenders and look
  // green. These are known marked sites, pinned so a broken detector is caught here instead.
  it('still resolves the known marked sites (scan is not vacuous)', () => {
    const markedFiles = allCalls.filter((call) => call.guarded).map((call) => call.file);

    expect(markedFiles).toEqual(
      expect.arrayContaining([
        'src/main/config/board-config/atomic-write.ts',
        'src/main/db/repositories/attachment-repository.ts',
        'src/main/agent/adapters/claude/command-builder.ts',
        'src/main/agent/adapters/claude/trust-manager.ts',
        'src/main/transition-engine/session-startup/prepare-spawn.ts',
        'src/main/ipc/handlers/transient-sessions.ts',
        'src/main/transcription/models/download-model.ts',
      ]),
    );
    expect(scannedFiles.length).toBeGreaterThan(30);
  });
});

// The two tests above can both stay green while the detector is broken - see the comment on
// each. These drive it over known input instead, so its positive path is pinned rather than
// assumed.
describe('the guarded-sync-writes detector itself', () => {
  it('reports a bare write with no guard', () => {
    const found = scanSource('probe.ts', [
      "import fs from 'node:fs';",
      'function save(value: string): void {',
      '  fs.writeFileSync("mock/probe.txt", value);',
      '}',
    ].join('\n'));

    expect(found).toEqual([{ file: 'probe.ts', line: 3, callee: 'writeFileSync', guarded: false }]);
  });

  it('clears a write lexically inside a try block', () => {
    const found = scanSource('probe.ts', [
      "import fs from 'node:fs';",
      'function save(value: string): void {',
      '  try {',
      '    fs.writeFileSync("mock/probe.txt", value);',
      '  } catch {}',
      '}',
    ].join('\n'));

    expect(found.map((call) => call.guarded)).toEqual([true]);
  });

  it('does NOT clear a write in the catch block of an unrelated try', () => {
    const found = scanSource('probe.ts', [
      "import fs from 'node:fs';",
      'function save(value: string): void {',
      '  try {',
      '    doSomethingElse();',
      '  } catch {',
      '    fs.writeFileSync("mock/probe.txt", value);',
      '  }',
      '}',
    ].join('\n'));

    expect(found.map((call) => call.guarded)).toEqual([false]);
  });

  it('clears a write with a `// sync-write-ok:` marker on the line above', () => {
    const found = scanSource('probe.ts', [
      "import fs from 'node:fs';",
      'function save(value: string): void {',
      '  // sync-write-ok: must throw, the caller reports and notifies.',
      '  fs.writeFileSync("mock/probe.txt", value);',
      '}',
    ].join('\n'));

    expect(found.map((call) => call.guarded)).toEqual([true]);
  });

  it('clears a write with a trailing same-line marker', () => {
    const found = scanSource('probe.ts', [
      "import fs from 'node:fs';",
      'function save(value: string): void {',
      '  fs.writeFileSync("mock/probe.txt", value); // sync-write-ok: see the caller',
      '}',
    ].join('\n'));

    expect(found.map((call) => call.guarded)).toEqual([true]);
  });

  it('does not let a marker for a DIFFERENT, more distant call cover this one', () => {
    const found = scanSource('probe.ts', [
      "import fs from 'node:fs';",
      'function save(value: string): void {',
      '  // sync-write-ok: this one is fine.',
      '  fs.mkdirSync("mock");',
      '  fs.writeFileSync("mock/probe.txt", value);',
      '}',
    ].join('\n'));

    expect(found).toEqual([
      { file: 'probe.ts', line: 4, callee: 'mkdirSync', guarded: true },
      { file: 'probe.ts', line: 5, callee: 'writeFileSync', guarded: false },
    ]);
  });

  it('does NOT clear a write whose marker has no reason after the colon (bare `// sync-write-ok:`)', () => {
    // Pins carriesMarkerWithReason: a bare marker with nothing after the colon
    // must not satisfy the scan, or the escape hatch waves through a write
    // nobody actually justified.
    const found = scanSource('probe.ts', [
      "import fs from 'node:fs';",
      'function save(value: string): void {',
      '  // sync-write-ok:',
      '  fs.writeFileSync("mock/probe.txt", value);',
      '}',
    ].join('\n'));

    expect(found).toEqual([{ file: 'probe.ts', line: 4, callee: 'writeFileSync', guarded: false }]);
  });

  it('clears the same call once real text follows the colon (companion to the bare-marker case above)', () => {
    const found = scanSource('probe.ts', [
      "import fs from 'node:fs';",
      'function save(value: string): void {',
      '  // sync-write-ok: caller reports and notifies, see write-failure-notice.ts.',
      '  fs.writeFileSync("mock/probe.txt", value);',
      '}',
    ].join('\n'));

    expect(found).toEqual([{ file: 'probe.ts', line: 4, callee: 'writeFileSync', guarded: true }]);
  });

  it('ignores an unrelated writeFileSync on a non-fs object', () => {
    const found = scanSource('probe.ts', [
      'const otherWriter = { writeFileSync: (path: string, value: string) => {} };',
      'otherWriter.writeFileSync("mock/probe.txt", "y");',
    ].join('\n'));

    expect(found).toEqual([]);
  });
});
