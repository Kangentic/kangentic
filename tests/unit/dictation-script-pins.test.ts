import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, getModel } from '../../src/main/transcription/models/model-registry';
import type { ResolvedModel } from '../../src/main/transcription/engines/transcription-engine';
import { buildOfflineConfig } from '../../src/main/transcription/engines/sherpa-whisper-engine';
import { SherpaOnlineEngine } from '../../src/main/transcription/engines/sherpa-online-engine';
import * as recipes from '../../scripts/lib/dictation-engine-recipes.mjs';

// The engines import sherpa-onnx-node, a native addon. It is mocked so that this
// file can load them without it, and so a SherpaOnlineEngine session can be driven
// against a recorder: what it asks of the OnlineRecognizer and of each stream is
// the recipe the scripts' shared module has to repeat.
const sherpaHarness = vi.hoisted(() => {
  const onlineRecognizerConfigs: unknown[] = [];
  const engineEvents: string[] = [];

  /** A stream that appends what it is asked to do to `events`, one entry per call. */
  function recordingStream(events: string[]) {
    return {
      setOption: (name: string, value: string): void => {
        events.push(`setOption:${name}:${value}`);
      },
      acceptWaveform: (waveform: { sampleRate: number; samples: Float32Array }): void => {
        events.push(`accept:${waveform.sampleRate}:${waveform.samples.length}`);
      },
      inputFinished: (): void => {
        events.push('inputFinished');
      },
    };
  }

  /** A recognizer with no work pending and no text, whose streams record into `events`. */
  function recordingRecognizer(events: string[]) {
    return {
      createStream: () => recordingStream(events),
      isReady: (): boolean => false,
      decode: (): void => {},
      getResult: (): { text: string } => ({ text: '' }),
    };
  }

  return { onlineRecognizerConfigs, engineEvents, recordingRecognizer };
});

vi.mock('sherpa-onnx-node', () => {
  class OnlineRecognizer {
    constructor(config: unknown) {
      sherpaHarness.onlineRecognizerConfigs.push(config);
    }
    createStream() {
      return sherpaHarness.recordingRecognizer(sherpaHarness.engineEvents).createStream();
    }
    isReady(): boolean {
      return false;
    }
    decode(): void {}
    getResult(): { text: string } {
      return { text: '' };
    }
  }
  return { OnlineRecognizer };
});

/**
 * `scripts/measure-dictation-models.mjs` and `scripts/smoke-dictation.mjs` pin
 * Hugging Face repos and commits by hand, copied from the model registry
 * (`src/main/transcription/models/model-registry.ts`). Both scripts are plain
 * Node and cannot import the registry, so a repin there would leave a script
 * measuring or smoke-testing the old weights with nothing to say so.
 *
 * This reads the registry's real data and both scripts as text, and requires that
 * every repo a script pins and the registry pins is at the same revision.
 *
 * The scripts pin in five shapes, and each is parsed:
 *
 *   url                 'https://huggingface.co/<repo>/resolve/<revision>'
 *   transducer-call     transducer('<repo>', '<revision>')
 *   repo-revision-pair  repo: '<repo>', revision: '<revision>'
 *   repo-constant-pair  repo: ZIPFORMER, revision: '<revision>'  (RESOLVED: the
 *                       name is looked up in a `const NAME = '<repo>'` line)
 *   tuple-constant      ['<repo>', '<revision>']  (the NEMOTRON_EN constant)
 *
 * `transducer(...NEMOTRON_EN)` is a spread of the tuple constant, so the tuple
 * is the pin and the spread is ignored.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

type PinShape = 'url' | 'transducer-call' | 'repo-revision-pair' | 'repo-constant-pair' | 'tuple-constant';

interface HuggingFacePin {
  repo: string;
  revision: string;
  shape: PinShape;
}

interface ExtractedPins {
  pins: HuggingFacePin[];
  /** `repo: NAME` references with no `const NAME = '<repo>'` to resolve against. */
  unresolvedConstants: string[];
}

// An owner/repo pair and a revision (a branch name or a commit hash). The classes
// leave out `$` and `{`, so the `${repo}` template in the scripts' `hf` helper is
// not read as a pin, and the slash keeps a lone file name out of the repo slot.
const REPO_PATTERN = String.raw`[\w.-]+/[\w.-]+`;
const REVISION_PATTERN = String.raw`[\w.-]+`;

