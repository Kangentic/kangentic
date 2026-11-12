import type { BoardColumnConfig } from '../../../shared/types';

/**
 * What a column field is when the file does not say: the value a column the
 * file introduces is created with (`apply-config.ts`), and the value a field
 * takes when the key that set it is removed from `kangentic.local.json`
 * (`ColumnFieldResets`). One table, so the two cannot drift. A new
 * team-shared column field adds its default here
 * (`.claude/rules/board-config-parity.md`).
 */
export const COLUMN_FIELD_DEFAULTS = {
  description: null,
  color: '#3b82f6',
  icon: null,
  archived: false,
  permissionMode: null,
  autoSpawn: true,
  agentOverride: null,
  modelOverride: null,
  effortOverride: null,
  handoffContext: false,
  sessionTarget: 'main',
  sessionSpawnStrategy: 'create_or_resume',
} as const satisfies Partial<Record<keyof BoardColumnConfig, unknown>>;
