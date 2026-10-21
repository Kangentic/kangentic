/**
 * One-time read of the retired idle-timeout encoding.
 *
 * `agent.idleTimeoutMinutes` used to carry the switch and the value together:
 * 0 meant off, anything above 0 was the timeout. It is now a switch,
 * `agent.idleTimeoutEnabled`, and the minutes beside it. A saved timeout above
 * 0 reads as on with its minutes kept. A saved 0 reads as off, with the minutes
 * reset to the default, so turning the switch on later starts from a usable
 * value rather than 0. A saved `idleTimeoutEnabled` wins: the file was already
 * written in the new shape.
 *
 * Runs on the global config only. The switch is global (Settings > Performance)
 * and never belongs in a project's `.kangentic/config.json`; reading one there
 * as on would let a stale per-project timeout override the user's global off.
 */

/** What a retired timeout meant as a switch. Only a positive number of minutes was on. */
export function legacyIdleTimeoutIsOn(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
}

/**
 * Rewrite the retired encoding on `agent` in place. `explicit` is the `agent`
 * block as parsed from the file (the in-memory copy already carries the new
 * keys' defaults). Returns whether anything changed, so the caller knows to
 * persist the result.
 */
export function migrateLegacyIdleTimeout(
  agent: Record<string, unknown>,
  explicit: Record<string, unknown> | undefined,
  defaultMinutes: number,
): boolean {
  if (!explicit || !('idleTimeoutMinutes' in explicit)) return false;
  if ('idleTimeoutEnabled' in explicit) return false;
  const savedMinutes = explicit.idleTimeoutMinutes;
  if (legacyIdleTimeoutIsOn(savedMinutes)) {
    agent.idleTimeoutEnabled = true;
    agent.idleTimeoutMinutes = savedMinutes;
  } else {
    agent.idleTimeoutEnabled = false;
    agent.idleTimeoutMinutes = defaultMinutes;
  }
  return true;
}
