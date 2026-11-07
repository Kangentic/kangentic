import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertGeneratedAudio,
  assertLexiconCovers,
  createKokoroTts,
  lexiconWords,
  spokenWords,
} from '../../scripts/lib/dictation-tts.mjs';

/**
 * The guards around sherpa-onnx 2.x's Kokoro, used by the two scripts that synthesize a clip whose
 * words are known. Its lexicon frontend drops a word it does not know while synthesis still
 * succeeds, and returns no audio at all with no lexicon, so a bad clip shows up only as a worse
 * score, or as an empty file cached and scored on every later run. The scripts themselves run on
 * import and need a real model, so this covers what they depend on.
 *
 * Tier: Unit.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXTRA_LEXICON = path.join(REPO_ROOT, 'scripts', 'lib', 'dictation-lexicon-extra.txt');

describe('lexiconWords', () => {
  it('reads the release format: comments skipped, words before the separator, phones ignored', () => {
    const words = lexiconWords('# Lexicon: word(s) || space-separated phones\nadjuncts || ˈ æ d d ʒ ʌ ŋ k t s\n\nback || bˈ æ k\n');
    expect([...words]).toEqual(['adjuncts', 'back']);
  });

  it('reads the committed extra lexicon', () => {
    expect([...lexiconWords(fs.readFileSync(EXTRA_LEXICON, 'utf8'))].sort()).toEqual(['backoff', 'config', 'dropdown']);
  });
});

describe('createKokoroTts', () => {
  class FakeOfflineTts {
    constructor(readonly config: { model: { kokoro: { lexicon: string } } }) {}
  }

  it('joins the lexicons into the comma-separated list Kokoro reads', () => {
    const tts = createKokoroTts({ OfflineTts: FakeOfflineTts }, { kokoro: '/mock/kokoro', lexicons: ['/mock/a.txt', '/mock/b.txt'] });
    expect(tts.config.model.kokoro.lexicon).toBe('/mock/a.txt,/mock/b.txt');
  });

  it('names a lexicon path holding a comma, which would split the list', () => {
    expect(() => createKokoroTts({ OfflineTts: FakeOfflineTts }, { kokoro: '/mock/kokoro', lexicons: ['/mock/a,b/lexicon.txt'] }))
      .toThrow('/mock/a,b/lexicon.txt');
  });
});

describe('spokenWords', () => {
  it('lowercases, drops punctuation, and keeps an apostrophe inside a word', () => {
    expect(spokenWords("Can't fix it, Push to talk.")).toEqual(["can't", 'fix', 'it', 'push', 'to', 'talk']);
  });
});

describe('assertLexiconCovers', () => {
  let directory: string;
  let lexicon: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-lexicon-'));
    lexicon = path.join(directory, 'lexicon.txt');
    fs.writeFileSync(lexicon, '# header\npush || p ʊ ʃ\nto || t uː\ntalk || t ɔ k\n');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('passes when every word is defined', () => {
    expect(() => assertLexiconCovers([lexicon], ['Push to talk.'])).not.toThrow();
  });

  it('names each missing word once, across every text', () => {
    expect(() => assertLexiconCovers([lexicon], ['Push the dropdown.', 'The dropdown.']))
      .toThrow(/No lexicon defines the, dropdown\./);
  });

  it('takes a word from any of the files, which is what lets the extra lexicon fill a gap', () => {
    expect(() => assertLexiconCovers([lexicon], ['push the dropdown'])).toThrow();
    const extra = path.join(directory, 'extra.txt');
    fs.writeFileSync(extra, 'the || ð ə\ndropdown || d ɹˈ ɑː p d a ʊ n\n');
    expect(() => assertLexiconCovers([lexicon, extra], ['push the dropdown'])).not.toThrow();
  });
});

describe('assertGeneratedAudio', () => {
  it('passes real samples', () => {
    expect(() => assertGeneratedAudio({ samples: new Float32Array(10) }, 'hello')).not.toThrow();
  });

  it('throws on no samples, and on no result at all, naming the text', () => {
    expect(() => assertGeneratedAudio({ samples: new Float32Array(0) }, 'hello')).toThrow(/no audio for "hello"/);
    expect(() => assertGeneratedAudio(undefined, 'hello')).toThrow(/no audio for "hello"/);
  });
});
