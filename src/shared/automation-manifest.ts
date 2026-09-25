/**
 * The single declaration of what every automation type IS: its label, its
 * description, its icon, its fields, its timeout and its retry policy.
 *
 * One manifest drives five consumers, which is the whole point of the adapter
 * design: the picker's type list, the Edit automation dialog's fields, the
 * `kangentic.json` validator, the row sentence, and the docs table. Adding a
 * type is one folder under `src/main/automations/adapters/` plus one entry here.
 *
 * Renderer-safe by contract: no Node imports and NO JSX, because
 * `automation-registry.ts` and every adapter import this file in the main
 * process. `icon` is therefore a kebab-case NAME resolved to a lucide element by
 * a renderer-side map, the pattern `utils/swimlane-icons.tsx` already uses for
 * persisted column icons.
 */
import { NEVER_AUTO_SPAWN_ROLES } from './types';
import type { AutoCommandMode, AutomationTrigger, AutomationType, SwimlaneRole } from './types';

/** A capability an automation needs from its column before it can run. */
export type AutomationNeed = 'agent';

export type AutomationFieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'segmented'
  | 'lines'
  | 'headers'
  | 'number';

/**
 * How a substituted template value is escaped for THIS field.
 *
 * Per field, not per adapter, because one adapter can hold a shell body and a
 * plain-text title. A task title can arrive from an imported GitHub issue, so it
 * is not text this user wrote: substituting it raw into a shell body or a JSON
 * body is injection. `'none'` is legal only for prose going to an agent, and the
 * parity test enforces that.
 */
export type AutomationFieldEscape = 'none' | 'shell' | 'json' | 'url';

export interface AutomationFieldOption {
  value: string;
  label: string;
  /** kebab-case lucide name, resolved by the renderer's icon map. */
  icon?: string;
  testId?: string;
}

export interface AutomationField {
  key: string;
  label: string;
  kind: AutomationFieldKind;
  escape: AutomationFieldEscape;
  placeholder?: string;
  options?: readonly AutomationFieldOption[];
  templateVariables?: boolean;
  /**
   * Standing copy, so it must be essential AND non-obvious per
   * `.claude/rules/ui-conventions.md`. Two fields earn one: a script's cwd (the
   * only place that fact exists, and it changes what you type) and a webhook's
   * header format (a format contract).
   */
  hint?: string;
  min?: number;
  max?: number;
  defaultValue?: string | number;
  rows?: number;
  /**
   * What a `number` field counts, printed after the input. A bare box holding
   * "5" does not say five of what, and putting the unit in the label instead
   * ("Give up after (minutes)") both reads worse and can be lost in a label
   * rewrite. Required on every `number` field by the reserved-keys test.
   */
  unit?: string;
  /**
   * Declared, but not offered in the Edit automation dialog.
   *
   * The declaration is what makes the key survive a save: `serializeAutomation`
   * prunes every config key the manifest does not declare, so dropping a field
   * outright would silently erase a hand-written value from `kangentic.json` the
   * next time anyone saved that column in the UI. Hiding keeps the round trip
   * and removes the control, which is the same shape `session_spawn_strategy`
   * already uses: still read from the file, no longer offered.
   */
  hidden?: boolean;
}

export interface AutomationManifestEntry {
  label: string;
  /** One line, under 110 characters, shown in the picker. Pinned by the parity test. */
  description: string;
  icon: string;
  status: 'stable' | 'legacy';
  needs: readonly AutomationNeed[];
  fields: readonly AutomationField[];
  /**
   * Wall-clock budget for one execution, or null when the adapter cannot hang
   * (notify) or owns its own deadline (send_message, through
   * `TerminalSubmitScheduler`). Declared rather than inlined in the engine
   * because nothing times out today: `withTaskLock` is a PQueue with no
   * timeout and Phase 3 holds it across the whole list, so one hung row wedges
   * every later operation on that task until a restart.
   */
  timeoutMs: number | null;
  retry: { attempts: number; on: 'network-or-5xx' } | null;
}

/**
 * Keys the `kangentic.json` row shape owns, so no adapter may declare a field
 * with one of these names. This is what keeps the flat row shape
 * (`{ name, type, enabled, ...fields }`) safe as reserved keys grow, and it is
 * checked by `tests/unit/automation-manifest-reserved-keys.test.ts`.
 */
export const RESERVED_AUTOMATION_KEYS = ['name', 'type', 'enabled'] as const;

