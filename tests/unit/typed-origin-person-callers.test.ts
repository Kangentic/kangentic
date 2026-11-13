/**
 * Only the three paths that carry a PERSON's own words pass `origin: 'person'` (#1078).
 *
 * `TerminalSubmit` records every text it types so a Text match on the user's message can leave out
 * Kangentic's own words. The default origin is Kangentic's. What a user loses if this goes:
 *
 * - a person's dictated or phone "signed off" (or a Browser pane Send of their notes) loses its
 *   `origin: 'person'`, is recorded as Kangentic's own text, and is dropped from their messages, so
 *   the row waiting for the sign-off never runs;
 * - a Kangentic caller (a column message, a nudge, a forwarded agent reply) that claims
 *   `origin: 'person'` is left out of the record, so its text reads as the user's and a card moves
 *   before anyone signed it off.
 *
 * Reads source text because this is a convention across files that the byte layer cannot check
 * (it cannot tell who a text is from).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const SOURCE_ROOT = path.resolve(__dirname, '../../src/main');

const PERSON_CALLERS = [
  'mobile-bridge/handlers/send-user-message.ts',
  'ipc/handlers/transcription.ts',
  'ipc/handlers/browser.ts',
];

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(entryPath));
    else if (/\.tsx?$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function relativeSourcePath(filePath: string): string {
  return path.relative(SOURCE_ROOT, filePath).replace(/\\/g, '/');
}

interface CallSite {
  file: string;
  /** The whole call, from the method name to its closing parenthesis. */
  text: string;
}

/** Every `.submitContent(` / `.submitKeystrokes(` call, with its full argument text. */
function findCallSites(): CallSite[] {
  const callSites: CallSite[] = [];
  const callStart = /\.(?:submitContent|submitKeystrokes)\(/g;
  for (const filePath of listSourceFiles(SOURCE_ROOT)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(callStart)) {
      let depth = 0;
      let end = match.index;
      for (; end < source.length; end += 1) {
        const character = source[end];
        if (character === '(') depth += 1;
        else if (character === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      callSites.push({ file: relativeSourcePath(filePath), text: source.slice(match.index, end + 1) });
    }
  }
  return callSites;
}

const claimsPerson = (callSite: CallSite): boolean => /origin\s*:\s*['"]person['"]/.test(callSite.text);

describe('who a typed text is from', () => {
  const callSites = findCallSites();

  it('finds the call sites it governs', () => {
    // A scan that matched nothing would pass every check below.
    expect(callSites.length).toBeGreaterThanOrEqual(8);
  });

  it.each(PERSON_CALLERS)('%s passes origin: person on its one terminalSubmit.submitContent call', (file) => {
    const calls = callSites.filter((callSite) => callSite.file === file);
    expect(calls).toHaveLength(1);
    expect(calls[0].text.startsWith('.submitContent(')).toBe(true);
    expect(claimsPerson(calls[0])).toBe(true);
  });

  it('no other caller claims origin: person, since each carries Kangentic\'s own text', () => {
    const wrongClaims = callSites
      .filter((callSite) => !PERSON_CALLERS.includes(callSite.file))
      .filter(claimsPerson)
      .map((callSite) => callSite.file);
    expect(wrongClaims).toEqual([]);
  });
});
