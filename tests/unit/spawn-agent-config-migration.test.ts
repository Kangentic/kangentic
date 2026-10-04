/**
 * Unit tests for `migrateSpawnAgentConfig` - the pure per-row data
 * migration applied to every `spawn_agent` action's parsed config when a
 * project DB opens. Step 4 (the {{task_xml}} envelope rewrite) was added
 * in this PR; the surrounding steps were extracted from project-schema.ts
 * at the same time so this function could be exercised without a database
 * handle at all.
 */

import { describe, it, expect } from 'vitest';
import { migrateSpawnAgentConfig } from '../../src/main/db/migrations/spawn-agent-config-migration';
import type { ActionConfig } from '../../src/shared/types';

describe('migrateSpawnAgentConfig - step 4 (XML envelope rewrite)', () => {
  it('rewrites the exact prior default to the XML envelope form', () => {
    const result = migrateSpawnAgentConfig({
      promptTemplate: '{{title}}{{description}}{{attachments}}',
    });
    expect(result.changed).toBe(true);
    expect(result.config.promptTemplate).toBe('{{task_xml}}{{attachments}}');
  });

  it('leaves a customized template untouched', () => {
    const customTemplate = 'Custom: {{title}} - {{description}}{{attachments}}';
    const result = migrateSpawnAgentConfig({ promptTemplate: customTemplate });
    expect(result.changed).toBe(false);
    expect(result.config.promptTemplate).toBe(customTemplate);
  });

  it('leaves an already-migrated XML template untouched', () => {
    const result = migrateSpawnAgentConfig({
      promptTemplate: '{{task_xml}}{{attachments}}',
    });
    expect(result.changed).toBe(false);
    expect(result.config.promptTemplate).toBe('{{task_xml}}{{attachments}}');
  });

  it('is idempotent: running twice on the same input yields no further change', () => {
    const firstPass = migrateSpawnAgentConfig({
      promptTemplate: '{{title}}{{description}}{{attachments}}',
    });
    const secondPass = migrateSpawnAgentConfig(firstPass.config);
    expect(secondPass.changed).toBe(false);
    expect(secondPass.config.promptTemplate).toBe('{{task_xml}}{{attachments}}');
  });

  it('does not mutate the input config object', () => {
    const original: ActionConfig = {
      promptTemplate: '{{title}}{{description}}{{attachments}}',
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    migrateSpawnAgentConfig(original);
    expect(original).toEqual(snapshot);
  });
});

describe('migrateSpawnAgentConfig - prior steps still apply', () => {
  it('appends {{attachments}} when missing (step 1)', () => {
    const result = migrateSpawnAgentConfig({
      promptTemplate: 'Task: {{title}}\n{{description}}',
    });
    expect(result.changed).toBe(true);
    // After step 1 appends `{{attachments}}` and step 3 normalizes the
    // legacy `Task: {{title}}...` form, step 4 then upgrades the result
    // to the XML envelope. Net effect: legacy template -> modern default.
    expect(result.config.promptTemplate).toBe('{{task_xml}}{{attachments}}');
  });

  it('drops legacy action-level permissionMode (step 2)', () => {
    const inputWithLegacyMode = {
      promptTemplate: '{{task_xml}}{{attachments}}',
      permissionMode: 'dangerously-skip',
    } as ActionConfig & { permissionMode?: string };
    const result = migrateSpawnAgentConfig(inputWithLegacyMode);
    expect(result.changed).toBe(true);
    expect((result.config as { permissionMode?: string }).permissionMode).toBeUndefined();
  });

  it('promotes the legacy "Task: {{title}}..." template through step 3 then step 4', () => {
    const result = migrateSpawnAgentConfig({
      promptTemplate: 'Task: {{title}}: {{description}}{{attachments}}',
    });
    expect(result.changed).toBe(true);
    expect(result.config.promptTemplate).toBe('{{task_xml}}{{attachments}}');
  });

  it('skips entries with no promptTemplate', () => {
    const result = migrateSpawnAgentConfig({});
    expect(result.changed).toBe(false);
    expect(result.config.promptTemplate).toBeUndefined();
  });
});
