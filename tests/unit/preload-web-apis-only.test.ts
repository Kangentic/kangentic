import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

// The preload is SANDBOXED (no window sets `sandbox: false`, and true is the default), and
// Electron 45 removes the Node shims a sandboxed preload still has today: `Buffer`,
// `setImmediate` / `clearImmediate`, and `require('events' | 'timers' | 'url')`. The two `Buffer`
// calls the preload used to make were both base64 decodes; the pop-out one sat inside a try, so on
// 45 it would have thrown, been swallowed, and booted every pop-out window as the full app.
//
// This walks the preload's REAL import graph (value imports only, since a type import bundles
// nothing), so a shared module the preload starts importing is covered too, and reads identifiers
// from the AST, so a comment that names `Buffer` is not a hit.

const REPO_ROOT = path.resolve(__dirname, '../..');
const PRELOAD_ENTRY = path.join(REPO_ROOT, 'src', 'preload', 'preload.ts');

const BANNED_GLOBALS = new Set(['Buffer', 'setImmediate', 'clearImmediate']);
const BANNED_MODULES = new Set(['events', 'node:events', 'timers', 'node:timers', 'url', 'node:url', 'buffer', 'node:buffer']);

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface Offence {
  file: string;
  line: number;
  what: string;
}

function scanPreloadGraph(): { files: string[]; offences: Offence[] } {
  const visited = new Set<string>();
  const queue = [PRELOAD_ENTRY];
  const offences: Offence[] = [];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const typeOnly = node.importClause?.isTypeOnly === true;
        if (!typeOnly && BANNED_MODULES.has(specifier)) {
          offences.push({ file: relative, line: lineOf(node), what: `import from '${specifier}'` });
        }
        if (!typeOnly && specifier.startsWith('.')) {
          const resolved = resolveRelative(file, specifier);
          if (resolved) queue.push(resolved);
        }
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        BANNED_MODULES.has(node.arguments[0].text)
      ) {
        offences.push({ file: relative, line: lineOf(node), what: `require('${node.arguments[0].text}')` });
      } else if (ts.isIdentifier(node) && BANNED_GLOBALS.has(node.text)) {
        // A property NAME (`something.Buffer`, `{ Buffer: x }`) is not the global.
        const parent = node.parent;
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node);
        if (!isPropertyName) offences.push({ file: relative, line: lineOf(node), what: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { files: [...visited].map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/')), offences };
}

describe('the sandboxed preload uses web APIs only', () => {
  const { files, offences } = scanPreloadGraph();

  it('walks the preload and the shared modules it bundles', () => {
    expect(files).toContain('src/preload/preload.ts');
    expect(files).toContain('src/shared/ipc-channels.ts');
    expect(files).toContain('src/shared/pop-out.ts');
  });

  it('has no Buffer, setImmediate, clearImmediate, or events / timers / url / buffer import', () => {
    expect(
      offences.map((offence) => `${offence.file}:${offence.line} ${offence.what}`),
      'Electron 45 removes these from sandboxed preloads. Use atob / TextDecoder / setTimeout / ' +
        'EventTarget / the global URL instead.'
    ).toEqual([]);
  });
});
