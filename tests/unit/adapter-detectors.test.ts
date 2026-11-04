/**
 * Each adapter's own detector wires its own binary name and its own version
 * parser into the shared AgentDetector.
 *
 * The pipeline itself (in-flight dedup, the per-override cache, invalidation,
 * the override path, fallback paths, WSL) is the shared class's job and is
 * covered by agent-detector-*.test.ts. Repeating those scenarios once per
 * adapter proved nothing about the adapter, so this file asks only the two
 * things an adapter owns:
 *
 *   1. `binaryName`: `which` answers ONLY for the row's binary, and only that
 *      one path exists on disk, so a detector that looks up another name (or
 *      lands on a well-known fallback path) cannot report the CLI as found.
 *   2. `parseVersion`: the raw `--version` output a real CLI prints comes out as
 *      the bare version, or as not found when the parser rejects it.
 *
 * Raw outputs are the shapes the CLIs print, not the parsed value echoed back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDetector } from '../../src/main/agent/shared/agent-detector';

vi.mock('which', () => ({
  default: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn() } };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn(),
}));

import fs from 'node:fs';
import which from 'which';
import { execVersion } from '../../src/main/agent/shared/exec-version';
import { ClaudeDetector } from '../../src/main/agent/adapters/claude/detector';
import { CodexDetector } from '../../src/main/agent/adapters/codex/detector';
import { CopilotDetector } from '../../src/main/agent/adapters/copilot/detector';
import { GeminiDetector } from '../../src/main/agent/adapters/gemini/detector';
import { QwenDetector } from '../../src/main/agent/adapters/qwen-code/detector';
import { DroidDetector } from '../../src/main/agent/adapters/droid/detector';
import { OpenCodeDetector } from '../../src/main/agent/adapters/opencode/detector';
import { GooseDetector } from '../../src/main/agent/adapters/goose/detector';
import { GrokDetector } from '../../src/main/agent/adapters/grok/detector';
import { AntigravityDetector } from '../../src/main/agent/adapters/antigravity/detector';
import { WarpDetector } from '../../src/main/agent/adapters/warp/version-detector';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';
import { KimiAdapter } from '../../src/main/agent/adapters/kimi';
import { CursorAdapter } from '../../src/main/agent/adapters/cursor';

interface DetectorRow {
  adapter: string;
  /** A detector, or for the three adapters that build theirs inline, the adapter that exposes `detect()`. */
  create: () => Pick<AgentDetector, 'detect'>;
  binary: string;
  /** What `<binary> --version` prints. */
  raw: string;
  /** The version the detector reports, or null when the parser rejects `raw`. */
  version: string | null;
}

