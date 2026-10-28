import { describe, it, expect } from 'vitest';
import {
  automationRegistry,
  registeredAutomationAdapters,
} from '../../src/main/automations/automation-registry';
import {
  AUTOMATION_MANIFEST,
  RETIRED_ACTION_TYPES,
  automationMoveTargetName,
  automationMovesTask,
  canColumnRun,
  canTriggerRun,
  isAutomationType,
  isRetiredActionType,
  stableAutomationTypes,
} from '../../src/shared/automation-manifest';
import type { AutomationColumnFacts } from '../../src/shared/automation-manifest';
import { englishText } from '../../src/shared/i18n/english';
import type { AutomationType } from '../../src/shared/types';

/**
 * CI backstop for the automation adapter contract.
 *
 * One manifest drives five consumers (the picker, the dialog's fields, the
 * `kangentic.json` validator, the row sentence, the docs table), so a manifest
 * entry with no adapter is a picker option that throws when chosen, and an
 * adapter with no manifest entry has no fields to render. These run against the
 * REAL registry rather than a copy, so adding a type wrong fails here.
 *
 * The escape assertion is the one with teeth. A field that pairs
 * `templateVariables: true` with `escape: 'none'` substitutes a value that can
 * arrive from an imported GitHub issue straight into whatever that field is,
 * which is fine for prose an agent reads and is injection for a shell body or a
 * JSON body. The allowlist below is the deliberate set; a new raw field fails
 * until someone adds it here on purpose.
 */

/** Every (type, field) that substitutes a raw, unescaped value, and why it may. */
const RAW_SUBSTITUTION_FIELDS = [
  // Prose the agent reads as text, never as code.
  'send_message.message',
  // The same, for the agent in the column a Move to column row sends the task
  // to: often a whole review verdict through {{agentReply}}.
  'move_to_column.message',
  // A notification's own strings. They are rendered by the OS, not executed or parsed.
  'notify.title',
  'notify.body',
  // The legacy prompt, which is prose handed to a CLI as its prompt argument.
  'spawn_agent.promptTemplate',
].sort();

const TODO_COLUMN: AutomationColumnFacts = { autoSpawn: false, role: 'todo' };
const DONE_COLUMN: AutomationColumnFacts = { autoSpawn: false, role: 'done' };
const AGENT_COLUMN: AutomationColumnFacts = { autoSpawn: true, role: null };
const NO_AGENT_COLUMN: AutomationColumnFacts = { autoSpawn: false, role: null };

describe('automation manifest and registry parity', () => {
  it('names the same set of types', () => {
    const manifestKeys = Object.keys(AUTOMATION_MANIFEST).sort();
    const registryKeys = registeredAutomationAdapters.map((adapter) => adapter.id).sort();
    expect(registryKeys).toEqual(manifestKeys);
  });

  it('gives every adapter the manifest entry for its own id', () => {
    for (const adapter of registeredAutomationAdapters) {
      expect(adapter.manifest).toBe(AUTOMATION_MANIFEST[adapter.id]);
    }
  });

  it('keeps spawn_agent as the only legacy type', () => {
    const legacy = registeredAutomationAdapters
      .filter((adapter) => adapter.manifest.status === 'legacy')
      .map((adapter) => adapter.id);
    expect(legacy).toEqual(['spawn_agent']);
  });

  it('does not resolve any retired action type', () => {
    for (const retired of RETIRED_ACTION_TYPES) {
      expect(automationRegistry.has(retired)).toBe(false);
      expect(automationRegistry.get(retired)).toBeUndefined();
      expect(isAutomationType(retired)).toBe(false);
      expect(isRetiredActionType(retired)).toBe(true);
    }
  });

  it('offers only stable types for a new automation', () => {
    expect(stableAutomationTypes()).toEqual(['send_message', 'run_script', 'webhook', 'notify', 'move_to_column']);
    expect(automationRegistry.stable().map((adapter) => adapter.id)).toEqual(stableAutomationTypes());
  });
});

