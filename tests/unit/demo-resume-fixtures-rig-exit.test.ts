/**
 * scripts/capture-demo-sessions.mjs records a resume capture against a COPY of the agent's
 * session history with the rig's own /exit exchange dropped first (withoutRigExit): the rig ends
 * every OTHER capture by typing /exit at the CLI, and Claude logs that as a caveat entry, the
 * command itself, and its own "Goodbye!" reply into the very history file a resume then reprints.
 * Without that stripping step, every resume-*.json fixture would end on the rig's own exit turn,
 * a prompt line reading the rig's own /exit followed by the CLI's goodbye reply, which was never
 * part of the session the fixture is meant to demonstrate. This test is the fixture-side backstop
 * for withoutRigExit actually running before every resume capture.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripAnsiEscapes } from '../../src/shared/ansi-strip';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'captures', 'fixtures', 'demo');

interface ResumeFixture {
  serialized?: string;
  stream?: Array<{ t: number; data: string }>;
}

function listResumeFixtures(): string[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs.readdirSync(FIXTURES_DIR)
    .filter((name) => name.startsWith('resume-') && name.endsWith('.json'))
    .map((name) => path.join(FIXTURES_DIR, name));
}

/** True when the text carries a "/exit" prompt line or the CLI's own goodbye reply. */
function carriesRigExit(strippedText: string): boolean {
  return strippedText.split('\n').some((line) => /❯\s*\/exit/.test(line)) || strippedText.includes('Goodbye!');
}

describe('carriesRigExit detector', () => {
  it('flags the shape the rig would leave behind if withoutRigExit had not run', () => {
    // The ANSI stripper deletes a cursor-forward sequence outright rather than replacing it with
    // a space, so this is the actual joined shape the detector has to catch: no gap between the
    // prompt glyph and the command it types.
    const withInjectedExit = 'some earlier output\n❯\x1b[1C/exit\r\nGoodbye!\r\n';
    expect(carriesRigExit(stripAnsiEscapes(withInjectedExit))).toBe(true);
  });

  it('does not flag ordinary conversation text that never mentions the rig exit', () => {
    const benign = 'Plan how to add reconnection with exponential backoff to src/lib/websocket.ts.\n❯ /help\n';
    expect(carriesRigExit(stripAnsiEscapes(benign))).toBe(false);
  });
});

describe('resume fixtures never ship the capture rig exit exchange', () => {
  const files = listResumeFixtures();

  it('has resume fixtures to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s carries no rig exit turn', (file) => {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf-8')) as ResumeFixture;
    const serializedText = stripAnsiEscapes(String(fixture.serialized ?? ''));
    const streamText = stripAnsiEscapes((fixture.stream ?? []).map((chunk) => chunk.data).join(''));
    expect(carriesRigExit(serializedText), `${path.basename(file)} serialized frame`).toBe(false);
    expect(carriesRigExit(streamText), `${path.basename(file)} joined stream`).toBe(false);
  });
});
