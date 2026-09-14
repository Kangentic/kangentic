/**
 * Central registry of automation adapters. Mirrors `src/main/pr/pr-registry.ts`
 * and `src/main/boards/board-registry.ts`.
 *
 * To add an automation type:
 *   1. Add its entry to `AUTOMATION_MANIFEST` (`src/shared/automation-manifest.ts`).
 *   2. Create `adapters/<type>/` implementing `AutomationAdapter`.
 *   3. Register it below.
 *
 * Nothing else changes. The picker, the Edit automation dialog's fields, the
 * `kangentic.json` validator, the row sentence and the docs table are all
 * manifest-driven, which is what makes "one more type" one folder rather than a
 * feature. No type-name branching outside `adapters/`, per
 * `.claude/rules/automation-adapters.md`.
 */
import type { AutomationType } from '../../shared/types';
import { AUTOMATION_MANIFEST } from '../../shared/automation-manifest';
import type { AutomationAdapter } from './shared/automation-adapter';
import { sendMessageAdapter } from './adapters/send-message';
import { runScriptAdapter } from './adapters/run-script';
import { webhookAdapter } from './adapters/webhook';
import { notifyAdapter } from './adapters/notify';
import { legacySpawnAgentAdapter } from './adapters/legacy/spawn-agent';

export class AutomationRegistry {
  private readonly adapters = new Map<AutomationType, AutomationAdapter>();

  register(adapter: AutomationAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Automation adapter '${adapter.id}' is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AutomationAdapter | undefined {
    return this.adapters.get(id as AutomationType);
  }

  getOrThrow(id: AutomationType): AutomationAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Automation adapter not registered: ${id}`);
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id as AutomationType);
  }

  /** Every adapter, legacy included. */
  list(): AutomationAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** The adapters offered for a NEW automation, in manifest order. */
  stable(): AutomationAdapter[] {
    return this.list().filter((adapter) => adapter.manifest.status === 'stable');
  }
}

export const automationRegistry = new AutomationRegistry();

// Registration order is picker order for `stable()`. Send message first because
// it is what the column's message field became, so an upgrading user finds the
// thing they already had at the top of the list.
automationRegistry.register(sendMessageAdapter);
automationRegistry.register(runScriptAdapter);
automationRegistry.register(webhookAdapter);
automationRegistry.register(notifyAdapter);
automationRegistry.register(legacySpawnAgentAdapter);

/**
 * The registered adapters, read-only, so `tests/unit/automation-adapter-parity.test.ts`
 * can assert over the REAL registry rather than a hand-maintained copy. Not for
 * dispatch: callers use `automationRegistry`.
 */
export const registeredAutomationAdapters: readonly AutomationAdapter[] = automationRegistry.list();

/**
 * The manifest keys and the registry must name the same set. Checked at module
 * load as well as in the parity test, because a manifest entry with no adapter
 * is a picker option that throws when chosen, and an adapter with no manifest
 * entry has no fields to render.
 */
const manifestKeys = Object.keys(AUTOMATION_MANIFEST).sort();
const registryKeys = registeredAutomationAdapters.map((adapter) => adapter.id).sort();
if (manifestKeys.join(',') !== registryKeys.join(',')) {
  throw new Error(
    `Automation manifest and registry disagree: manifest has [${manifestKeys.join(', ')}], registry has [${registryKeys.join(', ')}]`,
  );
}
