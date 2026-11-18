import { UserConfigurationError } from './user-configuration-error';

/**
 * A request main turns down on purpose, or cannot do because of the user's own
 * setup: a task in the wrong column, a project that is not open, a branch that is
 * not this task's, a host that is not reachable. The caller is told why, and the
 * renderer often matches the text exactly, so a refusal keeps its message as
 * written. It is not a defect, so it never reaches Sentry: it extends
 * `UserConfigurationError`, which `reportHandledError` and every chokepoint skip.
 *
 * The name ends in `Error` so the renderer's `describeIpcError` strips it from the
 * text Electron hands back, exactly as it strips a bare `Error: `.
 *
 * Throw this, never a plain `Error`, for a deliberate refusal. A plain `Error`
 * reaching the IPC wrap (`ipc-handler-report.ts`) is read as a defect.
 */
export class RefusalError extends UserConfigurationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'RefusalError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/** The class name Electron keeps in front of a `SignInRefusedError`'s message when it crosses IPC. */
export const SIGN_IN_REFUSED_ERROR_NAME = 'SignInRefusedError';

/**
 * A refusal whose cause is the saved sign-in: the provider turned the token down,
 * or the token lacks what the request needs. The message is still the line the
 * user reads. The class is what the renderer acts on: Add Source reads the name
 * Electron leaves in the rejection (`ipcErrorClassName`) and opens the provider's
 * Connect dialog, because a sign-in that is saved and refused has no other way to
 * be replaced from there. Text cannot carry this, since a provider's own wording
 * of a refusal varies.
 */
export class SignInRefusedError extends RefusalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = SIGN_IN_REFUSED_ERROR_NAME;
  }
}
