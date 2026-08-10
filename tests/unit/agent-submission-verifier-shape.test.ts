/**
 * Pins each agent adapter's `getSubmissionVerifier` VERDICT for both the
 * 'paste' and 'command-injection' contexts, AND its escalation tier.
 *
 * This test's value is that `null` is a DECLARED ANSWER, not an omission. A
 * verifier is what authorizes escalation, and escalation restarts the session
 * with the command as an argv prompt - which destroys live work. So an adapter
 * only earns a non-null command-injection verifier once its history has been
 * MEASURED to flush on submit rather than at turn-end
 * (`scripts/measure-injection-flush.mjs`; numbers in `docs/command-injection.md`).
 *
 * `escalates` is the SECOND gate, and it is deliberately stricter than the
 * first. A measurement says the CLI writes the record fast enough; it says
 * nothing about whether THIS adapter's resolver finds THAT record. Both
 * questions have to be answered live before a false negative is unlikely
 * enough to hand it a restart. See the tier table in docs/command-injection.md.
 *
 * Adding a verifier without a measurement fails this test, and so does flipping
 * `escalates` without the in-app proof. That is the point: it forces the
 * evidence to exist first.
 */
import { describe, it, expect } from 'vitest';

const ADAPTER_CLASSES = [
  {
    name: 'claude', importPath: '../../src/main/agent/adapters/claude/claude-adapter', className: 'ClaudeAdapter',
    commandInjection: 'verifier', escalates: true,
    reason: 'transcript JSONL records slash invocations and user turns on submit; the shipped reference implementation',
  },
  {
    name: 'codex', importPath: '../../src/main/agent/adapters/codex/codex-adapter', className: 'CodexAdapter',
    commandInjection: 'verifier', escalates: true,
    reason: 'measured 61-108ms flat against a 4.6s turn, AND proven in-app: confirmed a real record, escalated a forced miss',
  },
  {
    name: 'gemini', importPath: '../../src/main/agent/adapters/gemini/gemini-adapter', className: 'GeminiAdapter',
    commandInjection: 'null', escalates: false,
    reason: 'measured 5504ms / 6302ms and twice never within 25s: writes on message completion',
  },
  {
    name: 'qwen', importPath: '../../src/main/agent/adapters/qwen-code/qwen-adapter', className: 'QwenAdapter',
    commandInjection: 'verifier', escalates: false,
    reason: 'measured 443-696ms, but the resolver builds its path from a CAPTURED session id and has never run against a live Qwen session in-app',
  },
  {
    name: 'opencode', importPath: '../../src/main/agent/adapters/opencode/opencode-adapter', className: 'OpenCodeAdapter',
    commandInjection: 'verifier', escalates: false,
    reason: 'measured 64-95ms, but a REMOTE session has no local row and would report failed on every delivery',
  },
  {
    name: 'copilot', importPath: '../../src/main/agent/adapters/copilot/copilot-adapter', className: 'CopilotAdapter',
    commandInjection: 'verifier', escalates: false,
    reason: 'measured 36-38ms, but the harness matched a nonce SUBSTRING and no real capture pins the exact-match extractor',
  },
  {
    name: 'aider', importPath: '../../src/main/agent/adapters/aider/aider-adapter', className: 'AiderAdapter',
    commandInjection: 'verifier', escalates: false,
    reason: 'markdown format known from a real fixture; not installed here, so unmeasured',
  },
  {
    name: 'cursor', importPath: '../../src/main/agent/adapters/cursor/cursor-adapter', className: 'CursorAdapter',
    commandInjection: 'null', escalates: false,
    reason: 'measured turn-end flushed: 5766ms/5446ms appends landing within ~40ms of the turn ending',
  },
  {
    name: 'droid', importPath: '../../src/main/agent/adapters/droid/droid-adapter', className: 'DroidAdapter',
    commandInjection: 'null', escalates: false,
    reason: 'measured unreliable: 564ms best against a 3202ms worst, unrelated to turn length',
  },
  {
    name: 'kimi', importPath: '../../src/main/agent/adapters/kimi/kimi-adapter', className: 'KimiAdapter',
    commandInjection: 'verifier', escalates: false,
    reason: 'wire.jsonl shape pinned against real captures; never reached a usable TUI, so unmeasured',
  },
  {
    name: 'warp', importPath: '../../src/main/agent/adapters/warp/warp-adapter', className: 'WarpAdapter',
    commandInjection: 'null', escalates: false,
    reason: 'no history file accessible via CLI',
  },
  {
    name: 'ollama', importPath: '../../src/main/agent/adapters/ollama/ollama-adapter', className: 'OllamaAdapter',
    commandInjection: 'null', escalates: false,
    reason: '`ollama run` keeps no session history',
  },
] as const;

function reasonFor(name: string): string {
  return ADAPTER_CLASSES.find((entry) => entry.name === name)?.reason ?? '';
}