describe('automation manifest entries', () => {
  it('gives every stable type fields and a one-line description', () => {
    for (const adapter of automationRegistry.stable()) {
      const entry = adapter.manifest;
      expect(entry.fields.length, `${adapter.id} declares no fields`).toBeGreaterThan(0);
      // Descriptors: the picker shows their English in an English session.
      const description = englishText(entry.description);
      expect(description.length, `${adapter.id} description is too long`).toBeLessThan(110);
      expect(description.trim()).toBe(description);
      expect(englishText(entry.label).length).toBeGreaterThan(0);
      expect(entry.icon).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  // `automationMoveTargetName` reads a moving row's target from its one
  // `column` field, and the workflow step check reads it to tell a row that
  // sends the task forward from one that sends it back. A moving type with no
  // such field, or two, would leave the step unable to say where its row goes.
  it('gives every type that moves the task exactly one column field, read back by the shared helpers', () => {
    const movingTypes = (Object.keys(AUTOMATION_MANIFEST) as AutomationType[]).filter((type) => automationMovesTask(type));
    expect(movingTypes).toEqual(['move_to_column']);
    for (const type of movingTypes) {
      const columnFields = AUTOMATION_MANIFEST[type].fields.filter((field) => field.kind === 'column');
      expect(columnFields, `${type} must declare exactly one column field`).toHaveLength(1);
      const key = columnFields[0].key;
      expect(automationMoveTargetName(type, { [key]: '  Testing ' })).toBe('Testing');
      expect(automationMoveTargetName(type, { [key]: '' })).toBeNull();
      expect(automationMoveTargetName(type, {})).toBeNull();
    }
    expect(automationMovesTask('send_message')).toBe(false);
    expect(automationMovesTask('kill_session')).toBe(false);
    expect(automationMoveTargetName('send_message', { targetColumn: 'Testing' })).toBeNull();
  });

  it('declares a timeout for every type that can hang', () => {
    // A webhook waits on a server and a script waits on a process, so both must
    // be bounded: nothing times out today, and one hung row holds the task lock
    // until a restart. Notify cannot hang; send_message is bounded by the
    // terminal submit scheduler's own deadline.
    expect(AUTOMATION_MANIFEST.webhook.timeoutMs).toBeGreaterThan(0);
    expect(AUTOMATION_MANIFEST.run_script.timeoutMs).toBeGreaterThan(0);
    expect(AUTOMATION_MANIFEST.notify.timeoutMs).toBeNull();
    expect(AUTOMATION_MANIFEST.send_message.timeoutMs).toBeNull();
  });

  it('retries only the webhook', () => {
    const retrying = Object.entries(AUTOMATION_MANIFEST)
      .filter(([, entry]) => entry.retry !== null)
      .map(([type]) => type);
    // A half-run script is not safe to repeat, and a message delivery has its
    // own one-shot escalation ladder. Only an idempotent HTTP call retries.
    expect(retrying).toEqual(['webhook']);
    expect(AUTOMATION_MANIFEST.webhook.retry?.attempts).toBe(3);
  });

  it('substitutes raw values only into the fields on the allowlist', () => {
    const raw: string[] = [];
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      for (const field of entry.fields) {
        if (field.templateVariables === true && field.escape === 'none') {
          raw.push(`${type}.${field.key}`);
        }
      }
    }
    expect(raw.sort()).toEqual(RAW_SUBSTITUTION_FIELDS);
  });

  it('escapes every template field that is not on the allowlist', () => {
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      for (const field of entry.fields) {
        if (field.templateVariables !== true) continue;
        if (RAW_SUBSTITUTION_FIELDS.includes(`${type}.${field.key}`)) continue;
        expect(field.escape, `${type}.${field.key} substitutes unescaped`).not.toBe('none');
      }
    }
  });

  it('drops the legacy run_script workingDir key', () => {
    // A script now always runs task-relative, so there is no setting to render.
    const keys = AUTOMATION_MANIFEST.run_script.fields.map((field) => field.key);
    expect(keys).not.toContain('workingDir');
  });
});

describe('automation describe()', () => {
  it('never throws on an empty config', () => {
    for (const adapter of registeredAutomationAdapters) {
      expect(() => adapter.describe({}), `${adapter.id} threw on {}`).not.toThrow();
      expect(adapter.describe({}).length).toBeGreaterThan(0);
    }
  });

  it('never throws on a config full of unsubstituted template variables', () => {
    // A half-built draft renders through describe(), and a URL carrying
    // `{{prUrl}}` is not parseable.
    const config = {
      message: '{{title}}',
      script: 'echo {{title}}',
      url: '{{prUrl}}',
      title: '{{title}}',
      body: '{{toColumn}}',
      promptTemplate: '{{task_xml}}',
    };
    for (const adapter of registeredAutomationAdapters) {
      expect(() => adapter.describe(config), `${adapter.id} threw`).not.toThrow();
    }
  });
});

describe('canColumnRun', () => {
  it('refuses an enter row on To Do and Done', () => {
    for (const type of stableAutomationTypes()) {
      expect(canColumnRun(type, TODO_COLUMN, 'enter').ok).toBe(false);
      expect(canColumnRun(type, DONE_COLUMN, 'enter').ok).toBe(false);
    }
  });

  it('allows an exit row on To Do and Done', () => {
    // A task LEAVING Done is a real move, and an exit automation is the only
    // way to act on it.
    expect(canColumnRun('webhook', TODO_COLUMN, 'exit').ok).toBe(true);
    expect(canColumnRun('webhook', DONE_COLUMN, 'exit').ok).toBe(true);
  });

  it('refuses an agent-needing type when the column does not start an agent', () => {
    const blocked = canColumnRun('send_message', NO_AGENT_COLUMN, 'enter');
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && englishText(blocked.reason)).toBe('Start an agent here is off.');

    expect(canColumnRun('send_message', AGENT_COLUMN, 'enter').ok).toBe(true);
  });

  it('allows a type that needs nothing on a column with no agent', () => {
    for (const type of ['run_script', 'webhook', 'notify'] satisfies AutomationType[]) {
      expect(canColumnRun(type, NO_AGENT_COLUMN, 'enter').ok, type).toBe(true);
    }
  });
});

