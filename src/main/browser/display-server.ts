import { app } from 'electron';

/**
 * Which display server Chromium drew to, for the report a screenshot that timed
 * out sends (DESKTOP-46). Two 0.61.0 events came from one Debian install on a
 * parked pane, and nothing in them said whether it ran X11 or Wayland, where a
 * window's visible and minimized state read differently: Electron documents that
 * "minimized" is not a supported state on Wayland, so a minimized app there reads
 * as `host_window: visible`.
 *
 * It reads Electron's own `--ozone-platform` switch, which names the backend
 * Chromium chose, and never an env value. With no switch passed, Chromium writes
 * its choice back. Measured on Electron 45 on CI, it read `x11` under xvfb and
 * `wayland` under Weston. It returns `other` off Linux and for anything that is
 * neither, such as `headless`.
 */
export type DisplayServer = 'x11' | 'wayland' | 'other';

export function readDisplayServer(): DisplayServer {
  if (process.platform !== 'linux') return 'other';
  const platform = app.commandLine.getSwitchValue('ozone-platform');
  if (platform === 'x11' || platform === 'wayland') return platform;
  return 'other';
}
