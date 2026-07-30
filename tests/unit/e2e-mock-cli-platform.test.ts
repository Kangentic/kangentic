import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// An E2E spec that points an agent's `cliPath` at a bare `.js` fixture breaks on
// Windows in a uniquely nasty way: `.js` has no executable association, so when
// node-pty spawns it the shell pops a modal "Select an app to open this .js file"
// dialog instead of running anything. The agent never starts, the session gets no
// PTY, and no output is ever produced.
//
// The dialog is the visible symptom; the silent one is worse. A spec whose
// assertions depend on the agent doing something can PASS because nothing
// happened - which is exactly what occurred with the terminal fit harness: it
// observed zero PTY resizes and reported green, twice, while the developer
// dismissed the dialog four times.
//
// Every mock in tests/fixtures ships a `.cmd` sibling that shells out to node.
// `resolveMockAgentPath` in tests/e2e/helpers.ts picks the right one. This scan
// fails any spec that hand-rolls the path instead, so the trap cannot be re-set.

const REPO_ROOT = path.resolve(__dirname, '../..');
const E2E_DIR = path.join(REPO_ROOT, 'tests/e2e');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests/fixtures');

/** A fixtures-relative reference to a mock CLI's `.js` file. */
const MOCK_JS_REFERENCE = /['"`](mock-[\w-]+)\.js['"`]/g;

function listSpecs(): string[] {
  return fs
    .readdirSync(E2E_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => path.join(E2E_DIR, entry));
}

describe('E2E mock CLI paths are platform-correct', () => {
  it('every mock CLI has a .cmd sibling for Windows', () => {
    // The helper's win32 branch is only safe if the sibling actually exists; a
    // missing one would resolve to a nonexistent path and fail opaquely at spawn.
    const missing: string[] = [];
    for (const entry of fs.readdirSync(FIXTURES_DIR)) {
      if (!/^mock-[\w-]+\.js$/.test(entry)) continue;
      const cmdSibling = entry.replace(/\.js$/, '.cmd');
      if (!fs.existsSync(path.join(FIXTURES_DIR, cmdSibling))) missing.push(entry);
    }
    expect(
      missing,
      'These mock CLIs have no .cmd sibling, so resolveMockAgentPath would hand '
      + 'Windows a path that does not exist. Add the wrapper (copy an existing one). '
      + 'Missing:\n' + missing.join('\n'),
    ).toEqual([]);
  });

  it('no spec resolves a mock CLI path without handling Windows', () => {
    const offenders: string[] = [];

    for (const specPath of listSpecs()) {
      const source = fs.readFileSync(specPath, 'utf-8');
      const relativePath = path.relative(REPO_ROOT, specPath).replace(/\\/g, '/');

      // Strip comments so prose about the trap (including this rule's own
      // explanation in a spec header) is never mistaken for a usage.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

      const referenced = [...code.matchAll(MOCK_JS_REFERENCE)].map((match) => match[1]);
      if (referenced.length === 0) continue;

      // The ONLY acceptable reason to name a `mock-*.js` literal is an explicit
      // win32 branch alongside it (several specs predate the helper and are
      // correct that way).
      //
      // Deliberately NOT accepting "imports resolveMockAgentPath" as sufficient:
      // an unused import satisfied that and let a hand-rolled bare-.js path
      // through, which is how this guard failed its own red-check the first time.
      // A spec that actually uses the helper has no reason to name the .js file,
      // so requiring the win32 branch costs correct specs nothing.
      if (code.includes('win32')) continue;

      offenders.push(`${relativePath}: references ${[...new Set(referenced)].join(', ')}.js`);
    }

    expect(
      offenders,
      'These specs build a mock CLI path from a bare .js with no Windows handling. '
      + 'On Windows that spawns the "Select an app to open this .js file" dialog '
      + 'instead of the agent, so the session never starts and the spec can pass '
      + 'vacuously. Use resolveMockAgentPath() from tests/e2e/helpers.ts. '
      + 'Offenders:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});