/**
 * The turn-end refusals, word for word. Each one is shown in place of a
 * column's On agent turn end group, so its wording was approved on the #732
 * board (15) and a reword should fail here rather than ship unnoticed.
 */
describe('canTriggerRun: why nothing runs at a turn end', () => {
  function reasonFor(column: AutomationColumnFacts): string | null {
    const result = canTriggerRun(column, 'turn_end');
    return result.ok ? null : englishText(result.reason);
  }

  it('names To Do and Done each by itself', () => {
    expect(reasonFor(TODO_COLUMN)).toBe('Nothing runs at a turn end in To Do.');
    expect(reasonFor(DONE_COLUMN)).toBe('Nothing runs at a turn end in Done.');
  });

  it('says Start an agent here is off for a column with no agent', () => {
    expect(reasonFor(NO_AGENT_COLUMN)).toBe('Start an agent here is off, so no agent ends a turn here.');
  });

  it("says the column's agent can't report a finished turn", () => {
    expect(reasonFor({ ...AGENT_COLUMN, reportsTurnEnd: false })).toBe("This column's agent can't report when it finishes a turn.");
  });

  it('allows a column whose agent reports a turn end, or one not known yet', () => {
    expect(reasonFor({ ...AGENT_COLUMN, reportsTurnEnd: true })).toBeNull();
    expect(reasonFor(AGENT_COLUMN)).toBeNull();
  });

  it('refuses Move to column on enter and exit with its one-line reason', () => {
    for (const trigger of ['enter', 'exit'] as const) {
      const result = canColumnRun('move_to_column', AGENT_COLUMN, trigger);
      expect(result.ok === false && englishText(result.reason), trigger).toBe('Move to column runs only at a turn end.');
    }
  });
});
