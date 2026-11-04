/**
 * Droid capability discovery: concurrent reads, failure handling, caching of
 * an empty help text, and the parser's edges around effort levels.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearDroidCapabilityCache,
  discoverDroidCapabilities,
  parseDroidExecHelpModels,
} from '../../src/main/agent/adapters/droid/capability-discovery';

const CLI_PATH = '/usr/bin/droid';

const MODEL_HELP = [
  'Available Models:',
  '  model-a  Model A',
  '',
].join('\n');

beforeEach(() => clearDroidCapabilityCache());

/** A reader that counts its calls and finishes only when the test says so. */
function deferredReader(helpText: string): { reader: (cliPath: string) => Promise<string>; reads: () => number; finish: () => void; fail: () => void } {
  let readCount = 0;
  const settlers: Array<{ resolve: (text: string) => void; reject: (error: Error) => void }> = [];
  return {
    reader: () => {
      readCount += 1;
      return new Promise<string>((resolve, reject) => settlers.push({ resolve, reject }));
    },
    reads: () => readCount,
    finish: () => settlers.splice(0).forEach((settler) => settler.resolve(helpText)),
    fail: () => settlers.splice(0).forEach((settler) => settler.reject(new Error('timeout'))),
  };
}

describe('discoverDroidCapabilities concurrency', () => {
  it('shares one read between non-forced calls that arrive together', async () => {
    const deferred = deferredReader(MODEL_HELP);
    const first = discoverDroidCapabilities(CLI_PATH, false, deferred.reader);
    const second = discoverDroidCapabilities(CLI_PATH, false, deferred.reader);
    deferred.finish();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(deferred.reads()).toBe(1);
    expect(firstResult.models).toEqual(['model-a']);
    expect(secondResult.models).toEqual(['model-a']);
  });

  it('does not let a forced refresh join a read that is already pending', async () => {
    const deferred = deferredReader(MODEL_HELP);
    const pending = discoverDroidCapabilities(CLI_PATH, false, deferred.reader);
    const forced = discoverDroidCapabilities(CLI_PATH, true, deferred.reader);
    deferred.finish();
    await Promise.all([pending, forced]);
    expect(deferred.reads()).toBe(2);
  });

  it('leaves no pending read behind when one throws, so the next call reads again', async () => {
    const failing = deferredReader(MODEL_HELP);
    const failed = discoverDroidCapabilities(CLI_PATH, false, failing.reader);
    failing.fail();
    expect((await failed).models).toBeUndefined();

    const retry = deferredReader(MODEL_HELP);
    const retried = discoverDroidCapabilities(CLI_PATH, false, retry.reader);
    retry.finish();
    expect((await retried).models).toEqual(['model-a']);
    expect(retry.reads()).toBe(1);
  });

  it('caches a successful read of help text with no model blocks until a forced refresh', async () => {
    let reads = 0;
    const reader = async (): Promise<string> => {
      reads += 1;
      return 'Usage: droid exec [options] [prompt]\n';
    };
    await discoverDroidCapabilities(CLI_PATH, false, reader);
    await discoverDroidCapabilities(CLI_PATH, false, reader);
    expect(reads).toBe(1);
    await discoverDroidCapabilities(CLI_PATH, true, reader);
    expect(reads).toBe(2);
  });
});

describe('parseDroidExecHelpModels effort edges', () => {
  it('gives a model no levels when its details say it does not support reasoning', () => {
    const help = [
      'Available Models:',
      '  model-a  Model A',
      '',
      'Model details:',
      '  - Model A: supports reasoning: No; supported: [low, high]; default: low',
      '',
    ].join('\n');
    expect(parseDroidExecHelpModels(help).effortLevelsByModel).toEqual({});
  });

  it('lists an id once, with its first display name, when both blocks name it', () => {
    const help = [
      'Available Models:',
      '  shared-id  First Name',
      '',
      'Custom Models:',
      '  shared-id  Second Name',
      '',
    ].join('\n');
    const parsed = parseDroidExecHelpModels(help);
    expect(parsed.models).toEqual(['shared-id']);
    expect(parsed.modelDisplayNames['shared-id']).toBe('First Name');
  });

  it('gives neither of two ids sharing a display name the levels, but keeps a uniquely named model\'s', () => {
    const help = [
      'Available Models:',
      '  opus-a  Opus 5',
      '  unique-id  Unique Model',
      '',
      'Custom Models:',
      '  custom:opus  Opus 5',
      '',
      'Model details:',
      '  - Opus 5: supports reasoning: Yes; supported: [low, high]; default: high',
      '  - Unique Model: supports reasoning: Yes; supported: [low, medium]; default: low',
      '',
    ].join('\n');
    const { effortLevelsByModel } = parseDroidExecHelpModels(help);
    expect(effortLevelsByModel['opus-a']).toBeUndefined();
    expect(effortLevelsByModel['custom:opus']).toBeUndefined();
    expect(effortLevelsByModel['unique-id']).toEqual(['low', 'medium']);
  });
});
