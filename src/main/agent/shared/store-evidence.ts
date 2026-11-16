import fs from 'node:fs';
import type { SessionIdStoreEvidence } from '../../../shared/types';

/**
 * Whether the path an agent's session store lives at exists as the kind it
 * should be, for an adapter's `sessionId.storeEvidence`. A missing path is
 * `absent`, and any other failure `unknown`. A fixed word, never a path.
 */
export async function pathStoreEvidence(storePath: string, kind: 'directory' | 'file'): Promise<SessionIdStoreEvidence> {
  try {
    const stats = await fs.promises.stat(storePath);
    return (kind === 'directory' ? stats.isDirectory() : stats.isFile()) ? 'present' : 'absent';
  } catch (error) {
    // report-ok: a missing path is the answer; any other failure reads as unknown.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}
