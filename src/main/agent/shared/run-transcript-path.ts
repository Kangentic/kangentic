import fs from 'node:fs';
import path from 'node:path';
import { hostPathForTarget, type CliPlace } from './cli-target';

/** Where a run's transcript is, as the session-metrics readers pass it. */
export interface RunTranscriptInput {
  transcriptPath?: string | null;
  agentSessionId?: string | null;
  cwd?: string | null;
  place?: CliPlace | null;
}

/**
 * The transcript a run-level read targets: the path the agent reported when
 * that file is there, whatever id it names, since a live report moves to a new
 * conversation's file before the session row's id does. Else wherever `locate`
 * finds the conversation. With no session id or cwd to locate by, the reported
 * path as given, else null.
 */
export async function resolveRunTranscriptPath(
  input: RunTranscriptInput,
  locate: (agentSessionId: string, cwd: string, place: CliPlace | null) => string | null | Promise<string | null>,
): Promise<string | null> {
  const place = input.place ?? null;
  // An agent in a WSL distro reports its transcript by its Linux path.
  const reported = input.transcriptPath ? hostPathForTarget(input.transcriptPath, place) : null;
  if (reported && path.isAbsolute(reported) && await fs.promises.stat(reported).then(() => true, () => false)) {
    return reported;
  }
  if (input.agentSessionId && input.cwd) return locate(input.agentSessionId, input.cwd, place);
  return reported;
}
