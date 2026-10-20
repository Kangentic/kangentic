/**
 * The two loaders that read a recorded Browser pane Send (loadDemoRecordings' `sends` index and
 * loadDemoSendFrames, in tests/captures/helpers/demo-scrollback.ts) refuse a send they cannot play
 * honestly instead of skipping it: a send file nothing lists, a listed file that is not on disk, a
 * paste with no frame before it or an Enter that does not follow it, and a paste whose text does not
 * open with the manifest's note. A skip would leave the browser scene's Send waiting on an agent
 * that never starts, and a drifted note would echo words the visitor never typed.
 * tests/unit/demo-browser-send-seeded.test.ts holds the committed fixtures to the same bar, but only
 * against whatever is on disk today, so none of these refusals was ever exercised. This file builds
 * small broken fixtures and holds each refusal, the re-record command it names, and the happy path
 * that must keep passing.
 *
 * Each test makes its own fixtures directory: loadRecordings memoizes per directory, so a shared one
 * would serve the first test's parse to the rest.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDemoRecordings, loadDemoSendFrames } from '../captures/helpers/demo-scrollback';

const NOTE = 'Add rate limiting to the middleware';
const SESSION_ID = 'x';
const SEND_FILE = 'send-x.json';
const REST_FRAME = 'the finished conversation, waiting';
// Every re-record hint in the loaders names the recording without its extension (the send hint
// and the tiled hint both strip ".json"), so the pattern refuses a hint that ends in "send-x.json".
const RERECORD_COMMAND = /node scripts\/capture-demo-sessions\.mjs --only send-x(?![\w.-])/;

interface SendFixture {
  /** The manifest's browserSends listing; null leaves the send unlisted. */
  listed: { file: string; sessionId: string; recording: string; note: string } | null;
  /** The send file's record; null leaves the file off disk. */
  record: Record<string, unknown> | null;
}

const createdDirectories: string[] = [];

function validPaste(): Record<string, unknown> {
  return { atMs: 4000, enterAtMs: 5200, text: `${NOTE}\n<browser_context>\nscreenshot: page.png\n</browser_context>`, frame: REST_FRAME };
}

function validRecord(): Record<string, unknown> {
  return { agent: 'claude', serialized: 'the final frame', rawBytes: 10, paste: validPaste() };
}

function listing(): NonNullable<SendFixture['listed']> {
  return { file: SEND_FILE, sessionId: SESSION_ID, recording: 'sess-x.json', note: NOTE };
}

function makeFixturesDirectory(fixture: SendFixture): string {
  const fixturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-demo-send-loaders-'));
  createdDirectories.push(fixturesDirectory);
  const manifest: Record<string, unknown> = { captures: [] };
  if (fixture.listed) manifest.browserSends = [fixture.listed];
  fs.writeFileSync(path.join(fixturesDirectory, 'manifest.json'), JSON.stringify(manifest));
  if (fixture.record) fs.writeFileSync(path.join(fixturesDirectory, SEND_FILE), JSON.stringify(fixture.record));
  return fixturesDirectory;
}

function recordWithPaste(paste: Record<string, unknown> | undefined): Record<string, unknown> {
  const record = validRecord();
  if (paste === undefined) delete record.paste;
  else record.paste = paste;
  return record;
}

function thrownMessageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the loader to throw, but it returned');
}

afterEach(() => {
  for (const fixturesDirectory of createdDirectories.splice(0)) {
    fs.rmSync(fixturesDirectory, { recursive: true, force: true });
  }
});

describe('a browser send the loaders play', () => {
  it('indexes a listed, whole send under its session with the listed note and the paste timings', () => {
    const fixturesDirectory = makeFixturesDirectory({ listed: listing(), record: validRecord() });

    const send = loadDemoRecordings(fixturesDirectory).sends[SESSION_ID];

    expect(send).toBeDefined();
    expect(send.file).toBe(SEND_FILE);
    expect(send.note).toBe(NOTE);
    expect(send.atMs).toBe(4000);
    expect(send.enterAtMs).toBe(5200);
  });

  it('returns the frame before the paste, keyed by the listed dataset session', () => {
    const fixturesDirectory = makeFixturesDirectory({ listed: listing(), record: validRecord() });

    expect(loadDemoSendFrames(fixturesDirectory)).toEqual({ [SESSION_ID]: REST_FRAME });
  });

  it('indexes no send at all when the manifest lists none and none is on disk', () => {
    const fixturesDirectory = makeFixturesDirectory({ listed: null, record: null });

    expect(loadDemoRecordings(fixturesDirectory).sends).toEqual({});
    expect(loadDemoSendFrames(fixturesDirectory)).toEqual({});
  });
});

