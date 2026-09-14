/**
 * The contract every automation type implements. Mirrors `src/main/pr/shared/`
 * and `src/main/boards/shared/`: a shared interface, one folder per type under
 * `adapters/`, and a registry that dispatches without knowing the types.
 *
 * Two things the adapter deliberately does NOT do, both because forgetting
 * either one is a security bug rather than a missing feature:
 *
 * 1. **It never interpolates.** The runner substitutes template variables
 *    before calling `execute`, walking the manifest's `fields` and applying
 *    each field's own `escape`. So `config` arrives fully resolved with no
 *    `{{...}}` left, and an adapter cannot put a raw imported issue title into
 *    a shell body or a JSON body.
 * 2. **It never retries and never times out itself.** Both are declared on the
 *    manifest entry and enforced by the runner, so the policy is uniform and
 *    visible in one place.
 */
import type {
  AutoCommandMode,
  AutomationConfig,
  AutomationTrigger,
  AutomationType,
  NotificationInput,
  Swimlane,
  Task,
} from '../../../shared/types';
import type { AutomationManifestEntry } from '../../../shared/automation-manifest';

/**
 * The slice of SessionManager an adapter may touch. Narrow on purpose: it keeps
 * the unit tests free of a real PTY, and it makes it obvious that an adapter
 * cannot reach into session lifecycle it has no business in.
 *
 * It is ONE method, and that is the point. It used to carry `spawn` / `kill` /
 * `on` / `off` so the script adapter could run its script as a PTY session;
 * that was the wrong mechanism (an interactive shell never exits, so the
 * script's completion was unobservable) and the adapter now runs an ordinary
 * child process. All it needs from the session layer is WHICH shell the user's
 * terminals run, so a script behaves the way it does when they test it by hand.
 */
export interface AutomationSessionHost {
  getShell(): Promise<string>;
}

export interface AutomationContext {
  task: Task;
  /** The column that OWNS this automation, which is the source on exit and the destination on enter. */
  column: Swimlane;
  fromColumn: Swimlane | null;
  toColumn: Swimlane | null;
  trigger: AutomationTrigger;
  /** `task.worktree_path ?? projectPath`, resolved once. A script always runs task-relative. */
  cwd: string;
  projectId: string;
  projectPath: string | null;
  projectName: string | null;
  /**
   * Every template variable, resolved and UNESCAPED. `config` is already
   * substituted, so this is here for the two consumers that need the values as
   * data rather than as text: the script adapter's `KANGENTIC_*` environment
   * variables, and the webhook's default JSON envelope.
   */
  templateVars: Record<string, string>;
  sessionHost: AutomationSessionHost;
  /**
   * Deliver a message to the task's agent. Owned by the engine because it
   * applies the three delivery rungs (the resume prompt, the initial prompt on
   * a promptless fresh spawn, else the scheduled keystroke burst) depending on
   * whether the agent was just started by this same run.
   *
   * Whether the returned promise WAITS for the keystrokes to land is the
   * caller's decision, and the two callers answer differently for a reason. On
   * enter nothing touches the session afterwards, so delivery is scheduled and
   * its outcome reported on its own channel. On exit the move goes straight on
   * to kill, suspend or re-point the session, and each of those cancels the
   * burst in flight, so the exit caller awaits the outcome instead. `signal`
   * is what bounds that wait: it is this run's own, so the exit group's budget
   * caps it.
   */
  deliverToAgent(message: string, mode: AutoCommandMode, signal: AbortSignal): Promise<void>;
  showNotification(input: NotificationInput): void;
  /**
   * Run the full agent-spawn pipeline for a legacy `spawn_agent` row. Present
   * only on enter, and only the legacy adapter uses it.
   *
   * It is on the context rather than inside the adapter because spawning needs
   * CLI detection, trust, permission resolution, session-target resolution and
   * the PTY, none of which belongs behind this contract. Keeping the legacy
   * adapter in the registry anyway is what lets the picker, the validator and
   * the row sentence treat it like any other type, which is how it can be shown
   * with a lint instead of crashing something.
   */
  legacySpawnAgent?(config: AutomationConfig): Promise<void>;
  /** The move's signal, combined with this run's own timeout. */
  signal: AbortSignal;
  /** The `automation_runs` row id. The webhook sends it as its idempotency key. */
  runId: string;
  onProgress?: (phase: string) => void;
}

/**
 * What one execution reports on success. `detail` is a one-line summary stored
 * on the run row and shown under the automation in Board setup, so it should
 * read as an answer to "did this work": "HTTP 204", "exit 0", "Delivered".
 */
export interface AutomationOutcome {
  detail: string;
}

export interface AutomationAdapter {
  readonly id: AutomationType;
  readonly manifest: AutomationManifestEntry;
  /**
   * The one-line sentence shown on the automation's row. Must never throw, on
   * any config including `{}`, because a half-built draft renders through it.
   */
  describe(config: AutomationConfig): string;
  execute(config: AutomationConfig, context: AutomationContext): Promise<AutomationOutcome>;
  /**
   * Text this automation would rather have delivered as the agent's OWN
   * starting prompt than typed at it afterwards, when this row is the one that
   * starts the agent.
   *
   * A spawn has exactly one prompt slot, and using it is strictly better than
   * the alternative: a resumed session takes the text as its next message, and
   * a promptless fresh spawn (an isolated review column) would otherwise sit at
   * an empty prompt emitting no activity, so the keystroke scheduler waits out
   * its full 30 second fallback before the message appears. That reads as "the
   * automation never ran".
   *
   * Only `send_message` implements it. Returning a string is a request, not a
   * guarantee: the spawn decides whether the slot is free, and tells
   * `deliverToAgent` so the row is not delivered twice.
   */
  pendingPrompt?(config: AutomationConfig): string | undefined;
}
