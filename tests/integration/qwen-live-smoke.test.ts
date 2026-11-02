/**
 * Qwen Code adapter - LIVE-CLI smoke test against the real `qwen` binary.
 *
 * This test costs real API money and depends on a working ~/.qwen/.env
 * with valid Anthropic credentials, so it is opt-in and skipped by
 * default. The mock-driven integration harness in
 * `tests/unit/qwen-integration.test.ts` covers the same scenarios for
 * everyday CI; this file exists for empirical validation that the
 * adapter's caller-owned `--session-id` path is wired against a real
 * Qwen 0.15.3 install.
 *
 * Run:
 *   $env:KANGENTIC_LIVE_QWEN="1"; npx vitest run tests/unit/qwen-live-smoke.test.ts   # PowerShell
 *   set KANGENTIC_LIVE_QWEN=1 && npx vitest run tests/unit/qwen-live-smoke.test.ts    # cmd
 *   KANGENTIC_LIVE_QWEN=1 npx vitest run tests/unit/qwen-live-smoke.test.ts           # bash
 *
 * What it proves end-to-end:
 *   1. The real qwen binary is on PATH and reports a version (detector).
 *   2. Real qwen accepts `--session-id <our-uuid>` and writes its JSONL
 *      at exactly `~/.qwen/projects/<sanitized-cwd>/chats/<our-uuid>.jsonl`
 *      (caller-owned UUID, not CLI-generated).
 *   3. Our parser extracts `usage.model.id`, `usage.contextWindow.*`,
 *      and `usage.contextWindow.contextWindowSize` from the real
 *      assistant event.
 *   4. Spawning real qwen with `--resume <our-uuid>` re-attaches to
 *      the SAME JSONL file and appends new events to it (resume loop).
 *
 * Cost: ~$0.001-$0.005 per full run (two short Haiku calls).
 *
 * Cleanup: writes a single sandbox cwd under os.tmpdir() and a single
 * sandbox-scoped projects/ subdirectory under ~/.qwen/projects/. Both
 * are deleted in afterEach so reruns are deterministic and the user's
 * real chat history is never touched (sandbox basename is unique per
 * test via mkdtemp).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import which from 'which';
import {
  QwenAdapter,
  QwenDetector,
} from '../../src/main/agent/adapters/qwen-code';
import {
  QwenSessionHistoryParser,
  qwenChatsDir,
} from '../../src/main/agent/adapters/qwen-code/session-history-parser';

// Strict equality so foot-gun values like "0" or "false" don't accidentally
// trigger paid API calls. Use explicit "1" to opt in.
const SHOULD_RUN = process.env.KANGENTIC_LIVE_QWEN === '1';

/** Cheapest model that exists in our settings.json + works with Anthropic. */
const PROBE_MODEL = 'claude-haiku-4-5-20251001';
const PROBE_AUTH = 'anthropic';
/** Minimal prompt to keep token cost negligible. */
const PROBE_PROMPT = 'say ok';

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Run the real `qwen` CLI with the given args and resolve once it exits.
 * Uses --approval-mode yolo so it never pauses for confirmation. The
 * full child output is captured for assertion.
 */
function runQwenLive(qwenPath: string, args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(qwenPath, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      // .cmd shims need a shell on Windows.
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    // 60s hard ceiling for the whole call (model + network + qwen startup).
    const hardTimeout = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      reject(new Error(
        `qwen did not exit within 60s. stdout: ${stdout.slice(0, 500)} stderr: ${stderr.slice(0, 500)}`,
      ));
    }, 60_000);

    child.on('close', (code) => {
      clearTimeout(hardTimeout);
      resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - startedAt });
    });
    child.on('error', (error) => {
      clearTimeout(hardTimeout);
      reject(error);
    });
  });
}