describe('a send file the manifest does not list', () => {
  it('is refused by loadDemoRecordings, since nothing says which note it plays for', () => {
    const fixturesDirectory = makeFixturesDirectory({ listed: null, record: validRecord() });

    const message = thrownMessageOf(() => loadDemoRecordings(fixturesDirectory));

    expect(message).toMatch(/does not list/);
    expect(message).toContain(SEND_FILE);
  });
});

describe('a listed send with no final frame', () => {
  it('is refused by loadDemoRecordings rather than dropped, which left its rest frame with no Send to play', () => {
    const fixturesDirectory = makeFixturesDirectory({ listed: listing(), record: { ...validRecord(), serialized: '' } });

    const message = thrownMessageOf(() => loadDemoRecordings(fixturesDirectory));

    expect(message).toMatch(/carries no final frame/);
    expect(message).toMatch(RERECORD_COMMAND);
  });
});

describe('a manifest-listed send whose file is not on disk', () => {
  it('is refused by loadDemoSendFrames, naming the session and the command that records it', () => {
    const fixturesDirectory = makeFixturesDirectory({ listed: listing(), record: null });

    const message = thrownMessageOf(() => loadDemoSendFrames(fixturesDirectory));

    expect(message).toMatch(/not on disk/);
    expect(message).toContain(SESSION_ID);
    expect(message).toMatch(RERECORD_COMMAND);
  });
});

const LOADERS: Array<[string, (fixturesDirectory: string) => unknown]> = [
  ['loadDemoRecordings', (fixturesDirectory) => loadDemoRecordings(fixturesDirectory)],
  ['loadDemoSendFrames', (fixturesDirectory) => loadDemoSendFrames(fixturesDirectory)],
];

describe.each(LOADERS)('%s refuses a paste it cannot play honestly', (_loaderName, load) => {
  const noPasteFixtures: Array<[string, Record<string, unknown> | undefined]> = [
    ['no paste at all', undefined],
    ['an empty frame before the paste', { ...validPaste(), frame: '' }],
    ['no frame field', (() => { const paste = validPaste(); delete paste.frame; return paste; })()],
    ['a frame that is not a string', { ...validPaste(), frame: 42 }],
    ['an Enter before the paste', { ...validPaste(), atMs: 5000, enterAtMs: 4000 }],
    ['an Enter at the same moment as the paste', { ...validPaste(), atMs: 4000, enterAtMs: 4000 }],
  ];

  it.each(noPasteFixtures)('throws "carries no paste with the frame before it" for %s', (_label, paste) => {
    const fixturesDirectory = makeFixturesDirectory({ listed: listing(), record: recordWithPaste(paste) });

    const message = thrownMessageOf(() => load(fixturesDirectory));

    expect(message).toMatch(/carries no paste with the frame before it/);
    expect(message).toContain(SEND_FILE);
    expect(message).toMatch(RERECORD_COMMAND);
  });

  const wrongTextFixtures: Array<[string, Record<string, unknown>]> = [
    ['a text that does not open with the note', { ...validPaste(), text: `Something else entirely\n${NOTE}` }],
    ['an empty text', { ...validPaste(), text: '' }],
    ['no text field at all', (() => { const paste = validPaste(); delete paste.text; return paste; })()],
    ['a text that is not a string', { ...validPaste(), text: 7 }],
  ];

  it.each(wrongTextFixtures)("throws \"does not open with the manifest's note\" for %s", (_label, paste) => {
    const fixturesDirectory = makeFixturesDirectory({ listed: listing(), record: recordWithPaste(paste) });

    const message = thrownMessageOf(() => load(fixturesDirectory));

    expect(message).toMatch(/does not open with the manifest's note/);
    expect(message).toContain(SEND_FILE);
    expect(message).toMatch(RERECORD_COMMAND);
  });
});