function extractPins(source: string): ExtractedPins {
  const pins: HuggingFacePin[] = [];
  const unresolvedConstants: string[] = [];

  const repoConstants = new Map<string, string>();
  for (const match of source.matchAll(new RegExp(String.raw`const\s+(\w+)\s*=\s*'(${REPO_PATTERN})'`, 'g'))) {
    repoConstants.set(match[1], match[2]);
  }

  const collect = (pattern: RegExp, shape: PinShape): void => {
    for (const match of source.matchAll(pattern)) {
      pins.push({ repo: match[1], revision: match[2], shape });
    }
  };
  collect(new RegExp(String.raw`https://huggingface\.co/(${REPO_PATTERN})/resolve/(${REVISION_PATTERN})`, 'g'), 'url');
  collect(new RegExp(String.raw`transducer\(\s*'(${REPO_PATTERN})'\s*,\s*'(${REVISION_PATTERN})'\s*\)`, 'g'), 'transducer-call');
  collect(new RegExp(String.raw`repo:\s*'(${REPO_PATTERN})'\s*,\s*revision:\s*'(${REVISION_PATTERN})'`, 'g'), 'repo-revision-pair');
  collect(new RegExp(String.raw`\[\s*'(${REPO_PATTERN})'\s*,\s*'(${REVISION_PATTERN})'\s*\]`, 'g'), 'tuple-constant');

  for (const match of source.matchAll(new RegExp(String.raw`repo:\s*([A-Z][A-Z0-9_]*)\s*,\s*revision:\s*'(${REVISION_PATTERN})'`, 'g'))) {
    const repo = repoConstants.get(match[1]);
    if (repo === undefined) unresolvedConstants.push(match[1]);
    else pins.push({ repo, revision: match[2], shape: 'repo-constant-pair' });
  }

  return { pins, unresolvedConstants };
}

/** The registry's repo -> revisions, from the `resolve/<revision>` of every file URL it downloads. */
function registryRevisionsByRepo(): { revisionsByRepo: Map<string, Set<string>>; unparsedUrls: string[] } {
  const revisionsByRepo = new Map<string, Set<string>>();
  const unparsedUrls: string[] = [];
  const urlPattern = new RegExp(String.raw`^https://huggingface\.co/(${REPO_PATTERN})/resolve/(${REVISION_PATTERN})/`);
  for (const model of MODELS) {
    for (const file of model.files) {
      const match = urlPattern.exec(file.url);
      if (!match) {
        unparsedUrls.push(file.url);
        continue;
      }
      const revisions = revisionsByRepo.get(match[1]) ?? new Set<string>();
      revisions.add(match[2]);
      revisionsByRepo.set(match[1], revisions);
    }
  }
  return { revisionsByRepo, unparsedUrls };
}

const { revisionsByRepo: registryRevisions, unparsedUrls: unparsedRegistryUrls } = registryRevisionsByRepo();

describe('the registry the script pins are read against', () => {
  it('has every file URL in the shape the pins are read from, and finds the registry\'s repos', () => {
    expect(unparsedRegistryUrls).toEqual([]);
    // 17 repos today. A floor well under that, so a parser that reads none cannot pass the tests below.
    expect(registryRevisions.size).toBeGreaterThanOrEqual(10);
  });

  it('downloads each repo at one revision, so "the registry\'s revision" names a single commit', () => {
    for (const [repo, revisions] of registryRevisions) {
      expect([...revisions], `${repo} is pinned at more than one revision`).toHaveLength(1);
    }
  });
});

interface ScriptUnderTest {
  file: string;
  /** Distinct repos the script pins that the registry also pins, as of today. A
   *  parser that stops matching a shape drops below it. */
  sharedRepoFloor: number;
  /** The shapes the script pins in today, which the parser must keep reading. */
  shapesInUse: PinShape[];
}

