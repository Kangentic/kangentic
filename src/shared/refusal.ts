import { UserConfigurationError } from './user-configuration-error';

/**
 * A request main turns down on purpose: a task in the wrong column, a project
 * that is not open, a branch that is not this task's. The caller is told why, and
 * the text is often matched exactly by the renderer, so a refusal keeps its message
 * unchanged. It is not a defect, so it never reaches Sentry: it extends
 * `UserConfigurationError`, which `reportHandledError` and every chokepoint skip.
 *
 * Throw this, never a plain `Error`, for a deliberate refusal. A plain `Error` from
 * an IPC handler is read as a defect.
 */
export class Refusal extends UserConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}
