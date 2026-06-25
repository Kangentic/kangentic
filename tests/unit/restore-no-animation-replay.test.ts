import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces .claude/rules/restore-no-animation-replay.md (the value-pulse arm). A project
// switch / restore re-points the status and context bars to a different context's numbers;
// that flip is not a live tick and must not pulse. The guard: every `useValuePulse(...)` call
// must pass a `resetKey` identifying the context the value belongs to (project id, session id),
// so the hook rebaselines silently on a context switch instead of animating.
//
// (The window-restore arm of the same rule is locked by window-workspace.test.ts:
// deserializeWorkspace stamps skipEnterAnimation and serializeWorkspace never persists it.)
//
// Escape hatch: a call that genuinely never re-points across a context boundary may carry a
// `// value-pulse-ok: <reason>` marker on the call line or the line above.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const OK_MARKER = /value-pulse-ok/;

// The hook's own definition lives here; it is not a call site.
const DEFINITION_FILE = 'src/renderer/hooks/useValuePulse.ts';

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

/** Extract the balanced-paren argument list of the call starting at `openParenIndex`
 *  (the index of the '(' right after `useValuePulse`). Returns the substring between the
 *  parentheses. Naive paren counting is sufficient for these simple call sites. */
function extractCallArgs(text: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(openParenIndex + 1, i);
    }
  }
  return text.slice(openParenIndex + 1); // unbalanced (should not happen in valid source)
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

describe('every useValuePulse call rebaselines on a context change (resetKey)', () => {
  it('no useValuePulse call site in src/renderer omits resetKey', () => {
    const offenders: string[] = [];
    const absoluteDir = path.join(REPO_ROOT, SCAN_DIR);
    const callPattern = /useValuePulse\s*\(/g;

    for (const filePath of collectSourceFiles(absoluteDir)) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      if (relative === DEFINITION_FILE) continue;
      const text = fs.readFileSync(filePath, 'utf-8');
      const lines = text.split('\n');

      for (const match of text.matchAll(callPattern)) {
        const openParenIndex = match.index + match[0].length - 1;
        const args = extractCallArgs(text, openParenIndex);
        if (/resetKey/.test(args)) continue;

        const callLine = lineNumberAt(text, match.index); // 1-based
        const lineIndex = callLine - 1;
        if (OK_MARKER.test(lines[lineIndex])) continue;
        let previousIndex = lineIndex - 1;
        while (previousIndex >= 0 && lines[previousIndex].trim() === '') previousIndex--;
        if (previousIndex >= 0 && OK_MARKER.test(lines[previousIndex])) continue;

        offenders.push(`${relative}:${callLine}`);
      }
    }

    expect(
      offenders,
      `Every useValuePulse(...) must pass a resetKey identifying the value's context (project id, ` +
        `session id, ...) so a project/session switch rebaselines silently instead of pulsing. ` +
        `See .claude/rules/restore-no-animation-replay.md. For a call that never re-points across a ` +
        `context boundary, add // value-pulse-ok: <reason>.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