const SCRIPTS_UNDER_TEST: ScriptUnderTest[] = [
  {
    file: 'scripts/measure-dictation-models.mjs',
    sharedRepoFloor: 6,
    shapesInUse: ['transducer-call', 'repo-revision-pair', 'repo-constant-pair', 'tuple-constant'],
  },
  {
    file: 'scripts/smoke-dictation.mjs',
    sharedRepoFloor: 9,
    shapesInUse: ['url'],
  },
];

for (const script of SCRIPTS_UNDER_TEST) {
  describe(`${script.file} model pins`, () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, script.file), 'utf8');
    const { pins, unresolvedConstants } = extractPins(source);
    const sharedPins = pins.filter((pin) => registryRevisions.has(pin.repo));

    it('resolves every repo constant a pin refers to', () => {
      expect(unresolvedConstants).toEqual([]);
    });

    it('is read in every shape it pins in, and shares enough repos with the registry for the check below to mean something', () => {
      const shapesRead = new Set(pins.map((pin) => pin.shape));
      for (const shape of script.shapesInUse) {
        expect(shapesRead, `no ${shape} pin was read from ${script.file}`).toContain(shape);
      }
      const sharedRepos = new Set(sharedPins.map((pin) => pin.repo));
      expect(sharedRepos.size).toBeGreaterThanOrEqual(script.sharedRepoFloor);
    });

    it('pins every repo the registry also pins at the registry\'s revision', () => {
      const mismatches = sharedPins
        .filter((pin) => !registryRevisions.get(pin.repo)!.has(pin.revision))
        .map((pin) => `${pin.repo}: ${script.file} pins ${pin.revision} (${pin.shape}), the registry pins ${[...registryRevisions.get(pin.repo)!].join(', ')}`);
      expect(mismatches).toEqual([]);
    });
  });
}

/**
 * `scripts/lib/dictation-engine-recipes.mjs` is what both scripts load and stream
 * a model through, so it is the one place that has to match the engines. The
 * engines are TypeScript in the dictation worker's bundle and a plain Node script
 * cannot import them, so this imports the module and holds it to the engines and
 * the registry instead: the recognizer configs to `buildOfflineConfig` and
 * `SherpaOnlineEngine.load`, the stream recipe to a `SherpaOnlineEngine` session,
 * and the file lists and roles to the model registry.
 *
 * Every comparison passes the same literal paths to both sides, with forward
 * slashes on purpose: `path.join` would differ by platform and say nothing here.
 */
