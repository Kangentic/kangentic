/**
 * The demo dataset must actually CARRY the data a board card reads, not merely be able to serve it.
 *
 * #648 made `agent-latest-message` the Card Preview default, so a default install prints the
 * agent's newest message on every card. The web demo inherited that default and kept rendering
 * descriptions, because nothing seeded a trail. Every check in place at the time passed:
 * mock-electron-api-parity proved `getMessageTrails` EXISTS, and the demo tier was green because
 * TaskCard falls back to the description cleanly. "The mock answers, but with nothing, so the
 * feature is invisible" was the blind spot they all shared.
 *
 * This closes it for the message trail specifically. It asserts the recordings carry a trail and
 * that every empty one is a DECIDED empty, named below with its reason, so the next recording that
 * comes back empty fails here instead of quietly showing a description.
 *
 * Deliberately narrow. A general "every __mock* cache the board reads is non-empty" guard is worth
 * having and is its own piece of work; this is the one surface that shipped broken.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGE_TRAIL_ENTRY_MAX_CHARS, MESSAGE_TRAIL_MAX_ENTRIES } from '../../src/main/agent/message-trail-tracker';
import { loadDemoMessageTrails } from '../captures/helpers/demo-scrollback';
import { SESSION_BOUTIQUE_A11Y, SESSION_MIDDLEWARE } from '../captures/helpers/demo-dataset';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo');

/**
 * Recordings whose trail is legitimately empty, and why.
 *
 * Each of these shows its description on the desktop too, so an empty trail here is parity rather
 * than a gap. Removing an entry without a recording to back it fails the "stale exemption" check
 * below, so the list cannot rot.
 */
const EMPTY_TRAIL_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'contoso-web-cursor-integration.json':
    'cursor-adapter.ts returns null from locateSessionHistoryFile and implements no parseTranscript',
  'contoso-web-copilot-rate-limit.json':
    'copilot-adapter.ts returns null from locateSessionHistoryFile and implements no parseTranscript',
  'online-boutique-copilot-currency-a11y.json':
    'copilot-adapter.ts returns null from locateSessionHistoryFile and implements no parseTranscript',
  'contoso-web-claude-terminal.json':
    'a Command Terminal session is transient, and MessageTrailTracker.schedule returns early for those',
  'spring-petclinic-gemini-owner-search.json':
    'this capture put all 19 of its assistant blocks in thinking, which assistantMessagePreviews excludes; '
    + 'it has zero text blocks, so the desktop shows this session no trail either',
});

interface Recording {
  agent: string;
  durationMs: number;
  messageTrail?: Array<{ t: number; uuid: string; ts: number; text: string }>;
}

function recordingFiles(): string[] {
  return fs.readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
}

function readRecording(file: string): Recording {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8')) as Recording;
}

