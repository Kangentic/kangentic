/**
 * An agent session id plausible enough to persist or hand an agent CLI as
 * `--resume`. A hand-edited or corrupted file, a transcript record, or a hook
 * payload the event bridge cut short can carry anything in its id field. It
 * starts with a letter or digit, so a CLI never reads it as a flag.
 */
export const PLAUSIBLE_AGENT_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
