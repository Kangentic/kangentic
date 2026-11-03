import { create } from 'zustand';
import type { SshClientStatus, SshHostAddInput, SshHostKeyProbe, SshHostStatus, SshRemoteFolderProbe } from '../../shared/types';

/**
 * Identifies the newest in-flight listHosts() so an older reply cannot clobber a newer one. A host's
 * state changes arrive as pushes while an add or a reconnect is still awaiting its own reload, so
 * overlapping fetches are routine. Preserved across HMR (Pattern A) so the counter stays monotonic.
 */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let latestHostsRequestId: number = import.meta.hot?.data?.latestHostsRequestId ?? 0;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.latestHostsRequestId = latestHostsRequestId;
  });
}

/**
 * Backs the SSH settings tab and the Add project chooser (#913). Machine-global, not project-scoped:
 * a host serves every project, and must be addable with no project open. Main pushes a change whenever
 * a host's connection state moves; `useSshHostsSync` turns each push into `loadHosts`.
 */
/** Which step of Add project is open: nothing, the This computer / host chooser, or a host's folder form. */
export type AddProjectDialogState =
  | { kind: 'closed' }
  | { kind: 'chooser' }
  | { kind: 'remote'; hostId: string };

interface SshStore {
  addProjectDialog: AddProjectDialogState;
  openAddProjectChooser: () => void;
  openAddRemoteProject: (hostId: string) => void;
  closeAddProjectDialog: () => void;

  hosts: SshHostStatus[];
  /** False until the first list arrives, so a surface can tell "no hosts" from "not asked yet". */
  hostsLoaded: boolean;
  client: SshClientStatus | null;

  loadHosts: () => Promise<void>;
  loadClient: () => Promise<void>;
  probeHostKey: (destination: string) => Promise<SshHostKeyProbe>;
  addHost: (input: SshHostAddInput) => Promise<SshHostStatus>;
  removeHost: (hostId: string) => Promise<void>;
  renameHost: (hostId: string, name: string) => Promise<void>;
  reconnectHost: (hostId: string) => Promise<void>;
  forgetHostKey: (hostId: string) => Promise<void>;
  probeRemoteFolder: (hostId: string, folderPath: string) => Promise<SshRemoteFolderProbe>;
}

export const useSshStore = create<SshStore>((set, get) => ({
  addProjectDialog: { kind: 'closed' },
  openAddProjectChooser: () => set({ addProjectDialog: { kind: 'chooser' } }),
  openAddRemoteProject: (hostId) => set({ addProjectDialog: { kind: 'remote', hostId } }),
  closeAddProjectDialog: () => set({ addProjectDialog: { kind: 'closed' } }),

  hosts: [],
  hostsLoaded: false,
  client: null,

  loadHosts: async () => {
    latestHostsRequestId += 1;
    const requestId = latestHostsRequestId;
    const hosts = await window.electronAPI.ssh.listHosts();
    // A newer fetch was issued while this one was in flight; its reply is the current truth.
    if (requestId !== latestHostsRequestId) return;
    set({ hosts, hostsLoaded: true });
  },

  loadClient: async () => {
    const client = await window.electronAPI.ssh.detectClient();
    set({ client });
  },

  probeHostKey: (destination) => window.electronAPI.ssh.probeHostKey(destination),

  addHost: async (input) => {
    const status = await window.electronAPI.ssh.addHost(input);
    await get().loadHosts();
    return status;
  },

  removeHost: async (hostId) => {
    await window.electronAPI.ssh.removeHost(hostId);
    await get().loadHosts();
  },

  renameHost: async (hostId, name) => {
    await window.electronAPI.ssh.renameHost(hostId, name);
    await get().loadHosts();
  },

  reconnectHost: async (hostId) => {
    await window.electronAPI.ssh.reconnectHost(hostId);
    await get().loadHosts();
  },

  forgetHostKey: async (hostId) => {
    await window.electronAPI.ssh.forgetHostKey(hostId);
  },

  probeRemoteFolder: (hostId, folderPath) => window.electronAPI.ssh.probeRemoteFolder(hostId, folderPath),
}));