/**
 * Action types that existed before automations and are dropped outright, rows
 * and all. Each was a no-op or a duplicate of the move path, so nothing stops
 * happening. Kept as a named list because the migration deletes them and the
 * file reader warns and skips them rather than failing validation, matching
 * what `apply-config.ts` already does for an unknown action.
 */
export const RETIRED_ACTION_TYPES = ['kill_session', 'create_worktree', 'cleanup_worktree'] as const;

/**
 * Aggregate cap on a column's exit group, overriding the adapters' own
 * timeouts. Exit rows run inside the move's Phase 1 lock, which is the SHORT
 * lock, and holding it is what wedges that task's next move. Exit is for quick
 * handoffs; long work belongs on enter, where Phase 3 already holds the lock
 * across the agent spawn and shows a progress spinner for it.
 */
export const EXIT_GROUP_BUDGET_MS = 60_000;

/** Default per-automation script budget, in minutes. */
/**
 * Ten rather than five, because nothing in the UI raises it any more.
 *
 * The script people actually write here is `npm ci`, which is under a minute on
 * a warm cache and several on a cold one. Five was chosen when a visible field
 * could rescue the slow case; with the field gone the default has to cover it,
 * and the cost of being generous is bounded - this is the ceiling on a hang, not
 * a delay anything waits out on a healthy run.
 */
export const DEFAULT_SCRIPT_TIMEOUT_MINUTES = 10;

const AUTO_COMMAND_MODE_FIELD_OPTIONS: readonly AutomationFieldOption[] = [
  { value: 'immediate' satisfies AutoCommandMode, label: 'Run immediately', icon: 'zap', testId: 'auto-command-mode-immediate' },
  { value: 'deferred' satisfies AutoCommandMode, label: 'Wait for current turn', icon: 'clock', testId: 'auto-command-mode-deferred' },
];

export const AUTOMATION_MANIFEST: Record<AutomationType, AutomationManifestEntry> = {
  send_message: {
    label: 'Send message to agent',
    description: 'Sends a message to the agent working on the task.',
    icon: 'message-square',
    status: 'stable',
    needs: ['agent'],
    timeoutMs: null,
    retry: null,
    fields: [
      {
        key: 'message',
        label: 'Message',
        kind: 'textarea',
        // Prose going to an agent, which is the one context where a raw value
        // is correct: the agent reads it as text, not as code.
        escape: 'none',
        templateVariables: true,
        rows: 3,
        placeholder: 'Review the latest changes and fix any issues you find',
      },
      {
        key: 'mode',
        label: 'Delivery',
        kind: 'segmented',
        escape: 'none',
        options: AUTO_COMMAND_MODE_FIELD_OPTIONS,
        defaultValue: 'immediate',
      },
    ],
  },

  run_script: {
    label: 'Run script',
    description: 'Runs a shell command and waits for it to finish.',
    icon: 'square-terminal',
    status: 'stable',
    needs: [],
    timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MINUTES * 60_000,
    retry: null,
    fields: [
      {
        key: 'script',
        label: 'Script',
        kind: 'textarea',
        escape: 'shell',
        templateVariables: true,
        rows: 3,
        hint: "Runs in the task's worktree, or the project checkout when it has none.",
      },
      {
        // Enforced, never offered. The bound has to exist: enter automations run
        // inside `withTaskLock`, which is a PQueue with NO timeout of its own, so
        // a script that never exits wedges every later operation on that task
        // until the app restarts. "The script can time itself out" assumes the
        // script reaches its own guard, and the cases that matter are the ones
        // where it does not - waiting on stdin, a dead registry, a wedged shell -
        // where it also cannot kill its own process tree, which the adapter does.
        //
        // The CONTROL went because it could not tell the truth. An exit group is
        // capped at EXIT_GROUP_BUDGET_MS in aggregate whatever an adapter
        // declares, so "Give up after 5 minutes" on an On exit script meant 60
        // seconds. A number nobody tunes, that lies on half the rows it appears
        // on, is worse than no number.
        key: 'timeoutMinutes',
        label: 'Give up after',
        kind: 'number',
        escape: 'none',
        unit: 'minutes',
        min: 1,
        max: 120,
        defaultValue: DEFAULT_SCRIPT_TIMEOUT_MINUTES,
        hidden: true,
      },
    ],
  },

  webhook: {
    label: 'Call webhook',
    description: 'Sends an HTTP request. Retries a network error or a 5xx.',
    icon: 'webhook',
    status: 'stable',
    needs: [],
    timeoutMs: 30_000,
    retry: { attempts: 3, on: 'network-or-5xx' },
    fields: [
      { key: 'url', label: 'URL', kind: 'text', escape: 'url', templateVariables: true, placeholder: 'https://hooks.example.com/abc' },
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        escape: 'none',
        defaultValue: 'POST',
        options: [
          { value: 'POST', label: 'POST' },
          { value: 'GET', label: 'GET' },
          { value: 'PUT', label: 'PUT' },
        ],
      },
      {
        key: 'body',
        label: 'Body',
        kind: 'textarea',
        escape: 'json',
        templateVariables: true,
        rows: 3,
        placeholder: 'Leave empty to send the default JSON payload',
      },
      {
        key: 'headers',
        label: 'Headers',
        kind: 'headers',
        escape: 'none',
        hint: 'One per line, as Name: Value.',
      },
    ],
  },

  notify: {
    label: 'Notify me',
    description: 'Shows a desktop notification. Clicking it opens the task.',
    icon: 'bell',
    status: 'stable',
    needs: [],
    timeoutMs: null,
    retry: null,
    fields: [
      // {{title}}, not {{taskTitle}}: the latter belongs to the separate
      // Shortcut command system in `src/shared/template-vars.ts`, and is one of
      // that system's two name collisions with this one.
      { key: 'title', label: 'Title', kind: 'text', escape: 'none', templateVariables: true, defaultValue: '{{title}}' },
      { key: 'body', label: 'Body', kind: 'text', escape: 'none', templateVariables: true, defaultValue: '{{toColumn}}' },
    ],
  },

  spawn_agent: {
    label: 'Start agent',
    description: "Legacy. The column's Start an agent here setting does this now.",
    icon: 'bot',
    status: 'legacy',
    needs: [],
    timeoutMs: null,
    retry: null,
    fields: [
      { key: 'promptTemplate', label: 'Prompt', kind: 'textarea', escape: 'none', templateVariables: true, rows: 3 },
    ],
  },
};

