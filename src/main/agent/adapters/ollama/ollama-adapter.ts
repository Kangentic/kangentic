import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { discoverOllama } from './capability-discovery';
import { runCliPrintAnswer } from '../../shared/cli-answer';
import { resolveCliTarget } from '../../shared/cli-target';
import { shimFamilyKey } from '../../shared/shim-family-key';
import type {
  AgentAdapter,
  AgentInfo,
  AnswerFromContextOptions,
  SettingsChangeSpec,
  SpawnCommandOptions,
} from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  AgentCapabilities,
  AgentLiveTelemetryUnsupported,
  SubmissionContextType,
  SubmissionVerifier,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Default model used when no per-column / per-task model override is set.
 *
 * `ollama run` REQUIRES a model argument (it has no built-in default and no
 * interactive picker), so the adapter must always supply one. Users normally
 * pick a specific installed model via the model dropdown, which is populated
 * from `ollama list` (see capability-discovery.ts). Ollama auto-pulls a
 * missing model on first run, so this fallback is always runnable.
 */
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';

/**
 * The `--think` flag carrying a thinking level, always in `=` form.
 *
 * Ollama registers `--think` as a string flag with `NoOptDefVal = "true"`
 * (https://github.com/ollama/ollama/blob/v0.40.14/cmd/cmd.go). pflag gives
 * such a flag a value only when it is attached with `=`: `--think high` parses
 * as `--think` (true) followed by a stray positional `high`, which would land
 * in the prompt. Levels come from `ollama run --help` (capability-discovery.ts).
 */
export function thinkFlag(level: string): string {
  return `--think=${level}`;
}

/**
 * One shell word as buildCommand's `quoteArg` writes the executable: double
 * quoted, single quoted (a fish `\'` escape included), a backslash escape, or
 * a bare character, repeated. So a POSIX `'/o'\''brien dir/ollama'` is one word.
 */
const EXECUTABLE_WORD = String.raw`(?:"[^"]*"|'(?:[^'\\]|\\.)*'|\\.|[^\s"'\\])+`;

/** The model after `run`: double quoted, single quoted or bare, one capture group each. */
const MODEL_TOKEN = String.raw`(?:"([^"]+)"|'([^']+)'|(\S+))`;

/** `<executable> run <model>` at the start of a command buildCommand wrote. */
const RUN_MODEL_PATTERN = new RegExp(String.raw`^\s*${EXECUTABLE_WORD}\s+run\s+${MODEL_TOKEN}`);

/**
 * Ollama CLI adapter - drives a local LLM via the `ollama` CLI
 * (https://ollama.com) behind the generic AgentAdapter interface.
 *
 * Ollama is a local-inference tool, not an agentic coder: `ollama run` opens
 * a chat with a local model and cannot edit files or call tools on its own.
 * It is modeled on the Warp adapter (a one-shot run that streams output then
 * exits), NOT on the agentic CLIs: `ollama run <model> "<prompt>"` prints the
 * answer and the process exits, so each spawn is a single turn. Free-form
 * multi-turn chat is available by running `ollama run <model>` directly in a
 * Command Terminal.
 *
 * No session resume (Ollama has no CLI-level session IDs), no hooks, no trust
 * mechanism, no MCP wiring. The one Kangentic-managed knob is the model
 * argument, which is mandatory for `ollama run` and therefore a documented
 * exception to cli-features-over-custom-layers.md. Effort maps to Ollama's own
 * `--think=<level>` flag, passed only when a level is chosen.
 *
 * Built from Ollama's docs and source at v0.40.14, not run against a real
 * CLI: the `--think` effort, the answer run's `--hidethinking`, the model pill
 * seed and the `/load` + `/set think` live swap
 * (docs/integrations/agents/ollama.md, "Built from documentation").
 */
