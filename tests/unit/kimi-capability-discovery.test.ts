/**
 * Capability discovery for Kimi Code: the aliases, names and efforts the
 * pickers offer come from the user's own config. What a user loses if this
 * breaks: a Model row with nothing in it, or one offering what `--model`
 * rejects. `discoverCapabilities`' WSL routing is pinned by
 * `wsl-adapter-headless-runs.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { capabilitiesFromConfig, helpTextHasModelFlag } from '../../src/main/agent/adapters/kimi/capability-discovery';
import { parseKimiCodeConfig } from '../../src/main/agent/adapters/kimi/config-toml';

const HELP = `Usage: kimi [options] [command]

Options:
  -V, --version          output the version number
  -m, --model <model>    Model alias
  -p, --prompt <prompt>  Run one prompt non-interactively and print the response
`;

describe('helpTextHasModelFlag', () => {
  it('finds the model flag in the help text', () => {
    expect(helpTextHasModelFlag(HELP)).toBe(true);
  });

  it('does not read one into text with none', () => {
    expect(helpTextHasModelFlag('Usage: kimi\n  --modelling nothing\n')).toBe(false);
    // The archived kimi-cli 1.52 stub prints only a deprecation notice.
    expect(helpTextHasModelFlag('kimi-cli is no longer maintained.')).toBe(false);
  });
});

describe('capabilitiesFromConfig', () => {
  const config = parseKimiCodeConfig(`
[models."kimi-code/k3"]
display_name = "K3"
support_efforts = ["low", "high", "max"]

[models."kimi-code/kimi-for-coding"]
max_context_size = 262144

[models.other]
support_efforts = ["high", "xhigh"]
`);

  it('offers the aliases, their names, and the union of their efforts', () => {
    expect(capabilitiesFromConfig(config, true)).toEqual({
      supportsModelOverride: true,
      models: ['kimi-code/k3', 'kimi-code/kimi-for-coding', 'other'],
      modelDisplayNames: { 'kimi-code/k3': 'K3' },
      effortLevels: ['low', 'high', 'max', 'xhigh'],
    });
  });

  it('offers no list without the flag, or with no models, so the row falls back to free text', () => {
    expect(capabilitiesFromConfig(config, false).models).toBeUndefined();
    expect(capabilitiesFromConfig({ defaultModel: null, models: [] }, true)).toEqual({
      supportsModelOverride: true,
      models: undefined,
      modelDisplayNames: undefined,
      effortLevels: [],
    });
  });
});
