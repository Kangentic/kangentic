import { create } from 'zustand';
import { useProjectStore } from './project-store';
import { describeIpcError } from '../lib/ipc-error';
import type { SshClientStatus, SshConfigHost, SshDirectoryListing, SshHostAddInput, SshHostKeyProbe, SshHostProgram, SshHostStatus, SshHostUpdateInput, SshRemoteFolderProbe } from '../../shared/types';

/**
 * Identifies the newest in-flight listHosts() so an older reply cannot clobber a newer one. A host's
 * state changes arrive as pushes while an add or a reconnect is still awaiting its own reload, so
 * overlapping fetches are routine. Preserved across HMR (Pattern A) so the counter stays monotonic.
 */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let latestHostsRequestId: number = import.meta.hot?.data?.latestHostsRequestId ?? 0;

/** Which step of Add project is open: nothing, the This computer / host chooser, or a host's folder form. */
export type AddProjectDialogState =
  | { kind: 'closed' }
  | { kind: 'chooser' }
  | { kind: 'remote'; hostId: string };

interface SshStore {
  /** Transient UI state: which step of Add project is showing. */
  addProjectDialog: AddProjectDialogState;
  openAddProjectChooser: () => void;
  openAddRemoteProject: (hostId: string) => void;
  closeAddProjectDialog: () => void;

  hosts: SshHostStatus[];
  /** False until the first list arrives, so a surface can tell "no hosts" from "not asked yet". */
  hostsLoaded: boolean;
  /** Why the last list could not be read, or null. */
  hostsError: string | null;
  client: SshClientStatus | null;

  loadHosts: () => Promise<void>;
  loadClient: () => Promise<void>;
  probeHostKey: (destination: string) => Promise<SshHostKeyProbe>;
  /** The named hosts in this computer's SSH config, for the address field's suggestions. */
  listConfigHosts: () => Promise<SshConfigHost[]>;
  addHost: (input: SshHostAddInput) => Promise<SshHostStatus>;
  removeHost: (hostId: string) => Promise<void>;
  /** Delete Kangentic's data for the host's projects. The host stays. */
  clearHostData: (hostId: string) => Promise<void>;
  /** Save a host's name, address or sign-in. Rejects with the reason and keeps what the host had. */
  updateHost: (hostId: string, input: SshHostUpdateInput) => Promise<SshHostStatus>;
  reconnectHost: (hostId: string) => Promise<void>;
  /** Whether a key file the user chose can be used. Rejects with the reason, such as a passphrase. */
  checkKeyFile: (keyFilePath: string) => Promise<void>;
  /** The key a host whose key changed presents now, with the fingerprint trusted before when known. Trusts nothing. */
  probeChangedKey: (hostId: string) => Promise<SshHostKeyProbe>;
  /** Trust the key the user was shown, replacing the old one, and connect. */
  trustNewKey: (hostId: string, shownFingerprint: string) => Promise<void>;
  /** What the program on a connected host reports. Rejects with the reason while the host cannot answer. */
  hostProgram: (hostId: string) => Promise<SshHostProgram>;
  probeRemoteFolder: (hostId: string, folderPath: string) => Promise<SshRemoteFolderProbe>;
  /** The folders directly inside a directory on a host. A directory that is not there reads as `exists: false`; a host that cannot answer rejects. */
  listDirectories: (hostId: string, directoryPath: string) => Promise<SshDirectoryListing>;
}

/**
 * Backs the SSH settings tab and the Add project chooser (#913). Machine-global, not project-scoped:
 * a host serves every project, and must be addable with no project open. Main pushes a change whenever
 * a host's connection state moves; `useSshHostsSync` turns each push into `loadHosts`.
 *
 * The two loads never reject: a failure is state the tab shows. So a mutation that succeeded in main
 * is never reported as failed because the list after it could not be read.
 */
const createSshStore = () => create<SshStore>((set, get) => ({
  addProjectDialog: { kind: 'closed' },
  openAddProjectChooser: () => set({ addProjectDialog: { kind: 'chooser' } }),
  openAddRemoteProject: (hostId) => set({ addProjectDialog: { kind: 'remote', hostId } }),
  closeAddProjectDialog: () => set({ addProjectDialog: { kind: 'closed' } }),

  hosts: [],
  hostsLoaded: false,
  hostsError: null,
  client: null,

  loadHosts: async () => {
    latestHostsRequestId += 1;
    const requestId = latestHostsRequestId;
    try {
      const hosts = await window.electronAPI.ssh.listHosts();
      // A newer fetch was issued while this one was in flight; its reply is the current truth.
      if (requestId !== latestHostsRequestId) return;
      set({ hosts, hostsLoaded: true, hostsError: null });
    } catch (error) {
      if (requestId !== latestHostsRequestId) return;
      set({ hostsError: describeIpcError(error) });
    }
  },

  loadClient: async () => {
    try {
      set({ client: await window.electronAPI.ssh.detectClient() });
    } catch (error) {
      set({ client: { found: false, version: null, error: describeIpcError(error) } });
    }
  },

  probeHostKey: (destination) => window.electronAPI.ssh.probeHostKey(destination),

  listConfigHosts: () => window.electronAPI.ssh.listConfigHosts(),

  addHost: async (input) => {
    const status = await window.electronAPI.ssh.addHost(input);
    // The same address as a removed host brings its hidden projects back, so the sidebar must hear.
    await Promise.all([get().loadHosts(), useProjectStore.getState().loadProjects()]);
    return status;
  },

  removeHost: async (hostId) => {
    await window.electronAPI.ssh.removeHost(hostId);
    // Main hid the host's projects, so the sidebar and an open board must hear.
    await Promise.all([
      get().loadHosts(),
      useProjectStore.getState().loadProjects(),
      useProjectStore.getState().loadCurrent(),
    ]);
  },

  clearHostData: async (hostId) => {
    await window.electronAPI.ssh.clearHostData(hostId);
    // The host stays, with no projects: its count and the sidebar change, and an open board may be gone.
    await Promise.all([
      get().loadHosts(),
      useProjectStore.getState().loadProjects(),
      useProjectStore.getState().loadCurrent(),
    ]);
  },

  updateHost: async (hostId, input) => {
    const status = await window.electronAPI.ssh.updateHost(hostId, input);
    await get().loadHosts();
    return status;
  },

  reconnectHost: async (hostId) => {
    await window.electronAPI.ssh.reconnectHost(hostId);
    await get().loadHosts();
  },

  checkKeyFile: (keyFilePath) => window.electronAPI.ssh.checkKeyFile(keyFilePath),

  probeChangedKey: (hostId) => window.electronAPI.ssh.probeChangedKey(hostId),

  trustNewKey: async (hostId, shownFingerprint) => {
    await window.electronAPI.ssh.trustNewKey(hostId, shownFingerprint);
    await get().loadHosts();
  },

  hostProgram: (hostId) => window.electronAPI.ssh.hostProgram(hostId),

  probeRemoteFolder: (hostId, folderPath) => window.electronAPI.ssh.probeRemoteFolder(hostId, folderPath),

  listDirectories: (hostId, directoryPath) => window.electronAPI.ssh.listDirectories(hostId, directoryPath),
}));

// Pattern E: this module's only runtime export is a hook, so it is not a Fast Refresh boundary. A re-eval
// would hand a second store to part of the tree, and a host's state would land where no one is reading.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedSshStore: ReturnType<typeof createSshStore> | undefined = import.meta.hot?.data?.sshStore;
export const useSshStore = preservedSshStore ?? createSshStore();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.sshStore = useSshStore;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.latestHostsRequestId = latestHostsRequestId;
  });
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