export class OllamaAdapter implements AgentAdapter {
  readonly name = 'ollama';
  readonly displayName = 'Ollama';
  readonly sessionType = 'ollama_agent';
  readonly supportsCallerSessionId = false;
  /** Ollama keeps no session id Kangentic can resume, so every start is fresh. */
  readonly resumePromptDelivery = 'no-resume' as const;
  // Ollama has no autonomy / permission concept - it is a plain chat REPL.
  // Per cli-features-over-custom-layers.md, expose a single informational
  // entry and inject no permission flags in buildCommand().
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'default', label: 'Chat' },
  ];
  readonly defaultPermission: PermissionMode = 'default';
  // An Ollama installed in a WSL distro runs there, against the distro's own
  // daemon: the session, the answer run and `ollama list` all start inside it.
  // Ollama wires no hooks, MCP server or transcript reader.
  readonly supportsWslCli = true;
  // On a remote host over SSH (#913) the CLI is `ollama` from the host's login PATH, talking to the
  // daemon on that host (`ollama serve` must already be running there; Kangentic does not start it).
  // Ollama edits no file, so nothing is declared in `remoteFiles`. `discoverCapabilities` takes no place,
  // so the model picker lists what `ollama list` says on this computer, not the host's models; a model
  // for a remote project is typed in the picker's free-form field.
  readonly remoteCliName = 'ollama';

  // Shared AgentDetector via composition (like Aider). `ollama --version`
  // prints `ollama version is X.Y.Z`.
  private readonly detector = new AgentDetector({
    binaryName: 'ollama',
    fallbackPaths: standardUnixFallbackPaths('ollama'),
    parseVersion: (raw) => raw.replace(/^ollama version is\s+/i, '').trim() || null,
    // A `\\wsl.localhost\<distro>\...` path is probed inside the distro.
    supportsWslCli: true,
  });

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  /**
   * The `--think` levels each CLI path last reported, keyed by `shimFamilyKey`
   * of the path its discovery ran with, so the `.ps1` or extensionless sibling
   * a Windows spawn launches finds them. buildCommand uses it to drop a level
   * that CLI does not take (see `acceptedThinkLevel`), and the answer run to
   * leave out `--hidethinking` for a CLI with no thinking flags. Only a
   * `run --help` that answered writes it: a failed read says nothing about the
   * CLI, so the levels an earlier read reported stay.
   */
  private readonly reportedThinkLevels = new Map<string, readonly string[]>();

  /**
   * Discover installed models via `ollama list` so the renderer can populate
   * the model picker, and the `--think` levels from `ollama run --help`.
   * Never throws (returns model-override support with no list on failure,
   * which the renderer renders as a free-form text input). When the help read
   * fails, the levels an earlier read reported are offered instead.
   */
  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    const { capabilities, thinkLevels } = await discoverOllama(cliPath);
    const key = shimFamilyKey(cliPath);
    if (thinkLevels) {
      this.reportedThinkLevels.set(key, thinkLevels);
      return capabilities;
    }
    return { ...capabilities, effortLevels: [...(this.reportedThinkLevels.get(key) ?? [])] };
  }

  /**
   * The effort to pass as `--think`, or null to pass none.
   *
   * The spawn path hands over a column's or task's effort without checking it
   * against what this CLI reported, so a level set for another agent (Claude's
   * `xhigh`) would reach Ollama and fail the run. Once discovery has run for
   * this CLI path, a level it did not report is dropped and the run starts at
   * Ollama's default; a CLI that reported none (before 0.9.0) gets none.
   * Before discovery, the level passes through and the CLI is the judge.
   */
  private acceptedThinkLevel(cliPath: string, effort: string | null | undefined): string | null {
    const level = effort?.trim();
    if (!level) return null;
    const reported = this.reportedThinkLevels.get(shimFamilyKey(cliPath));
    if (reported && !reported.includes(level)) return null;
    return level;
  }

  // Ollama has no trust mechanism - no-op
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;

    // `ollama run` requires a model. Use the per-column / per-task override
    // when set, else fall back to a common default (Ollama auto-pulls it if
    // it is not already installed).
    const model = options.model?.trim() || DEFAULT_OLLAMA_MODEL;
    const parts: string[] = [quoteArg(options.cliTarget ? options.cliTarget.linuxCliPath : options.agentPath, shell), 'run', quoteArg(model, shell)];

    // Effort is Ollama's thinking level. It goes after the model, so the model
    // stays the token right after `run` (configuredModelFromCommand reads it
    // there), and before the `--` guard, past which nothing is a flag. A level
    // the CLI did not report is dropped (acceptedThinkLevel). A reported level
    // on a model that cannot think still fails the run ("does not support
    // thinking"), shown in the terminal: levels are per CLI, support is per model.
    const effort = this.acceptedThinkLevel(options.agentPath, options.effort);
    if (effort) parts.push(quoteArg(thinkFlag(effort), shell));

    // Initial prompt delivered as a single positional argument (one-shot
    // run). When absent (a no-prompt spawn), `ollama run <model>` drops into
    // an interactive REPL the user types into.
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      // `ollama run` is a cobra/pflag CLI with flag parsing on, so a prompt
      // beginning with a dash (a markdown bullet, a dashed list item) would be
      // misread as a flag. Push the `--` end-of-options marker first so the
      // prompt is always taken as the positional argument (matches the Warp
      // adapter). quoteArg quotes the marker for PowerShell hosts, whose
      // binder would otherwise consume it before a .ps1 shim sees $args.
      parts.push(quoteArg('--', shell), quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Seed the board card's model pill from the command, which always names a
   * model: `ollama run MODEL [PROMPT]` (cmd.go `Use`, v0.40.14) takes it as
   * the first positional, and buildCommand always supplies one. Ollama has no
   * telemetry channel, so this is the pill's only source. The id is shown as
   * is: Ollama's own names (`qwen3:8b`) are already what the user picked, and
   * no name table is kept (cli-features-over-custom-layers.md).
   *
   * Reads only the token right after `run`, after skipping the executable
   * as one shell word (RUN_MODEL_PATTERN), so a prompt that mentions
   * `run something` never seeds it.
   */
  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    const match = command.match(RUN_MODEL_PATTERN);
    const id = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!id || id.startsWith('-')) return null;
    return { id, displayName: id };
  }

  /**
   * Ollama reports no model, tokens, context or cost to Kangentic: `ollama run`
   * writes no status file, session file or structured stream, and its only
   * usage output is the per-response timing block `--verbose` prints in the
   * terminal (cmd.go v0.40.14). Without this the context bar would wait for
   * telemetry forever. The model pill is seeded by configuredModelFromCommand.
   */
  readonly liveTelemetryUnsupported: AgentLiveTelemetryUnsupported = {
    unavailableLabel: 'Telemetry: none',
    unavailableTitle: 'Ollama does not report live telemetry to Kangentic.',
  };

  /**
   * Live model and effort swap for a Command Terminal running the Ollama
   * chat (`ollama run MODEL` with no prompt). Uses the REPL's own commands
   * (https://github.com/ollama/ollama/blob/v0.40.14/cmd/interactive.go):
   * `/load <model>` switches the model in place, and `/set think <level>`
   * sets the thinking level. `/load` runs first so the level lands on the
   * new model. Unlike Claude's `/model`, `/load` CLEARS the chat's history:
   * Ollama starts the new model with no messages. A null effort means the
   * column leaves effort alone, so nothing is typed for it.
   */
  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    if (spec.modelChanged && spec.model) sequence.push(`/load ${spec.model}`);
    if (spec.effortChanged && spec.effort) sequence.push(`/set think ${spec.effort}`);
    return sequence;
  }

  /**
   * Runtime strategy: Ollama has no hooks and no native session IDs.
   *
   * - Activity: PTY-only. A one-shot `ollama run` streams output then exits,
   *   so the PTY silence timer drives the idle transition. The detectIdle
   *   callback additionally catches the interactive REPL prompt (`>>> `) for
   *   an instant idle when a no-prompt spawn drops into the REPL.
   * - Session ID / history: omitted - Ollama has no CLI-level resume and no
   *   session history files for `ollama run`.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Only its prompt pattern says a turn ended.
    reportsTurnEnd: false,
    activity: ActivityDetection.pty((data: string) => {
      const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      return /(?:^|\n)>>>\s*$/.test(clean);
    }),
  };

  // Ollama does not use hooks - no-op
  removeHooks(_directory: string): void {}

  getExitSequence(): string[] {
    // Ctrl+C interrupts generation; /bye cleanly exits an interactive REPL.
    // Harmless when the one-shot process has already exited.
    return ['\x03', '/bye\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Ollama writes immediately (no alternate screen buffer). Any non-empty
    // data means the agent is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(_agentSessionId: string, _cwd: string): Promise<string | null> {
    // Ollama has no native session history files for `ollama run`.
    return null;
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Ollama has no hooks or structured verification signals.
    // Callers fall back to time-based settle.
    return null;
  }

  /**
   * `effort` passes the user's level as `--think=<level>`. No `defaultEffort`:
   * an unset row must pass nothing, since a level on a model that cannot think
   * fails the run, and most models cannot.
   */
  readonly answerCapabilities = { streaming: false, search: false, model: true, effort: true };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * `ollama run <model>` with the prompt PIPED: it reads a prompt from stdin
   * when one is piped in, answers, and exits. Read-only by nature, since a
   * plain model run has no tools to write or execute with.
   *
   * `--hidethinking` keeps a thinking model's reasoning out of the answer.
   * Ollama turns thinking on by default for any model that supports it and
   * prints it to stdout between `Thinking...` and `...done thinking.` whether
   * or not stdout is a terminal; only this flag hides it
   * (https://github.com/ollama/ollama/blob/v0.40.14/cmd/cmd.go, and
   * https://ollama.com/blog/thinking, which names it for scripting). It needs
   * Ollama 0.9.0 or later, when thinking shipped, and an older CLI fails the
   * run on a flag it does not know. So once discovery has read this CLI's
   * help and found no `--think` flag, the flag is left out. Before discovery,
   * or when every help read so far failed, it is passed.
   *
   * The effort arrives already checked: the answer run and the automation
   * agent pass only a level this CLI's discovery reported just before the run.
   *
   * The model is REQUIRED here, unlike the spawn path's `DEFAULT_OLLAMA_MODEL`
   * fallback: the Knowledge Graph Model setting is mandatory for this agent
   * (`answerCapabilities.model`), and a question never falls back to a model
   * nobody chose, which here would also mean pulling one.
   *
   * The prompt, its rules and the retrieval budget are all built upstream and
   * handed over whole; this only decides the CLI's flags.
   */
  async answerFromContext(
    prompt: string,
    cliPath: string,
    cwd: string,
    model?: string | null,
    options?: AnswerFromContextOptions,
  ): Promise<string> {
    const chosenModel = model?.trim();
    if (!chosenModel) throw new Error('choose a model for Ollama in Settings > Knowledge Graph');
    const args = ['run', chosenModel];
    const reportedLevels = this.reportedThinkLevels.get(shimFamilyKey(cliPath));
    if (!reportedLevels || reportedLevels.length > 0) args.push('--hidethinking');
    const effort = options?.effort?.trim();
    if (effort) args.push(thinkFlag(effort));
    return runCliPrintAnswer({
      cliPath,
      // An Ollama installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
      args,
      prompt,
      cwd,
    });
  }
}
