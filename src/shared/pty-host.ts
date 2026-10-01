/**
 * The exit code a PTY is reported with when the pty host process died under
 * it (see `src/main/pty/host/`). Non-zero, so startup recovery and the crash
 * path treat the session as interrupted; a value no OS uses, so a log tells it
 * apart from a real kill. Shared because the renderer and the desktop notifier
 * fold every exit carrying it into one notice: a host crash ends every
 * terminal at once, and the agents among them resume a moment later.
 */
export const PTY_HOST_LOST_EXIT_CODE = -2;

/** Lost-session exits closer together than this belong to one host crash. */
export const PTY_HOST_LOST_NOTICE_WINDOW_MS = 5_000;