describe.skipIf(!SHOULD_RUN)('Qwen Code - LIVE smoke (real CLI, costs real money)', () => {
  let qwenPath: string;
  let sandbox: string;
  let projectChatsRoot: string;
  let projectChatsParent: string;

  beforeAll(async () => {
    // Resolve the real qwen binary once. Failure here surfaces as a
    // clear error before any cost-bearing tests fire.
    try {
      qwenPath = await which('qwen');
    } catch {
      throw new Error('Real qwen CLI not on PATH. Install with: npm install -g @qwen-code/qwen-code');
    }
  });

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-live-smoke-'));
    // Real Qwen 0.15.3 will write to ~/.qwen/projects/<sanitized-sandbox>/chats/.
    // We compute that path via the parser's helper so test cleanup
    // matches byte-for-byte and never touches the user's real chats.
    projectChatsRoot = qwenChatsDir(sandbox);
    projectChatsParent = path.dirname(projectChatsRoot);
  });

  afterEach(() => {
    try { fs.rmSync(projectChatsParent, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('Layer 1: detector against the real qwen on PATH', () => {
    it('detects qwen and reports a non-empty version', async () => {
      const detector = new QwenDetector();
      const info = await detector.detect();
      expect(info.found).toBe(true);
      expect(info.path).toBeTruthy();
      // Version should be a semver-ish string like "0.15.3".
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('Layer 2: caller-owned --session-id <uuid> -> resume cycle', () => {
    it('real qwen honors --session-id <our-uuid>, writes JSONL at our path, then --resume reuses it', async () => {
      const adapter = new QwenAdapter();

      // Caller pre-generates the UUID, just like prepare-spawn.ts does
      // for adapters with supportsCallerSessionId === true.
      const ourSessionId = randomUUID();
      const chatFilePath = path.join(projectChatsRoot, `${ourSessionId}.jsonl`);

      // Step 1: spawn real qwen non-interactively WITH --session-id
      // <our-uuid>. We pass --auth-type and -m explicitly so the test
      // doesn't depend on the user's settings.json defaults.
      // --approval-mode yolo skips all confirmations. The bare positional
      // prompt is the documented non-deprecated form.
      const newRun = await runQwenLive(
        qwenPath,
        [
          '-m', PROBE_MODEL,
          '--auth-type', PROBE_AUTH,
          '--approval-mode', 'yolo',
          '--session-id', ourSessionId,
          PROBE_PROMPT,
        ],
        sandbox,
      );
      expect(newRun.exitCode, `qwen failed: ${newRun.stderr}`).toBe(0);
      expect(newRun.stdout.trim().length).toBeGreaterThan(0);

      // Step 2: the JSONL file MUST land at <our-uuid>.jsonl, not at a
      // CLI-generated UUID. This is the empirical proof that
      // --session-id is caller-owned.
      expect(fs.existsSync(projectChatsRoot)).toBe(true);
      expect(
        fs.existsSync(chatFilePath),
        `expected real qwen to honor --session-id and write ${chatFilePath}`,
      ).toBe(true);
      // Defensive: confirm no other JSONL files appeared (i.e. real qwen
      // didn't quietly fall back to generating its own UUID).
      const chatFiles = fs.readdirSync(projectChatsRoot)
        .filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(name));
      expect(chatFiles, `expected exactly one JSONL file (the caller-owned one)`).toEqual([`${ourSessionId}.jsonl`]);

      // Step 3: cross-check the file's first event sessionId matches
      // our UUID (Qwen's invariant: filename UUID == event.sessionId).
      const firstLine = fs.readFileSync(chatFilePath, 'utf-8').split('\n')[0];
      const firstEvent = JSON.parse(firstLine) as { sessionId: string; type: string };
      expect(firstEvent.sessionId).toBe(ourSessionId);

      // Step 4: locate() resolves the same path from the known UUID.
      const located = await adapter.locateSessionHistoryFile(ourSessionId, sandbox);
      expect(located).toBe(chatFilePath);

      // Step 5: parse the real JSONL and confirm we extract usage.
      const parsed = QwenSessionHistoryParser.parse(
        fs.readFileSync(located!, 'utf-8'),
        'full',
      );
      expect(parsed.usage, 'parser returned no usage from real session JSONL').not.toBeNull();
      expect(parsed.usage!.model.id).toBe(PROBE_MODEL);
      // Haiku 4.5's documented context window is 200k. Anthropic
      // records the same on each assistant event.
      expect(parsed.usage!.contextWindow.contextWindowSize).toBe(200_000);
      expect(parsed.usage!.contextWindow.totalInputTokens).toBeGreaterThan(0);
      expect(parsed.usage!.contextWindow.totalOutputTokens).toBeGreaterThan(0);

      // Step 6: spawn real qwen with --resume <our-uuid>. It must
      // re-open the SAME chat file and append more events to it.
      const initialSize = fs.statSync(chatFilePath).size;
      const resumeRun = await runQwenLive(
        qwenPath,
        [
          '-m', PROBE_MODEL,
          '--auth-type', PROBE_AUTH,
          '--approval-mode', 'yolo',
          '--resume', ourSessionId,
          'continue: say ok again',
        ],
        sandbox,
      );
      expect(resumeRun.exitCode, `qwen --resume failed: ${resumeRun.stderr}`).toBe(0);

      // Step 7: file must have grown (resume appended new events).
      const finalSize = fs.statSync(chatFilePath).size;
      expect(finalSize, 'resume did not append to the existing chat file').toBeGreaterThan(initialSize);

      // Step 8: parse the post-resume file - should now have multiple
      // assistant events. Walk-backwards must still pick up the most
      // recent one with non-zero token totals.
      const reparsed = QwenSessionHistoryParser.parse(
        fs.readFileSync(chatFilePath, 'utf-8'),
        'full',
      );
      expect(reparsed.usage).not.toBeNull();
      expect(reparsed.usage!.model.id).toBe(PROBE_MODEL);
      // Token totals from the second turn should be >= the first turn
      // since the second turn includes the prior context.
      expect(reparsed.usage!.contextWindow.totalInputTokens)
        .toBeGreaterThanOrEqual(parsed.usage!.contextWindow.totalInputTokens);
    }, 180_000);
  });
});
