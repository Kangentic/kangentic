import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  EMBEDDING_RUNTIME_GAP_TARGETS,
  embeddingRuntimeGapName,
  isEmbeddingRuntimeSupported,
} from '../../src/shared/embedding-runtime';
import { englishText } from '../../src/shared/i18n/english';

// The Knowledge Graph's local model runs on onnxruntime-node, which @huggingface/transformers
// requires at module scope. A target with no onnxruntime binding cannot fork the embed worker at
// all, so the app reports the Knowledge Graph unavailable there (src/shared/embedding-runtime.ts),
// and build/afterPack.js skips the packaged embed worker probe for it.
//
// Both read embedding-runtime-gaps.json, and this checks that list against the bindings the
// installed onnxruntime-node actually ships. The npm package carries every platform's binaries
// whatever the host, so this answers the same on Windows, macOS and Linux. An onnxruntime bump
// that drops a target fails here before a release ships a worker that exits on every fork, and
// one that adds darwin x64 back fails here too, so the gap is lifted rather than left in place.

const REPO_ROOT = path.resolve(__dirname, '../..');

/** The package directory above a resolved entry file. */
function packageRootOf(entryPath: string, packageName: string): string {
  let directory = path.dirname(entryPath);
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath) && (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: string }).name === packageName) {
      return directory;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`No ${packageName} package above ${entryPath}`);
}

// onnxruntime-node as @huggingface/transformers resolves it, which is the copy the worker loads.
// Both packages' `exports` hide package.json, so resolve each entry and walk up to its root.
const transformersRoot = packageRootOf(createRequire(path.join(REPO_ROOT, 'package.json')).resolve('@huggingface/transformers'), '@huggingface/transformers');
const onnxruntimeRoot = packageRootOf(createRequire(path.join(transformersRoot, 'package.json')).resolve('onnxruntime-node'), 'onnxruntime-node');

/** The path onnxruntime-node's dist/binding.js requires for a platform and arch. */
function bindingPath(platform: string, arch: string): string {
  return path.join(onnxruntimeRoot, 'bin', 'napi-v6', platform, arch, 'onnxruntime_binding.node');
}

const TARGETS = ['darwin', 'linux', 'win32'].flatMap((platform) => ['x64', 'arm64'].map((arch) => [platform, arch] as const));

describe('embedding runtime support', () => {
  it('still loads its binding from the path this test and afterPack check', () => {
    // If onnxruntime-node moved its binaries, every check below would read "no binding" and the
    // list would look wrong for a reason that is not the list.
    const bindingSource = fs.readFileSync(path.join(onnxruntimeRoot, 'dist', 'binding.js'), 'utf8');
    expect(bindingSource).toContain('../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node');
  });

  it.each(TARGETS)('%s %s is supported exactly when onnxruntime-node ships its binding', (platform, arch) => {
    expect(isEmbeddingRuntimeSupported(platform, arch)).toBe(fs.existsSync(bindingPath(platform, arch)));
  });

  it('lists only Intel macOS today, and every release target outside it is supported', () => {
    expect([...EMBEDDING_RUNTIME_GAP_TARGETS]).toEqual(['darwin-x64']);
    // The release legs (release.yml): Windows x64, macOS arm64 and x64, Linux x64 and arm64.
    expect(isEmbeddingRuntimeSupported('win32', 'x64')).toBe(true);
    expect(isEmbeddingRuntimeSupported('darwin', 'arm64')).toBe(true);
    expect(isEmbeddingRuntimeSupported('linux', 'x64')).toBe(true);
    expect(isEmbeddingRuntimeSupported('linux', 'arm64')).toBe(true);
    expect(isEmbeddingRuntimeSupported('darwin', 'x64')).toBe(false);
  });

  it('names the machines a gap covers in words a user knows', () => {
    expect(englishText(embeddingRuntimeGapName('darwin', 'x64'))).toBe('Intel Macs');
    expect(englishText(embeddingRuntimeGapName('freebsd', 'x64'))).toBe('freebsd x64');
  });
});