describe('demo recordings carry the agent message trail a board card renders', () => {
  it('finds recordings to check, so a rename cannot make this vacuous', () => {
    expect(recordingFiles().length).toBeGreaterThan(20);
  });

  it('gives every recording a messageTrail key, present even when empty', () => {
    const missing = recordingFiles().filter((file) => !Array.isArray(readRecording(file).messageTrail));
    // An ABSENT key means the derivation never ran for that file; an empty array is a real answer.
    expect(missing, 'run "node scripts/backfill-demo-message-trails.mjs"').toEqual([]);
  });

  it('leaves a trail empty only where the desktop would also show none', () => {
    const unexplained = recordingFiles().filter((file) => {
      const trail = readRecording(file).messageTrail ?? [];
      // A Command Terminal boot is transient by construction, like the named session above.
      if (file.startsWith('terminal-')) return false;
      // A resume boot is the CLI reprinting a conversation the paused session's card already
      // carries the trail of: the resumed card keeps that trail (resumeTaskSession in the seed),
      // so the boot records none (capture-demo-sessions.mjs passes --no-message-trail for it).
      if (file.startsWith('resume-')) return false;
      // A tiled variant is a second run of a session's prompt at the tiled width, never a
      // session: the card follows the single recording's trail, so the variant records none
      // (capture-demo-sessions.mjs passes --no-message-trail for it).
      if (file.endsWith('-tiled.json')) return false;
      return trail.length === 0 && !(file in EMPTY_TRAIL_REASONS);
    });
    expect(
      unexplained,
      'each of these renders its description instead of the agent\'s newest message. Re-derive with '
      + '"node scripts/backfill-demo-message-trails.mjs", or add it to EMPTY_TRAIL_REASONS with the reason',
    ).toEqual([]);
  });

  it('keeps no stale exemption', () => {
    const stale = Object.keys(EMPTY_TRAIL_REASONS).filter((file) => {
      if (!fs.existsSync(path.join(FIXTURES_DIR, file))) return true;
      return (readRecording(file).messageTrail ?? []).length > 0;
    });
    expect(stale, 'these recordings now carry a trail, or are gone; drop them from EMPTY_TRAIL_REASONS').toEqual([]);
  });

  it('places every line inside its recording, with text a card can show', () => {
    const problems: string[] = [];
    for (const file of recordingFiles()) {
      const record = readRecording(file);
      let previous = -1;
      for (const entry of record.messageTrail ?? []) {
        if (entry.t < 0 || entry.t > record.durationMs) problems.push(`${file}: t=${entry.t} outside 0..${record.durationMs}`);
        if (entry.t < previous) problems.push(`${file}: t=${entry.t} is out of order`);
        previous = entry.t;
        if (entry.text.trim().length === 0) problems.push(`${file}: an entry has no text`);
        if (entry.text.length > MESSAGE_TRAIL_ENTRY_MAX_CHARS) problems.push(`${file}: an entry is longer than main would push`);
        if (typeof entry.uuid !== 'string' || entry.uuid.length === 0) problems.push(`${file}: an entry has no uuid`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the applier fallback equal to the cap main actually uses', () => {
    // demo-dataset.ts must stay free of Node imports, so it restates the number instead of
    // importing it. This is what stops the restated copy drifting.
    const dataset = fs.readFileSync(path.resolve(__dirname, '..', 'captures', 'helpers', 'demo-dataset.ts'), 'utf-8');
    const fallback = /options\.messageTrailMaxEntries \?\? (\d+)/.exec(dataset)?.[1];
    expect(Number(fallback)).toBe(MESSAGE_TRAIL_MAX_ENTRIES);
  });

  it('seeds the marketing captures from them too, so the hero shots are not the odd one out', async () => {
    // Executed rather than grepped: this is the one consumer with no tier of its own, and running
    // the builder also proves the seed script it produces is still generated without throwing.
    const { buildMarketingPreConfig } = await import('../captures/helpers/marketing-fixture');
    const seed = buildMarketingPreConfig();
    expect(seed).toContain('state.messageTrailCache[session.id]');
    // A real line from a real recording, so an empty messageTrails map cannot satisfy this.
    expect(seed).toContain('Typecheck is clean and the suite passes');
  });

  it('seeds the demo build from those trails', () => {
    // The recordings can be perfect and still never reach a card if the applier stops reading them.
    const dataset = fs.readFileSync(path.resolve(__dirname, '..', 'captures', 'helpers', 'demo-dataset.ts'), 'utf-8');
    expect(dataset).toContain('state.messageTrailCache[session.id]');
    expect(dataset).toContain('setMessageTrail');
    const loader = fs.readFileSync(path.resolve(__dirname, '..', 'captures', 'helpers', 'demo-scrollback.ts'), 'utf-8');
    expect(loader).toContain('loadDemoMessageTrails');
    const config = fs.readFileSync(path.resolve(__dirname, '..', '..', 'demo', 'vite.config.mts'), 'utf-8');
    expect(config).toContain('loadDemoMessageTrails()');
  });

  it('drops a recording with an empty messageTrail from the map, rather than keeping it with []', () => {
    const trails = loadDemoMessageTrails(FIXTURES_DIR);
    // A vacuity guard: an empty map, or one keyed by nothing recognizable, would make the
    // negative assertion below pass for the wrong reason.
    expect(Object.keys(trails).length).toBeGreaterThan(5);
    expect(SESSION_MIDDLEWARE in trails).toBe(true);
    expect(trails[SESSION_MIDDLEWARE].length).toBeGreaterThan(0);
    // sess-ob-currency-a11y's recording (online-boutique-copilot-currency-a11y.json) carries
    // "messageTrail": [], one of the EMPTY_TRAIL_REASONS entries above. buildDemoPreConfig's
    // applier treats "absent" and "present but empty" differently (setMessageTrail's guard), so
    // the loader dropping this key rather than keeping it as [] is a real behavioral contract,
    // not a cosmetic one.
    expect(SESSION_BOUTIQUE_A11Y in trails).toBe(false);
  });
});