/** The facts `canColumnRun` needs, so a renderer draft can answer without a full Swimlane. */
export interface AutomationColumnFacts {
  autoSpawn: boolean;
  role: SwimlaneRole | null;
}

export type AutomationRunnability = { ok: true } | { ok: false; reason: string };

/**
 * Can this column run this type on this trigger? Shared by the engine (which
 * skips a row it says no to, and records the reason on the run) and the
 * renderer (which shows the row off with a disabled switch, and the type as a
 * disabled picker option). One answer, so the board and the engine can never
 * disagree about what will happen.
 */
export function canColumnRun(
  type: AutomationType,
  column: AutomationColumnFacts,
  trigger: AutomationTrigger,
): AutomationRunnability {
  // Reads `NEVER_AUTO_SPAWN_ROLES` rather than naming todo and done again. The
  // two rules are NOT the same concept and this is not derived from that one:
  // `spawnAgent` refuses those roles an agent, while this refuses them an ENTER
  // automation of any type, which is a product decision (To Do and Done take
  // exit rows only). They happen to name the same two system columns, and
  // spelling that pair out twice is how the promise above stops being true - a
  // third system role would be added to one set and silently missed by the
  // other, leaving the board offering a row the engine will never run.
  // A future role has to decide BOTH questions; sharing the set is what forces
  // whoever adds it to come here and say so.
  if (trigger === 'enter' && column.role !== null && NEVER_AUTO_SPAWN_ROLES.has(column.role)) {
    return { ok: false, reason: 'Nothing runs when a task enters To Do or Done.' };
  }
  if (AUTOMATION_MANIFEST[type].needs.includes('agent') && !column.autoSpawn) {
    return { ok: false, reason: 'Start an agent here is off.' };
  }
  return { ok: true };
}

/** The types offered for a NEW automation, in picker order. Never includes a legacy type. */
export function stableAutomationTypes(): AutomationType[] {
  return (Object.keys(AUTOMATION_MANIFEST) as AutomationType[])
    .filter((type) => AUTOMATION_MANIFEST[type].status === 'stable');
}

export function isAutomationType(value: string): value is AutomationType {
  return Object.prototype.hasOwnProperty.call(AUTOMATION_MANIFEST, value);
}

export function isRetiredActionType(value: string): boolean {
  return (RETIRED_ACTION_TYPES as readonly string[]).includes(value);
}
