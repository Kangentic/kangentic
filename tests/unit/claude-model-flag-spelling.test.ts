/**
 * The Claude adapter converts a model written the way the app displays it
 * ("Opus", "Opus 5.5") into Claude's own spelling (`opus`, `claude-opus-5-5`)
 * where it hands the model to the CLI: the `--model` flag and the live
 * `/model` command. Stored values are never rewritten (the board config,
 * profile, and command handlers keep what was written, so another agent's
 * "Gemini 2.5" is not mangled), which makes this the only conversion point.
 *
 * A single word converts only when Claude's own picker reported it as an
 * alias, so a gateway model named "Workhorse" is never lowercased into an id
 * that does not exist. The known aliases come from the last-scan file, read
 * without starting a probe.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { CommandBuilder } from '../../src/main/agent/adapters/claude/command-builder';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import {
  parseModelFromClaudeCommand,
  toClaudeModelArgument,
} from '../../src/main/agent/adapters/claude/model-display-name';
import {
  resetModelPickerProbeForTests,
  setModelPickerProbeScanFileForTests,
} from '../../src/main/agent/adapters/claude/model-picker-probe';
import type { CommandOptions } from '../../src/main/agent/agent-adapter';

const CLI_PATH = 'claude';

function modelFlagFor(model: string, cliPath = CLI_PATH): string | null {
  const command = new CommandBuilder().buildClaudeCommand({
    cliPath,
    taskId: 'task-1',
    cwd: '/mock/project',
    permissionMode: 'default',
    model,
    shell: 'bash',
  } as CommandOptions);
  return parseModelFromClaudeCommand(command);
}

function liveModelCommandFor(model: string): string[] {
  return new ClaudeAdapter().getInjectionSequence({
    model,
    modelChanged: true,
    effort: null,
    effortChanged: false,
  });
}

let temporaryDirectory: string;

beforeEach(() => {
  resetModelPickerProbeForTests();
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-model-flag-'));
});

afterEach(() => {
  resetModelPickerProbeForTests();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function seedLastScan(aliasIds: string[], cliPath = CLI_PATH): void {
  const scanFile = path.join(temporaryDirectory, 'model-picker-last-scan.json');
  fs.writeFileSync(scanFile, JSON.stringify({
    cliPath,
    fetchedAtMs: Date.now() - 1000,
    scan: {
      models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      aliases: aliasIds.map((id) => ({ id, resolvesTo: `claude-${id}-5-5` })),
    },
  }), 'utf8');
  setModelPickerProbeScanFileForTests(scanFile);
}

describe('toClaudeModelArgument', () => {
  const known = new Set(['opus', 'sonnet']);

  it.each([
    ['Opus', 'opus'],
    ['Sonnet (1M)', 'sonnet[1m]'],
    ['Opus 5.5', 'claude-opus-5-5'],
    ['opus', 'opus'],
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['  sonnet  ', 'sonnet'],
    ['Workhorse', 'Workhorse'],
  ])('passes %s as %s when opus and sonnet are known aliases', (stored, passed) => {
    expect(toClaudeModelArgument(stored, known)).toBe(passed);
  });

  it('passes a single word through unchanged when no alias is known', () => {
    expect(toClaudeModelArgument('Opus', new Set())).toBe('Opus');
  });
});

describe('Claude --model spelling', () => {
  it('converts a known alias written as a family name', () => {
    seedLastScan(['opus', 'sonnet']);
    expect(modelFlagFor('Opus')).toBe('opus');
    expect(modelFlagFor('Sonnet (1M)')).toBe('sonnet[1m]');
    expect(modelFlagFor('Opus 5.5')).toBe('claude-opus-5-5');
  });

  it('keeps a single word no scan reported exactly as written', () => {
    seedLastScan(['opus', 'sonnet']);
    expect(modelFlagFor('Workhorse')).toBe('Workhorse');
  });

  it('passes a single word through on a cold start with no scan, but still converts a versioned name', () => {
    expect(modelFlagFor('Opus')).toBe('Opus');
    expect(modelFlagFor('Opus 5.5')).toBe('claude-opus-5-5');
  });
});

describe('Claude --model spelling behind a Windows npm shim', () => {
  // Discovery probes the detected `.cmd`, but a spawn runs its sibling
  // (resolveShimLaunch), so the scan must still apply to the sibling path.
  const DETECTED_SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd';

  it('converts a known alias when the spawn runs the .ps1 sibling', () => {
    seedLastScan(['opus'], DETECTED_SHIM);
    expect(modelFlagFor('Opus', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1')).toBe('opus');
  });

  it('converts a known alias when the spawn runs the extensionless sibling', () => {
    seedLastScan(['opus'], DETECTED_SHIM);
    expect(modelFlagFor('Opus', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude')).toBe('opus');
  });

  it('does not apply a scan taken with a different CLI', () => {
    seedLastScan(['opus'], DETECTED_SHIM);
    expect(modelFlagFor('Opus', 'C:\\Users\\dev\\other\\claude.ps1')).toBe('Opus');
  });
});

describe('Claude live /model spelling', () => {
  it('sends a known alias in Claude\'s spelling', () => {
    seedLastScan(['opus']);
    // Building a --model command first seeds the cache from the file with a CLI path.
    modelFlagFor('opus');
    expect(liveModelCommandFor('Opus')).toEqual(['/model opus']);
  });

  it('seeds itself from the last-scan file, with no --model build before it', () => {
    // The live command has no CLI path at hand, so the peek that serves it seeds
    // from the file for any CLI. Before that, only a --model build (which has a
    // path) primed the cache, and this returned '/model Opus'.
    seedLastScan(['opus']);
    expect(liveModelCommandFor('Opus')).toEqual(['/model opus']);
  });

  it('sends an unknown single word as written', () => {
    expect(liveModelCommandFor('Workhorse')).toEqual(['/model Workhorse']);
  });

  it('sends a family name as written when no scan is cached yet', () => {
    expect(liveModelCommandFor('Opus')).toEqual(['/model Opus']);
    expect(liveModelCommandFor('Opus 5.5')).toEqual(['/model claude-opus-5-5']);
  });
});
