/**
 * The conversation viewer scene shows a transcript the sample install actually carries.
 *
 * The bridge method existing and answering with nothing passes every structural check while the
 * feature is invisible (tests/unit/demo-message-trail-seeded.test.ts is the same guard for the
 * card's trail). Before this, the viewer opened on the middleware session with an enabled pill
 * and an empty conversation. So this asserts the transcript file is present, is a real
 * conversation in the shape main's parser produces, comes from the same run as the recording's
 * trail, and is read by the build and opened by the scene.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../src/shared/types';
import { loadDemoMessageTrails, loadDemoTranscripts } from '../captures/helpers/demo-scrollback';
import { SESSION_MIDDLEWARE } from '../captures/helpers/demo-dataset';
import { SCENES } from '../captures/scenes';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'captures', 'fixtures', 'demo');
const TRANSCRIPTS_DIR = path.join(FIXTURES_DIR, 'transcripts');

interface Manifest {
  captures: Array<{ file: string; sessionId: string; transcript?: boolean }>;
}

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf-8')) as Manifest;
}

describe('demo transcripts behind the conversation viewer', () => {
  const transcripts = loadDemoTranscripts();

  it('carries the middleware session, which the conversation scene opens', () => {
    expect(Object.keys(transcripts)).toContain(SESSION_MIDDLEWARE);
    const scene = SCENES.conversation;
    expect(scene).toBeDefined();
    const workspace = (scene.config?.workspaceByProject as Record<string, { windows: Array<{ taskId: string; kind?: string }> }>)['proj-contoso-web'];
    const viewer = workspace.windows.find((window) => window.kind === 'conversation');
    expect(viewer?.taskId).toBe(SESSION_MIDDLEWARE);
    expect(SESSION_MIDDLEWARE in transcripts, 'the scene opens a session with no transcript').toBe(true);
  });

  it('is a whole conversation in the parser\'s shape, not a stub', () => {
    const entries: TranscriptEntry[] = transcripts[SESSION_MIDDLEWARE];
    expect(entries.length).toBeGreaterThan(10);
    const kinds = new Set(entries.map((entry) => entry.kind));
    for (const kind of ['user', 'assistant', 'tool_result']) expect(kinds.has(kind as TranscriptEntry['kind']), `no ${kind} entry`).toBe(true);
    const assistant = entries.filter((entry): entry is Extract<TranscriptEntry, { kind: 'assistant' }> => entry.kind === 'assistant');
    expect(assistant.some((entry) => entry.blocks.some((block) => block.type === 'text'))).toBe(true);
    expect(assistant.some((entry) => entry.blocks.some((block) => block.type === 'tool_use'))).toBe(true);
    // The first user turn is the recording's prompt, which is what the match was made on.
    const firstUser = entries.find((entry) => entry.kind === 'user');
    expect(firstUser?.kind === 'user' && firstUser.text).toContain('Extract the auth logic');
    for (const entry of entries) {
      expect(typeof entry.uuid === 'string' && entry.uuid.length > 0, 'an entry has no uuid').toBe(true);
      expect(entry.ts).toBeGreaterThan(0);
    }
  });

  it('is the same run the card trail was derived from', () => {
    // A trail line's uuid is its transcript entry's, so every line the card shows is in the viewer.
    const trail = loadDemoMessageTrails()[SESSION_MIDDLEWARE] ?? [];
    expect(trail.length).toBeGreaterThan(0);
    const uuids = new Set(transcripts[SESSION_MIDDLEWARE].map((entry) => entry.uuid));
    for (const line of trail) expect(uuids.has(line.uuid), `trail line "${line.text.slice(0, 40)}" is not in the transcript`).toBe(true);
  });

  it('has a file for every marked manifest entry, and marks every file', () => {
    const marked = readManifest().captures.filter((entry) => entry.transcript).map((entry) => entry.file).sort();
    const onDisk = fs.readdirSync(TRANSCRIPTS_DIR).filter((name) => name.endsWith('.json')).sort();
    expect(onDisk, 'run node scripts/backfill-demo-transcripts.mjs, or drop the stale file').toEqual(marked);
  });

  it('is read by the build and served by the seed', () => {
    const config = fs.readFileSync(path.join(REPO_ROOT, 'demo', 'vite.config.mts'), 'utf-8');
    expect(config).toContain('loadDemoTranscripts()');
    const dataset = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'captures', 'helpers', 'demo-dataset.ts'), 'utf-8');
    expect(dataset).toContain('window.electronAPI.transcripts.get = function');
    expect(dataset).toContain('window.electronAPI.transcripts.listSessions = function');
  });
});
