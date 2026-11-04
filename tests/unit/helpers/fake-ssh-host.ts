/**
 * A remote host's files in memory, and an `ssh` CLI place wired to them, for tests of anything that
 * reads or edits files on a host (#913). It answers the way the helper does: a path is beneath the
 * host's home, a missing file reads as absent, a write makes the file, a removal of a missing file is
 * not an error. Nothing here touches the disk; `runCommand` answers from `commandResults`.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SshCliPlace } from '../../../src/main/agent/shared/cli-target';
import { resetHostFileSyncState } from '../../../src/main/remote/host-file-sync';
import type { HostCommandRequest, HostCommandResult, HostFileWrite } from '../../../src/main/remote/protocol/messages';

export class FakeSshHost {
  files = new Map<string, string>();
  directories = new Set<string>();
  modes = new Map<string, number>();
  writes: string[] = [];
  removals: string[] = [];
  commands: HostCommandRequest[] = [];
  /** What `runCommand` answers, by the program name; a program with no entry answers "not installed". */
  commandResults = new Map<string, (request: HostCommandRequest) => HostCommandResult>();

  readonly api: NonNullable<SshCliPlace['files']> = {
    readFile: async (hostPath) => (this.files.has(hostPath) ? { exists: true, content: this.files.get(hostPath) ?? null } : { exists: false, content: null }),
    writeFiles: async (files: HostFileWrite[]) => {
      const conflicts: string[] = [];
      let written = 0;
      for (const file of files) {
        // The helper's last look before it swaps a file in.
        if (file.expect !== undefined && (this.files.get(file.path) ?? null) !== file.expect) {
          conflicts.push(file.path);
          continue;
        }
        this.files.set(file.path, file.content);
        if (file.mode !== undefined) this.modes.set(file.path, file.mode);
        this.writes.push(file.path);
        written += 1;
      }
      return conflicts.length > 0 ? { written, conflicts } : { written };
    },
    removeFiles: async (paths) => {
      for (const target of paths) {
        this.files.delete(target);
        this.removals.push(target);
      }
      return { removed: paths.length };
    },
    pathPresence: async (paths) => paths.map((target) => (this.directories.has(target) || this.files.has(target) ? 'present' : 'absent')),
    jsonPatch: async () => ({ applied: true, changed: false }),
    runCommand: async (request) => {
      this.commands.push(request);
      const answer = this.commandResults.get(request.file);
      if (!answer) return { code: null, stdout: '', stderr: '', timedOut: false, error: `${request.file}: command not found` };
      return answer(request);
    },
  };
}

export interface FakeSshWorkspace {
  host: FakeSshHost;
  place: SshCliPlace;
  /** This computer's shell folder for the project (the working directory of a remote spawn). */
  projectFolder: string;
  /** This computer's mirror of the host's home: where an adapter's `cliHomeDir(place)` points. */
  mirrorHome: string;
  /** The project's folder on the host. */
  hostProject: string;
  /** The host's home. */
  hostHome: string;
  dispose(): Promise<void>;
}

/** A host with home `/home/dev` and a project at `/home/dev/app`, mirrored under a temp folder. */
export async function makeFakeSshWorkspace(options: { hostHome?: string; hostProject?: string } = {}): Promise<FakeSshWorkspace> {
  // The sync remembers what it last saw on a host, by host id and path, across the whole process.
  // Each workspace is a new host, so a test never inherits another's.
  resetHostFileSyncState();
  const hostHome = options.hostHome ?? '/home/dev';
  const hostProject = options.hostProject ?? `${hostHome}/app`;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kangentic-fake-host-'));
  const projectFolder = path.join(workspace, 'shell');
  const mirrorHome = path.join(workspace, 'mirror');
  await fs.mkdir(projectFolder, { recursive: true });
  await fs.mkdir(mirrorHome, { recursive: true });
  const host = new FakeSshHost();
  const place: SshCliPlace = {
    kind: 'ssh',
    hostId: 'host-1',
    home: hostHome,
    shellName: 'bash',
    localHome: mirrorHome,
    roots: [{ local: projectFolder, host: hostProject }],
    files: host.api,
  };
  return {
    host,
    place,
    projectFolder,
    mirrorHome,
    hostProject,
    hostHome,
    dispose: () => fs.rm(workspace, { recursive: true, force: true }),
  };
}
