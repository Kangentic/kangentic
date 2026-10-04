import type { ActionConfig } from '../../../shared/types';

/**
 * Pure data migration applied to every `spawn_agent` action row's parsed
 * config. Extracted from `runProjectMigrations` so the per-row logic can be
 * unit-tested on plain config objects, with no database. The SQL caller
 * iterates rows; this function only transforms a single config object.
 *
 * Steps applied in order:
 *  1. Append `{{attachments}}` to prompt templates that lack it.
 *  2. Drop legacy action-level `permissionMode` (now resolved per-swimlane).
 *  3. Replace the legacy `Task: {{title}}...` template with the
 *     post-attachments default `{{title}}{{description}}{{attachments}}`.
 *  4. Migrate the post-attachments default to the XML envelope form
 *     `{{task_xml}}{{attachments}}`. Only exact matches are rewritten;
 *     user-customized templates are left alone.
 *
 * Idempotent: running the function twice on the same config produces no
 * additional changes (`changed === false` on the second pass).
 */
export function migrateSpawnAgentConfig(input: ActionConfig): {
  config: ActionConfig;
  changed: boolean;
} {
  const config: ActionConfig = { ...input };
  let changed = false;

  // 1. Append {{attachments}} if missing
  if (config.promptTemplate && !config.promptTemplate.includes('{{attachments}}')) {
    config.promptTemplate = config.promptTemplate + '{{attachments}}';
    changed = true;
  }

  // 2. Drop legacy action-level permissionMode (moved to swimlane override)
  if ((config as { permissionMode?: unknown }).permissionMode !== undefined) {
    delete (config as { permissionMode?: unknown }).permissionMode;
    changed = true;
  }

  // 3. Update old 'Task: {{title}}...' prompt template
  if (config.promptTemplate && config.promptTemplate.includes('Task: {{title}}')) {
    config.promptTemplate = '{{title}}{{description}}{{attachments}}';
    changed = true;
  }

  // 4. Migrate the prior default to the XML envelope form
  if (config.promptTemplate === '{{title}}{{description}}{{attachments}}') {
    config.promptTemplate = '{{task_xml}}{{attachments}}';
    changed = true;
  }

  return { config, changed };
}
