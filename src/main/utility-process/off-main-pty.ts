/**
 * `spawnOffMainPty`: a short-lived PTY for a probe that has to drive a CLI's
 * TUI (the Claude model picker, the Antigravity print runner), spawned in the
 * pty host when one is registered. ConPTY creation is synchronous on the
 * calling thread, and a PTY's exit callback that lands after Node stops is the
 * crash the quit drain exists for (Sentry DESKTOP-C), so main keeps neither.
 *
 * With no spawner registered (unit tests, startup before the host exists) or
 * when the host cannot be reached, node-pty runs here, loaded lazily so
 * importing a probe never loads the native binding.
 */

export interface OffMainPtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface OffMainPtyDisposable {
  dispose(): void;
}

/** The part of node-pty's `IPty` the probes use. */
export interface OffMainPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): OffMainPtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): OffMainPtyDisposable;
}

/** Spawns in the pty host. Rejects with `HostUnavailableError` when the host
 *  cannot be reached; a spawn that fails there rejects with that error. */
export type OffMainPtySpawner = (file: string, args: string[], options: OffMainPtyOptions) => Promise<OffMainPty>;

/** The host could not be asked: fall back to a local spawn. */
export class HostUnavailableError extends Error {}

let spawner: OffMainPtySpawner | null = null;

export function setOffMainPtySpawner(next: OffMainPtySpawner | null): void {
  spawner = next;
}

export async function spawnOffMainPty(file: string, args: string[], options: OffMainPtyOptions): Promise<OffMainPty> {
  const spawnInHost = spawner;
  if (spawnInHost) {
    try {
      return await spawnInHost(file, args, options);
    } catch (error) {
      if (!(error instanceof HostUnavailableError)) throw error;
    }
  }
  const nodePty = await import('node-pty');
  return nodePty.spawn(file, args, options);
}
