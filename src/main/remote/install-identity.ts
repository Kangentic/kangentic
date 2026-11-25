import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { remoteHostReporter } from './remote-report';

const FILE_NAME = 'remote-install-id';

/**
 * A stable id for this Kangentic installation, which a host's helper uses to tell this computer
 * reconnecting from another one taking over (#913). It is made once and kept in the config folder.
 *
 * If the file cannot be written, the id lasts for this run only, and the next launch looks like a new
 * installation to a host that still holds this one's sessions. That host then refuses the connection
 * with its own sentence (it names the other installation), which is the safe failure.
 */
export function readInstallId(configDirectory: string, log: (line: string) => void = console.warn): string {
  const file = path.join(configDirectory, FILE_NAME);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch {
    // report-ok: ENOENT on first run, before the id is ever written. A file that cannot be read
    // gets a new id too, made and written below.
  }
  const created = randomUUID();
  try {
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(file, created, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    // The id lasts for this run only. The next launch looks like another installation to a host
    // that still holds this one's sessions, and that host refuses the connection.
    remoteHostReporter.report(error, { tags: { stage: 'install_identity_write' } });
    log(`[remote] could not keep the installation id (${error instanceof Error ? error.message : String(error)}); it lasts for this run only`);
  }
  return created;
}
