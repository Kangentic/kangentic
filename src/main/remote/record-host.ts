import { parseStoredCliTarget } from '../agent/shared/cli-target';
import type { SessionRecord } from '../../shared/types';

/**
 * The host a session record's agent ran on, or null for a record that ran on this computer (#913). Its own
 * module so the quit path and the auto-spawn can ask without loading the agent registry.
 */
export function hostOfRecord(record: Pick<SessionRecord, 'cli_target'>): string | null {
  const target = parseStoredCliTarget(record.cli_target);
  return target?.kind === 'ssh' ? target.hostId : null;
}