describe('Adapter getSubmissionVerifier implementation', () => {
  it.each(ADAPTER_CLASSES)(
    '$name adapter implements getSubmissionVerifier method',
    async ({ importPath, className }) => {
      const module = await import(importPath);
      const AdapterClass = module[className] as new () => { getSubmissionVerifier: (contextType: string) => unknown };
      const adapter = new AdapterClass();

      expect(typeof adapter.getSubmissionVerifier).toBe('function');
    },
  );

  it.each(ADAPTER_CLASSES)(
    '$name adapter matches its recorded command-injection verdict',
    async ({ importPath, className, name, commandInjection, reason }) => {
      const module = await import(importPath);
      const AdapterClass = module[className] as new () => { getSubmissionVerifier: (contextType: string) => unknown };
      const adapter = new AdapterClass();

      const pasteVerifier = adapter.getSubmissionVerifier('paste');
      const commandVerifier = adapter.getSubmissionVerifier('command-injection');

      if (commandInjection === 'verifier') {
        // A regression to null silently degrades this adapter to time-based
        // settle, losing retry-on-Enter recovery and escalation.
        expect(typeof commandVerifier).toBe(
          'function',
          `${name} should return a command-injection verifier (${reason})`,
        );
      } else {
        // A regression to non-null means a verifier was added WITHOUT a
        // measurement, which is how a false `failed` reaches escalation and
        // restarts a session that was working. Record the measurement in
        // docs/command-injection.md and update this table together.
        expect(commandVerifier).toBeNull();
      }

      // Never `undefined` or any other type, in either context.
      expect([null, 'function']).toContain(
        pasteVerifier === null ? null : typeof pasteVerifier,
        `${name} paste verifier should be null or function`
      );
      expect([null, 'function']).toContain(
        commandVerifier === null ? null : typeof commandVerifier,
        `${name} command-injection verifier should be null or function`
      );
    },
  );

  it.each(ADAPTER_CLASSES)(
    '$name adapter matches its recorded escalation tier',
    async ({ importPath, className, name, escalates: shouldEscalate }) => {
      const module = await import(importPath);
      const AdapterClass = module[className] as new () => {
        getSubmissionVerifier: (contextType: string) => unknown;
        canEscalateOnVerificationFailure?: () => boolean;
      };
      const adapter = new AdapterClass();

      // EFFECTIVE escalation, not just the flag. An adapter with no verifier
      // never escalates whatever the flag says, because `submitKeystrokes` only
      // pushes to `unconfirmedCommands` when `canVerify` is true, and
      // `TerminalSubmitScheduler.escalate` reads that list. So the no-verifier
      // adapters below record `escalates: false` and are not asked to declare a
      // redundant override.
      const hasVerifier = adapter.getSubmissionVerifier('command-injection') !== null;
      const escalates = hasVerifier && adapter.canEscalateOnVerificationFailure?.() !== false;

      // THE SAFETY INVARIANT, in both directions.
      //
      // Losing an escalation costs a recovery that only fires after five failed
      // retries. Gaining a wrong one restarts a session and destroys live work,
      // and it does so on EVERY delivery, because the resolver bugs that cause
      // it (a path that never resolves, a session id never captured, a stored
      // text that never trim-equals) are permanent rather than intermittent.
      //
      // So a `true` here is a claim that this adapter's own verifier has been
      // watched confirming a real submission in a running app, not merely that
      // its CLI was measured. If this test failed because you flipped a flag,
      // run the mock-CLI recipe in docs/command-injection.md first and record
      // the result there in the same change.
      expect(escalates).toBe(
        shouldEscalate,
        `${name} escalation tier changed: ${reasonFor(name)}`,
      );
    },
  );

  it('every adapter declaring it cannot verify slash submissions says so explicitly', async () => {
    // `canVerifySlashSubmission` returning false makes prepareInjectionPlan tag
    // a slash auto_command `verify: 'none'`. That is only meaningful for an
    // adapter that HAS a verifier - otherwise the command is unverifiable
    // anyway - so the flag must never be the reason a verifier looks absent.
    for (const entry of ADAPTER_CLASSES) {
      const module = await import(entry.importPath);
      const AdapterClass = module[entry.className] as new () => {
        canVerifySlashSubmission?: () => boolean;
      };
      const adapter = new AdapterClass();
      if (adapter.canVerifySlashSubmission === undefined) continue;
      expect(typeof adapter.canVerifySlashSubmission()).toBe('boolean');
    }
  });

  it('every registered adapter implements getSubmissionVerifier', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    for (const adapterName of agentRegistry.list()) {
      const adapter = agentRegistry.get(adapterName);
      expect(typeof adapter?.getSubmissionVerifier).toBe(
        'function',
        `${adapterName} adapter missing getSubmissionVerifier method`
      );
    }
  });
});
