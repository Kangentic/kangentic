import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';

let devIpcRegistered = false;

/**
 * Register the dev-only IPC behind the TestHarness "Simulate Low Memory"
 * toggle. `onToggle` reads every host memory sample as low memory while on,
 * so the low-memory pause can be watched in a preview. Idempotent.
 */
export function registerSimulateLowMemoryDevIpc(onToggle: (on: boolean) => void): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(IPC.DEV_SIMULATE_LOW_MEMORY, (_event, on: boolean): void => {
    onToggle(on === true);
  });
}
