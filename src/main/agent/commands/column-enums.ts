/**
 * The enum-valued column settings, and the one narrowing helper that guards
 * them, shared by the column handlers and the Board Profile handlers.
 *
 * Both write the same fields, and both are reachable from the mobile bridge,
 * which routes straight into `commandHandlers` (`board-tool.ts` validates only
 * that `params` is an object) and never sees the zod schemas in
 * `src/main/agent/mcp-http/`. So the handler is the only narrowing on that path,
 * and a value that slips through is not merely rejected late:
 *
 * - `session_target` / `session_spawn_strategy` have no CHECK constraint and
 *   `SwimlaneRepository.mapRow` ASSERTS rather than narrows, so a bad value
 *   persists and reads back as a valid union member.
 * - `auto_command_mode` is the mirror case: `mapRow` collapses anything that is
 *   not 'deferred' to 'immediate', so a typo silently acts as the default.
 * - A profile entry is worse than either, because it is written to
 *   `kangentic.json` and reaches the whole team.
 */

import type {
  AutoCommandMode,
  PermissionMode,
  SessionSpawnStrategy,
  SessionTarget,
} from '../../../shared/types';

export const VALID_PERMISSION_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto'];
export const VALID_SESSION_TARGETS: SessionTarget[] = ['main', 'isolated'];
export const VALID_SESSION_SPAWN_STRATEGIES: SessionSpawnStrategy[] = ['create_or_resume', 'always_spawn_new'];
export const VALID_AUTO_COMMAND_MODES: AutoCommandMode[] = ['immediate', 'deferred'];

/**
 * Every enum-valued field a caller can set on a column, paired with its allowed
 * values, keyed by the camelCase parameter name both surfaces use.
 *
 * A profile entry carries the same names, so this table is what lets the profile
 * handlers validate without re-listing them. Adding an enum field to a column
 * means adding it here.
 */
export const COLUMN_ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  permissionMode: VALID_PERMISSION_MODES,
  sessionTarget: VALID_SESSION_TARGETS,
  sessionSpawnStrategy: VALID_SESSION_SPAWN_STRATEGIES,
  autoCommandMode: VALID_AUTO_COMMAND_MODES,
};

/** Membership test written as a type predicate, so the success path needs no cast. */
function isEnumMember<T extends string>(candidate: string, valid: readonly T[]): candidate is T {
  return (valid as readonly string[]).includes(candidate);
}

/**
 * Narrow a raw value to one of a column's enum fields, or report the error the
 * caller sees. Callers handle `undefined` (absent) and `null` (clear) before
 * reaching here; this only decides whether a present value is a member.
 *
 * A non-string is rejected rather than coerced. `String(['isolated'])` is
 * 'isolated', so coercing first would accept a caller that sent the wrong JSON
 * shape, and on the mobile-bridge path this function is the only narrowing in
 * front of the write.
 */
export function parseEnumParam<T extends string>(
  raw: unknown,
  valid: readonly T[],
  paramName: string,
): { value: T } | { error: string } {
  if (typeof raw !== 'string' || !isEnumMember(raw, valid)) {
    return { error: `Invalid ${paramName} "${String(raw)}". Valid values: ${valid.join(', ')}.` };
  }
  return { value: raw };
}