const rows: DetectorRow[] = [
  { adapter: 'claude', create: () => new ClaudeDetector(), binary: 'claude', raw: '2.1.90 (Claude Code)\n', version: '2.1.90' },
  { adapter: 'claude (no suffix)', create: () => new ClaudeDetector(), binary: 'claude', raw: '2.1.90\n', version: '2.1.90' },
  { adapter: 'codex', create: () => new CodexDetector(), binary: 'codex', raw: 'codex-cli 0.118.0\n', version: '0.118.0' },
  { adapter: 'gemini', create: () => new GeminiDetector(), binary: 'gemini', raw: '0.37.0\n', version: '0.37.0' },
  { adapter: 'qwen', create: () => new QwenDetector(), binary: 'qwen', raw: '0.0.14\n', version: '0.0.14' },
  {
    adapter: 'copilot',
    create: () => new CopilotDetector(),
    binary: 'copilot',
    raw: 'GitHub Copilot CLI 1.0.24.\nRun \'copilot update\' to check for updates.\n',
    version: '1.0.24',
  },
  { adapter: 'copilot (second line ignored)', create: () => new CopilotDetector(), binary: 'copilot', raw: 'GitHub Copilot CLI 2.1.0.\nRun \'copilot update\' to check.\n', version: '2.1.0' },
  { adapter: 'copilot (no trailing period)', create: () => new CopilotDetector(), binary: 'copilot', raw: 'GitHub Copilot CLI 1.0.0', version: '1.0.0' },
  { adapter: 'copilot (period then spaces)', create: () => new CopilotDetector(), binary: 'copilot', raw: 'GitHub Copilot CLI 1.5.2.  \n', version: '1.5.2' },
  { adapter: 'copilot (lowercase prefix)', create: () => new CopilotDetector(), binary: 'copilot', raw: 'github copilot cli 1.0.24.', version: '1.0.24' },
  // Only the prefix and period are left, so the parser has nothing to return.
  { adapter: 'copilot (no version after the prefix)', create: () => new CopilotDetector(), binary: 'copilot', raw: 'GitHub Copilot CLI .', version: null },
  { adapter: 'droid', create: () => new DroidDetector(), binary: 'droid', raw: 'droid 1.2.3\n', version: '1.2.3' },
  { adapter: 'opencode', create: () => new OpenCodeDetector(), binary: 'opencode', raw: '1.4.0\n', version: '1.4.0' },
  { adapter: 'opencode (product name prefixed)', create: () => new OpenCodeDetector(), binary: 'opencode', raw: 'opencode 1.4.0\n', version: '1.4.0' },
  { adapter: 'goose', create: () => new GooseDetector(), binary: 'goose', raw: 'goose 1.10.0\n', version: '1.10.0' },
  // pressly/goose, the database migration tool, publishes the same binary name.
  { adapter: 'goose (migration tool of the same name)', create: () => new GooseDetector(), binary: 'goose', raw: 'goose version: v3.24.1\n', version: null },
  { adapter: 'grok', create: () => new GrokDetector(), binary: 'grok', raw: 'grok 1.0.0 (3cd0d0cbce) [stable]\n', version: '1.0.0' },
  { adapter: 'grok (another vendor answering)', create: () => new GrokDetector(), binary: 'grok', raw: 'codex-cli 0.128.0\n', version: null },
  { adapter: 'antigravity', create: () => new AntigravityDetector(), binary: 'agy', raw: '1.1.13\n', version: '1.1.13' },
  { adapter: 'antigravity (a tool answering on the same name)', create: () => new AntigravityDetector(), binary: 'agy', raw: 'agy: command not recognised\n', version: null },
  { adapter: 'warp', create: () => new WarpDetector(), binary: 'oz', raw: 'Warp version: Some("v0.2026.04.08.08.36.stable_02")\n', version: 'v0.2026.04.08.08.36.stable_02' },
  { adapter: 'aider', create: () => new AiderAdapter(), binary: 'aider', raw: 'aider 0.86.1\n', version: '0.86.1' },
  { adapter: 'kimi', create: () => new KimiAdapter(), binary: 'kimi', raw: '2.4.1\n', version: '2.4.1' },
  // The unambiguous name is looked up first (the shared `agent` shim comes second).
  { adapter: 'cursor', create: () => new CursorAdapter(), binary: 'cursor-agent', raw: '2026.04.29-c83a488\n', version: '2026.04.29-c83a488' },
  { adapter: 'cursor (grok answering on the shared shim)', create: () => new CursorAdapter(), binary: 'cursor-agent', raw: 'grok 1.0.0 (3cd0d0cbce) [stable]\n', version: null },
];

describe('adapter detectors wire their own binary and version parser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(rows)('$adapter: reads "$raw" as $version', async ({ create, binary, raw, version }) => {
    const binaryPath = `/mock/bin/${binary}`;
    vi.mocked(which).mockImplementation((async (name: string) => (name === binary ? [binaryPath] : null)) as unknown as typeof which);
    vi.mocked(fs.existsSync).mockImplementation((candidate) => candidate === binaryPath);
    vi.mocked(execVersion).mockResolvedValue({ stdout: raw, stderr: '' });

    const result = await create().detect();

    expect(vi.mocked(which).mock.calls[0][0]).toBe(binary);
    expect(vi.mocked(execVersion).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(execVersion).mock.calls[0][0]).toBe(binaryPath);
    if (version === null) {
      expect(result).toMatchObject({ found: false, path: null, version: null });
    } else {
      expect(result).toMatchObject({ found: true, path: binaryPath, version });
    }
  });
});