describe('scripts/lib/dictation-engine-recipes.mjs matches the engines and the registry', () => {
  beforeEach(() => {
    sherpaHarness.onlineRecognizerConfigs.length = 0;
    sherpaHarness.engineEvents.length = 0;
  });

  const TRANSDUCER_PATHS = {
    encoder: '/models/encoder.int8.onnx',
    decoder: '/models/decoder.int8.onnx',
    joiner: '/models/joiner.int8.onnx',
    tokens: '/models/tokens.txt',
  };
  const COHERE_PATHS = {
    encoder: '/models/cohere/encoder.int8.onnx',
    decoder: '/models/cohere/decoder.int8.onnx',
    tokens: '/models/cohere/tokens.txt',
  };

  describe('recognizer configs', () => {
    it('builds the NeMo transducer config buildOfflineConfig builds', () => {
      const engineConfig = buildOfflineConfig({
        id: 'parakeet-tdt-0.6b-v3',
        engineId: 'whisper-cpp',
        kind: 'offline-nemo-transducer',
        paths: TRANSDUCER_PATHS,
      });

      expect(recipes.offlineRecognizerConfig('offline-nemo-transducer', TRANSDUCER_PATHS)).toStrictEqual(engineConfig);
    });

    it('builds the Cohere Transcribe config buildOfflineConfig builds, with punctuation and inverse text normalization on', () => {
      const engineConfig = buildOfflineConfig({
        id: 'cohere-transcribe-2b',
        engineId: 'whisper-cpp',
        kind: 'offline-cohere-transcribe',
        paths: COHERE_PATHS,
      });
      const scriptConfig = recipes.offlineRecognizerConfig('offline-cohere-transcribe', COHERE_PATHS);

      expect(scriptConfig).toStrictEqual(engineConfig);
      // The premise: the engine's config really does carry both switches, so the
      // equality above is not two configs that both left them out.
      expect(scriptConfig.modelConfig.cohereTranscribe).toMatchObject({ usePunct: 1, useItn: 1 });
    });

    it('refuses a kind the scripts do not load, instead of quietly building a Whisper config', () => {
      expect(() => recipes.offlineRecognizerConfig('offline-whisper', COHERE_PATHS)).toThrow(/No offline recognizer config/);
    });

    it('builds the config SherpaOnlineEngine.load passes to the OnlineRecognizer', async () => {
      const model: ResolvedModel = {
        id: 'streaming-zipformer-en',
        engineId: 'sherpa-online',
        kind: 'online-transducer',
        paths: TRANSDUCER_PATHS,
      };
      await new SherpaOnlineEngine('en').load([model]);

      expect(sherpaHarness.onlineRecognizerConfigs).toHaveLength(1);
      expect(recipes.onlineRecognizerConfig(TRANSDUCER_PATHS)).toStrictEqual(sherpaHarness.onlineRecognizerConfigs[0]);
    });
  });

  describe('streamDecode', () => {
    // 20000 samples is twelve pushes of 1600 and a last one of 800, so a clip that
    // does not divide into whole pushes is covered as well.
    const SAMPLE_RATE = 16000;
    const CLIP_SAMPLES = 20000;

    it('feeds the stream what a SherpaOnlineEngine session feeds it for the same clip', async () => {
      const pushSamples = Math.round(SAMPLE_RATE * recipes.PUSH_SECONDS);

      // The engine: the clip arrives in pushes of the size the script uses, then finalize.
      const engine = new SherpaOnlineEngine('de');
      await engine.load([
        { id: 'nemotron-3.5-streaming-0.6b', engineId: 'sherpa-online', kind: 'online-transducer', paths: TRANSDUCER_PATHS },
      ]);
      const session = engine.createSession({ sampleRate: SAMPLE_RATE, language: 'de', onPartial: () => {} });
      const clip = new Int16Array(CLIP_SAMPLES);
      const expectedPushes: string[] = [];
      for (let index = 0; index < clip.length; index += pushSamples) {
        const push = clip.subarray(index, index + pushSamples);
        expectedPushes.push(`accept:${SAMPLE_RATE}:${push.length}`);
        session.push(push);
      }
      await session.finalize();

      // The script: the same clip through the recipe, against a recorder.
      const scriptEvents: string[] = [];
      recipes.streamDecode(
        sherpaHarness.recordingRecognizer(scriptEvents),
        { sampleRate: SAMPLE_RATE, samples: new Float32Array(CLIP_SAMPLES) },
        'de',
      );

      // The engine's own sequence first, so the comparison below is not two empty or
      // equally wrong logs: the language pinned, 0.6 s of lead silence at the press,
      // every push, 0.5 s of tail silence, then the input closed once.
      expect(sherpaHarness.engineEvents).toEqual([
        'setOption:language:de',
        'accept:16000:9600',
        ...expectedPushes,
        'accept:16000:8000',
        'inputFinished',
      ]);
      expect(expectedPushes.length).toBeGreaterThan(1);
      expect(scriptEvents).toEqual(sherpaHarness.engineEvents);
    });
  });

  describe('model files and roles', () => {
    const sortedFileNames = (modelId: string): string[] =>
      getModel(modelId)!.files.map((file) => file.file).sort();

    it('lists the Cohere Transcribe files and roles the registry downloads and loads', () => {
      expect([...recipes.COHERE_TRANSCRIBE_FILES].sort()).toEqual(sortedFileNames('cohere-transcribe-2b'));
      expect(recipes.COHERE_TRANSCRIBE_ROLES).toEqual(getModel('cohere-transcribe-2b')!.roles);
      // The encoder's weights sit beside it in a data file the graph refers to by name.
      expect(recipes.COHERE_TRANSCRIBE_FILES).toContain('encoder.int8.onnx.data');
    });

    it('lists the transducer files and roles Parakeet v3 downloads and loads', () => {
      expect([...recipes.TRANSDUCER_FILES].sort()).toEqual(sortedFileNames('parakeet-tdt-0.6b-v3'));
      expect(recipes.TRANSDUCER_ROLES).toEqual(getModel('parakeet-tdt-0.6b-v3')!.roles);
    });
  });
});
