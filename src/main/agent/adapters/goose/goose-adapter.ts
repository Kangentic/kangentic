import { GooseDetector } from './detector';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Goose CLI adapter - integrates Block's Goose agent CLI (`goose`)
 * (https://github.com/block/goose) behind the generic AgentAdapter interface.
 *
 * Goose is a thin FIRST-PASS integration, close to Warp/Oz: no hooks wired, no
 * structured status/event output, no trust mechanism, and no settings merging.
 *
 * "Not wired" rather than "not available", and the distinction matters because
 * it is what justifies the PTY-only activity detection below. Goose DOES ship a
 * hook system (verified against Goose's published CLI docs, 2026-09-16:
 * https://goose-docs.ai/docs/guides/context-engineering/hooks/ - not against a
 * live binary, so treat the event list as the documented contract rather than a
 * measured one): plugin-scoped `hooks/hooks.json` discovered from
 * `<project>/.agents/plugins/<name>/` or `~/.agents/plugins/<name>/`, firing
 * SessionStart, SessionEnd, Stop, UserPromptSubmit, PreToolUse, PreToolUseResult,
 * PostToolUse, PostToolUseFailure, BeforeReadFile, AfterFileEdit,
 * BeforeShellExecution and AfterShellExecution, each handed a JSON payload on
 * stdin carrying `event` and `session_id`. That is the same `.agents/` workspace
 * shape the Antigravity adapter already writes and a payload close to the one
 * `event-bridge.js` consumes, so wiring it is a follow-up, not a blocked path.
 * Until then activity rides the PTY silence timer, with the false-idle exposure
 * that implies.
 *
 * It differs from Warp in two ways this adapter uses:
 *
 * - Session resume. Goose accepts a caller-supplied session name (`--name`),
 *   so we hand it the engine-generated id (`supportsCallerSessionId = true`)
 *   and resume with `-r -n <id>`. No transcript parsing is needed to capture
 *   an id after the fact.
 * - Autonomy. Goose sets its approval mode through the `GOOSE_MODE` env var,
 *   not a spawn flag, so the permission dropdown maps to it via `buildEnv`.
 *
 * Model/provider selection is left to Goose's own `--model`/`--provider` flags
 * and `~/.config/goose/config.yaml`; per cli-features-over-custom-layers this
 * adapter keeps no model list and does not shadow the CLI's model control.
 */

/**
 * Kangentic permission mode -> Goose `GOOSE_MODE` value. A `Record` over the
 * full `PermissionMode` union makes a newly added mode a compile error here
 * rather than a silent wrong-mode spawn.
 *
 * Goose's four modes, per its published permission-modes docs (2026-09-16),
 * not a live probe:
 * - `chat`: no tools at all. Not "read-only" - the agent cannot read files
 *   either, so a plan-mode Goose session reasons without repo access.
 * - `smart_approve`: file modifications need approval, reads do not.
 * - `approve`: every action needs approval. Stricter than `smart_approve`,
 *   so nothing maps to it: it sits BELOW `default` on the permissiveness
 *   ladder the dropdown is ordered by.
 * - `auto`: modify/create/delete and run shell commands without approval.
 *
 * `acceptEdits` is the case with no faithful target. Everywhere else in
 * Kangentic it means "auto-approve edits, still gate shell commands", and
 * Goose has no such mode: the only way to stop prompting on edits is `auto`,
 * which also stops prompting on shell. Mapping it to `auto` made the SHIPPED
 * DEFAULT (`DEFAULT_APP_CONFIG.agent.permissionMode` is `acceptEdits`,
 * `src/shared/types.ts`) a fully unattended agent that the user never chose,
 * because `resolveEffectivePermissionMode` falls through to the global
 * setting and never consults `permissions` below. So it resolves DOWN to
 * `smart_approve`: prompting on a write is recoverable, an unrequested `rm`
 * is not. `bypassPermissions` remains the explicit opt-in to full autonomy.
 */
const GOOSE_MODE_BY_PERMISSION: Record<PermissionMode, string> = {
  plan: 'chat',
  dontAsk: 'chat',
  default: 'smart_approve',
  acceptEdits: 'smart_approve',
  auto: 'auto',
  bypassPermissions: 'auto',
};

export class GooseAdapter implements AgentAdapter {
  readonly name = 'goose';
  readonly displayName = 'Goose CLI';
  readonly sessionType = 'goose_agent';
  // Goose accepts a caller-supplied session name (`--name`), which we resume
  // with `-r -n <id>`. The engine stores the id it generates and passes it back
  // on resume (transition-engine.ts).
  readonly supportsCallerSessionId = true;
  // Goose maps each entry to a `GOOSE_MODE` value in buildEnv (not a CLI flag),
  // via GOOSE_MODE_BY_PERMISSION above. Three entries, one per distinct Goose
  // mode Kangentic can reach: `chat`, `smart_approve`, `auto`. `acceptEdits` is
  // deliberately NOT offered - Goose has no mode that auto-approves edits while
  // still gating shell commands, so an "Auto Edit" entry could only be a second
  // spelling of one of these three, promising a narrower autonomy than it grants.
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Chat Only, No File Access)' },
    { mode: 'default', label: 'Default (Smart Approve)' },
    { mode: 'bypassPermissions', label: 'Auto (Skip All Approvals)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  private readonly detector = new GooseDetector();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Goose has no trust mechanism - no-op.
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;

    // Goose runs in the process cwd; there is no start-in-dir flag, so the
    // PTY's cwd (set by the spawn chokepoint) is authoritative and no -C-style
    // flag is passed. A prompt uses `goose run -t <prompt> -s`: process the
    // prompt, then stay interactive so the user can continue the session. A
    // promptless spawn (an ordinary resume, or a plain terminal) opens a bare
    // interactive `goose session`.
    const parts: string[] = [quoteArg(options.agentPath, shell)];
    parts.push(options.prompt ? 'run' : 'session');

    // Resume a prior session by its caller-supplied name. The id is the same
    // value passed as --name on the fresh spawn.
    if (options.resume && options.sessionId) {
      parts.push('-r');
    }
    if (options.sessionId) {
      parts.push('-n', quoteArg(options.sessionId, shell));
    }

    if (options.prompt) {
      // Non-unix shells (PowerShell, cmd) quote with double quotes, so an
      // embedded double quote in the prompt would close the argument early.
      // Swap them for single quotes, matching the Warp adapter.
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push('-t', quoteArg(safePrompt, shell, { multiline: true }));
      // -s / --interactive: drop into an interactive session after the prompt.
      // Omitted for a nonInteractive spawn_agent action, where `goose run -t`
      // alone is already the headless one-shot form: run the prompt and exit.
      // Leaving -s on would park a fire-and-forget automation in an
      // interactive session that never exits, which is what every sibling
      // adapter avoids by branching here (claude, codex, gemini, qwen, grok,
      // antigravity, copilot, kimi).
      if (!options.nonInteractive) {
        parts.push('-s');
      }
    }

    return parts.join(' ');
  }

  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    // Goose reads its approval mode from GOOSE_MODE (env or config), not a CLI
    // flag, so the permission dropdown is delivered here.
    //
    // The `?? ` is not dead code. `permission_mode` is an unconstrained TEXT
    // column read back through a bare cast, so the union is a compile-time
    // claim, not a runtime guarantee. Without the fallback an unrecognized
    // value yields `{ GOOSE_MODE: undefined }`, which reaches the PTY env as
    // the literal string "undefined" and makes Goose fall back to its OWN
    // default. Its docs give that default as AUTONOMOUS, so the failure mode
    // is not "ignores the column's permission setting", it is "silently runs
    // unattended". Degrade to this adapter's declared default instead.
    const gooseMode = GOOSE_MODE_BY_PERMISSION[options.permissionMode]
      ?? GOOSE_MODE_BY_PERMISSION[this.defaultPermission];
    return { GOOSE_MODE: gooseMode };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: this adapter wires no hooks and reads no structured
   * status output (see the class docstring - Goose HAS hooks, they are just
   * not wired yet), so
   * activity is PTY-only with the silence timer, like Warp. The session id is
   * caller-supplied (see supportsCallerSessionId), so no capture strategy is
   * needed.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.pty(),
  };

  // This adapter installs no hook plugin, so there is nothing to remove.
  removeHooks(_directory: string): void {}

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // No hooks wired and no history parsed, so no verification signal. Callers fall back
    // to time-based settle (paste) or time-settle (command-injection).
    return null;
  }

  // Goose has no merged settings - no-op.
  clearSettingsCache(): void {}

  getExitSequence(): string[] {
    // Goose's Ctrl+C is CONTEXTUAL (per its published CLI docs, 2026-09-16:
    // "clear the current line if text is entered, interrupt the current request
    // if processing, or exit the session if line is empty"): it clears the line
    // if text is entered, interrupts the request if one is processing, and
    // exits only when the line is already empty. A kill lands mid-turn far more often than at an
    // idle prompt (moving a card to Done while the agent works), where Ctrl+C
    // alone interrupts and leaves the session running until the teardown grace
    // expires and it is force-killed. So interrupt first, then exit explicitly,
    // the same shape Ollama uses for its REPL. Harmless once the process is
    // already gone: `writeExitSequence` swallows the write on a dead PTY.
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Goose streams output immediately; any non-empty data means it is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(_agentSessionId: string, _cwd: string): Promise<string | null> {
    // No transcript parsing in this adapter: resume rides on the caller-supplied
    // --name, and the resume-conversation guard degrades safely to "cannot prove
    // empty" when this returns null.
    return null;
  }
}
