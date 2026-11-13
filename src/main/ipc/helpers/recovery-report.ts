import { createChokepointReporter } from '../../analytics/handled-report';

/**
 * The project recovery passes in `handlers/projects.ts` and `register-all.ts`. A
 * single record that fails to resume or spawn already reports
 * (`resume-suspended.ts`, `auto-spawn.ts`); a pass that throws means nothing on
 * that board resumes, and before this it only logged.
 */
export type RecoveryPass =
  | 'resource_cleanup'
  | 'session_recovery'
  | 'session_reconcile'
  | 'host_connected'
  | 'cold_open'
  | 'deferred_board_config'
  | 'pty_host_loss'
  | 'activate_project'
  | 'remote_projects';

const recoveryReporter = createChokepointReporter('project_recovery');

/** Report a whole recovery pass that threw, tagged by `pass`, once per pass and error class per run. */
export function reportRecoveryPassFailure(pass: RecoveryPass, error: unknown): void {
  recoveryReporter.report(error, { tags: { pass } });
}

/** Test-only: forget the latch. */
export function resetRecoveryPassReports(): void {
  recoveryReporter.reset();
}
