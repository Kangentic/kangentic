/**
 * Droid's model list comes from the CLI's own `droid exec --help` (0.218.0),
 * which the headless runs (`droid exec --model`) use. The column pickers stay
 * hidden: interactive `droid` lists no `--model` flag.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  clearDroidCapabilityCache,
  discoverDroidCapabilities,
  parseDroidExecHelpModels,
} from '../../src/main/agent/adapters/droid/capability-discovery';

const HELP_TEXT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'droid-exec-help-0.218.0.txt'), 'utf-8');

beforeEach(() => clearDroidCapabilityCache());

describe('parseDroidExecHelpModels', () => {
  it('reads the Available and Custom Models blocks, in the CLI\'s order', () => {
    const { models } = parseDroidExecHelpModels(HELP_TEXT);
    expect(models).toEqual([
      'auto',
      'claude-opus-5',
      'claude-sonnet-4-5-20250929',
      'gpt-5.6-sol',
      'gemini-3.1-pro-preview',
      'glm-5.3',
      'minimax-m2.7',
      'custom:Example-Model-[BYOK]-0',
    ]);
  });

  it('names each model as the CLI does, without the default marker', () => {
    const { modelDisplayNames } = parseDroidExecHelpModels(HELP_TEXT);
    expect(modelDisplayNames['gpt-5.6-sol']).toBe('GPT-5.6 Sol');
    expect(modelDisplayNames['glm-5.3']).toBe('GLM-5.3 (Droid Core)');
    expect(modelDisplayNames['custom:Example-Model-[BYOK]-0']).toBe('Example Model [BYOK]');
  });

  it('reads no flag, autonomy or model-details row as a model', () => {
    const { models } = parseDroidExecHelpModels(HELP_TEXT);
    expect(models.some((id) => id.startsWith('-'))).toBe(false);
    expect(models).not.toContain('DEFAULT');
    expect(models).not.toContain('-');
  });

  it('reads each reasoning model\'s own levels from the details, keyed by id', () => {
    const { effortLevelsByModel } = parseDroidExecHelpModels(HELP_TEXT);
    expect(effortLevelsByModel).toEqual({
      'claude-opus-5': ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      // The display name carried a (default) marker in the list but not in the details.
      'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
    // A model that does not reason takes no level, so it has no entry.
    expect(effortLevelsByModel.auto).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    expect(parseDroidExecHelpModels(HELP_TEXT.replace(/\n/g, '\r\n')).models).toHaveLength(8);
  });

  it('is empty for help text with no model blocks', () => {
    const empty = { models: [], modelDisplayNames: {}, effortLevelsByModel: {} };
    expect(parseDroidExecHelpModels('Usage: droid exec [options] [prompt]\n\nOptions:\n  -h, --help  display help\n')).toEqual(empty);
    expect(parseDroidExecHelpModels('')).toEqual(empty);
  });
});

describe('discoverDroidCapabilities', () => {
  it('reports the listed models and keeps the column pickers hidden', async () => {
    const capabilities = await discoverDroidCapabilities('/usr/bin/droid', false, async () => HELP_TEXT);
    expect(capabilities.supportsModelOverride).toBe(false);
    expect(capabilities.effortLevels).toEqual([]);
    expect(capabilities.models).toContain('gpt-5.6-sol');
    expect(capabilities.modelDisplayNames?.['claude-opus-5']).toBe('Opus 5');
    expect(capabilities.effortLevelsByModel?.['claude-opus-5']).toContain('xhigh');
  });

  it('reports no model list, and never throws, when the help run fails', async () => {
    const capabilities = await discoverDroidCapabilities('/usr/bin/droid', false, async () => {
      throw new Error('spawn ENOENT');
    });
    expect(capabilities).toEqual({ supportsModelOverride: false, effortLevels: [] });
  });

  it('caches per CLI path until a forced refresh', async () => {
    let reads = 0;
    const reader = async (): Promise<string> => {
      reads += 1;
      return HELP_TEXT;
    };
    await discoverDroidCapabilities('/usr/bin/droid', false, reader);
    await discoverDroidCapabilities('/usr/bin/droid', false, reader);
    expect(reads).toBe(1);
    await discoverDroidCapabilities('/usr/bin/droid', true, reader);
    expect(reads).toBe(2);
    await discoverDroidCapabilities('/opt/other/droid', false, reader);
    expect(reads).toBe(3);
  });

  it('does not cache a failed read', async () => {
    await discoverDroidCapabilities('/usr/bin/droid', false, async () => {
      throw new Error('timeout');
    });
    const capabilities = await discoverDroidCapabilities('/usr/bin/droid', false, async () => HELP_TEXT);
    expect(capabilities.models?.length).toBe(8);
  });
});
