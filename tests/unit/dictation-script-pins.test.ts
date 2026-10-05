import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../../src/main/transcription/models/model-registry';

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
