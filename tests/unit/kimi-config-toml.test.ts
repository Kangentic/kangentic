/**
 * The `config.toml` reader behind Kimi Code's model picker. The aliases are
 * what `--model` takes, and Kangentic keeps no list of its own, so a misread
 * here empties or corrupts the picker. Input is shaped to the "Complete
 * example" and "Model overrides" sections of `docs/en/configuration/config-files.md`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kimiModelByAlias, parseKimiCodeConfig } from '../../src/main/agent/adapters/kimi/config-toml';

const DOCUMENTED = `
default_model = "kimi-code/k3"
default_permission_mode = "manual"
default_plan_mode = false

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://example.invalid/v1"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = [ "thinking", "image_in" ]
display_name = "K3"
support_efforts = [ "low", "high", "max" ]
default_effort = "max"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262_144 # a comment

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 131072
display_name = "Kimi for Coding (custom)"

[models."gpt-4.1"]
provider = "openai"
model = "gpt-4.1"
max_context_size = 1047576

[thinking]
enabled = true

[[hooks]]
event = "Stop"
command = "echo # not a comment"
default_model = "from-a-hook"
`;

describe('parseKimiCodeConfig', () => {
  it('reads the default model and every alias, quoted keys included', () => {
    const config = parseKimiCodeConfig(DOCUMENTED);
    expect(config.defaultModel).toBe('kimi-code/k3');
    expect(config.models.map((model) => model.alias)).toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding', 'gpt-4.1']);
  });

  it('reads a model\'s fields', () => {
    expect(parseKimiCodeConfig(DOCUMENTED).models[0]).toEqual({
      alias: 'kimi-code/k3',
      displayName: 'K3',
      maxContextSize: 1048576,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    });
  });

  it('lets a model\'s overrides win', () => {
    const model = parseKimiCodeConfig(DOCUMENTED).models[1];
    expect(model.maxContextSize).toBe(131072);
    expect(model.displayName).toBe('Kimi for Coding (custom)');
  });

  it('reads a multi-line array', () => {
    const config = parseKimiCodeConfig('[models.a]\nsupport_efforts = [\n  "low", # first\n  "high",\n]\n');
    expect(config.models[0].supportEfforts).toEqual(['low', 'high']);
  });

  it('reads a bare key and a single-quoted one', () => {
    const config = parseKimiCodeConfig("[models.k3-max]\nmodel = 'k3'\n[models.'a.b']\nmodel = \"x\"\n");
    expect(config.models.map((model) => model.alias)).toEqual(['k3-max', 'a.b']);
  });

  it('takes no key from an array of tables or a nested table', () => {
    const config = parseKimiCodeConfig('[[hooks]]\ndefault_model = "wrong"\n[secondary_model]\ndefault_model = "also-wrong"\n');
    expect(config.defaultModel).toBeNull();
    expect(config.models).toEqual([]);
  });

  it('skips what it cannot read without failing', () => {
    expect(parseKimiCodeConfig('= broken\n[models\nnot a line\n')).toEqual({ defaultModel: null, models: [] });
    expect(parseKimiCodeConfig('')).toEqual({ defaultModel: null, models: [] });
  });

  it('lists an alias whose table holds no scalar key', () => {
    const config = parseKimiCodeConfig('[models."bare"]\n[models."nested".capabilities]\nthinking = true\n');
    expect(config.models.map((model) => model.alias)).toEqual(['bare', 'nested']);
    expect(config.models[0]).toEqual({ alias: 'bare', displayName: null, maxContextSize: null, supportEfforts: [], defaultEffort: null });
  });

  it('lists an alias defined only by its overrides table', () => {
    const config = parseKimiCodeConfig('[models."only-overrides".overrides]\ndisplay_name = "Custom"\nmax_context_size = 4096\n');
    expect(config.models).toEqual([
      { alias: 'only-overrides', displayName: 'Custom', maxContextSize: 4096, supportEfforts: [], defaultEffort: null },
    ]);
  });

  it('reads a file saved with a BOM before the first key and before a models header', () => {
    expect(parseKimiCodeConfig('﻿default_model = "kimi-code/k3"\n').defaultModel).toBe('kimi-code/k3');
    expect(parseKimiCodeConfig('﻿[models."kimi-code/k3"]\ndisplay_name = "K3"\n').models.map((model) => model.alias)).toEqual(['kimi-code/k3']);
  });

  describe('a multi-line string', () => {
    it.each(['"""', "'''"])('holds no key or header the reader takes (%s, across lines)', (delimiter) => {
      const text = [
        'default_model = "real"',
        `note = ${delimiter}`,
        'default_model = "evil"',
        '[models."evil"]',
        delimiter,
        '[models.a]',
        'display_name = "A"',
      ].join('\n');
      const config = parseKimiCodeConfig(text);
      expect(config.defaultModel).toBe('real');
      expect(config.models.map((model) => model.alias)).toEqual(['a']);
      expect(config.models[0].displayName).toBe('A');
    });

    it.each(['"""', "'''"])('holds no key or header the reader takes (%s, on one line)', (delimiter) => {
      const text = [
        'default_model = "real"',
        `note = ${delimiter}default_model = "evil" [models."evil"]${delimiter}`,
        '[models.a]',
        'display_name = "A"',
      ].join('\n');
      const config = parseKimiCodeConfig(text);
      expect(config.defaultModel).toBe('real');
      expect(config.models.map((model) => model.alias)).toEqual(['a']);
    });

    it('keeps reading fields after the string closes', () => {
      const config = parseKimiCodeConfig('[models.a]\nnote = """\nbody\n"""\nmax_context_size = 9000\n');
      expect(config.models[0].maxContextSize).toBe(9000);
    });
  });

  it('reads a root-level dotted key as the alias\'s field', () => {
    const config = parseKimiCodeConfig('models."kimi-code/k3".display_name = "K3"\n');
    expect(config.models).toEqual([
      { alias: 'kimi-code/k3', displayName: 'K3', maxContextSize: null, supportEfforts: [], defaultEffort: null },
    ]);
  });

  it('reads a dotted key under [models] as the alias\'s field', () => {
    const config = parseKimiCodeConfig('[models]\n"kimi-code/k3".display_name = "K3"\n');
    expect(config.models.map((model) => [model.alias, model.displayName])).toEqual([['kimi-code/k3', 'K3']]);
  });

  it('skips an inline table without losing the keys around it', () => {
    const config = parseKimiCodeConfig('[models.a]\nlimits = { max_context_size = 5 }\ndisplay_name = "A"\n');
    expect(config.models[0].maxContextSize).toBeNull();
    expect(config.models[0].displayName).toBe('A');
  });
});

describe('kimiModelByAlias', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-config-'));
    savedHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reads the host config and sees a changed file at once', () => {
    const configPath = path.join(home, 'config.toml');
    expect(kimiModelByAlias('kimi-code/k3')).toBeUndefined();
    fs.writeFileSync(configPath, '[models."kimi-code/k3"]\ndisplay_name = "One"\n');
    expect(kimiModelByAlias('kimi-code/k3')?.displayName).toBe('One');
    fs.writeFileSync(configPath, '[models."kimi-code/k3"]\ndisplay_name = "Second name"\n');
    expect(kimiModelByAlias('kimi-code/k3')?.displayName).toBe('Second name');
  });
});
